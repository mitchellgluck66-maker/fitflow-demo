/**
 * H4 — credentials encrypted at rest (AES-256-GCM, key from env CREDENTIALS_KEY).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, settings } from '@/db';
import { getSetting, setSetting, encryptPlaintextSecrets } from '@/lib/settings';
import { getMetaConfig, maskToken, META_KEYS } from '@/lib/meta/config';
import {
  CredentialsKeyError,
  ENC_PREFIX,
  decryptValue,
  encryptValue,
  keyStatus,
  keyStatusMessage,
  openSecret,
  parseKey,
  sealSecret,
} from '@/lib/crypto/credentials';
import { POST as saveMeta } from '@/app/api/meta/credentials/route';
import { NextRequest } from 'next/server';

const KEY_B64 = randomBytes(32).toString('base64');
const KEY = parseKey(KEY_B64);
const TOKEN = 'EAAB-super-secret-meta-token-9f3a';

const rawValue = async (key: string) => (await db.select().from(settings).where(eq(settings.key, key)))[0]?.value ?? null;

beforeAll(async () => {
  await runMigrations();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('lib/crypto/credentials (pure)', () => {
  it('accepts exactly 32 bytes as base64 or hex, rejects anything else', () => {
    expect(parseKey(KEY_B64)).toHaveLength(32);
    expect(parseKey(randomBytes(32).toString('hex'))).toHaveLength(32);
    expect(() => parseKey('too-short')).toThrow(CredentialsKeyError);
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('round-trips, uses a fresh IV per seal, and detects tampering / the wrong key', () => {
    const a = encryptValue(TOKEN, KEY);
    const b = encryptValue(TOKEN, KEY);
    expect(a.startsWith(ENC_PREFIX)).toBe(true);
    expect(a).not.toContain(TOKEN);
    expect(a).not.toBe(b);
    expect(decryptValue(a, KEY)).toBe(TOKEN);
    const tampered = a.slice(0, -2) + (a.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptValue(tampered, KEY)).toThrow();
    expect(() => decryptValue(a, parseKey(randomBytes(32).toString('base64')))).toThrow();
  });

  it('key status: on / dev plaintext / missing (production + preview) / invalid', () => {
    expect(keyStatus({ CREDENTIALS_KEY: KEY_B64 }).mode).toBe('on');
    expect(keyStatus({ NODE_ENV: 'development' }).mode).toBe('dev-plaintext');
    expect(keyStatus({ NODE_ENV: 'production' }).mode).toBe('missing');
    expect(keyStatus({ VERCEL_ENV: 'preview' }).mode).toBe('missing');
    expect(keyStatus({ VERCEL_ENV: 'production', CREDENTIALS_KEY: 'nope' }).mode).toBe('invalid');
    expect(keyStatusMessage(keyStatus({ VERCEL_ENV: 'production' }))).toMatch(/CREDENTIALS_KEY is not set/);
  });

  it('fails closed without a key in production: cannot seal, cannot open (encrypted OR legacy plaintext)', () => {
    const missing = keyStatus({ VERCEL_ENV: 'production' });
    expect(() => sealSecret(TOKEN, missing)).toThrow(CredentialsKeyError);
    expect(sealSecret('', missing)).toBe(''); // disconnecting still works
    expect(openSecret(encryptValue(TOKEN, KEY), missing)).toBeNull();
    expect(openSecret(TOKEN, missing)).toBeNull();
    // Local dev: plaintext as before.
    const dev = keyStatus({ NODE_ENV: 'development' });
    expect(sealSecret(TOKEN, dev)).toBe(TOKEN);
    expect(openSecret(TOKEN, dev)).toBe(TOKEN);
  });
});

describe('settings: sealed at rest, opened only server-side at call time', () => {
  it('stores ciphertext, reads plaintext, masked preview unchanged', async () => {
    vi.stubEnv('CREDENTIALS_KEY', KEY_B64);
    await setSetting(META_KEYS.token, TOKEN, { secret: true });
    const stored = await rawValue(META_KEYS.token);
    expect(stored?.startsWith(ENC_PREFIX)).toBe(true);
    expect(stored).not.toContain(TOKEN);
    expect(await getSetting(META_KEYS.token)).toBe(TOKEN);
    const config = await getMetaConfig();
    expect(config.token).toBe(TOKEN);
    expect(maskToken(config.token)).toBe('••••••9f3a');
  });

  it('non-secret settings are untouched', async () => {
    vi.stubEnv('CREDENTIALS_KEY', KEY_B64);
    await setSetting(META_KEYS.adAccountId, 'act_123');
    expect(await rawValue(META_KEYS.adAccountId)).toBe('act_123');
  });

  it('production without the key: stored credentials read as absent and saving is refused with the Setup message', async () => {
    vi.stubEnv('CREDENTIALS_KEY', '');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(await getSetting(META_KEYS.token)).toBeNull();
    expect((await getMetaConfig()).configured).toBe(false);
    await expect(setSetting(META_KEYS.token, 'new-token', { secret: true })).rejects.toThrow(CredentialsKeyError);
    const res = await saveMeta(new NextRequest('http://localhost/api/meta/credentials', { method: 'POST', body: JSON.stringify({ token: 'new-token' }) }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.locked).toBe(true);
    expect(body.error).toMatch(/CREDENTIALS_KEY is not set/);
    expect(JSON.stringify(body)).not.toContain('new-token');
  });

  it('the migration step seals legacy plaintext rows, idempotently', async () => {
    // A row saved before H4 (plaintext, flagged secret).
    await db.insert(settings).values({ key: 'stripe_secret_key', value: 'rk_live_legacy_plain', isSecret: true }).onConflictDoUpdate({ target: settings.key, set: { value: 'rk_live_legacy_plain', isSecret: true } });
    vi.stubEnv('CREDENTIALS_KEY', KEY_B64);
    await runMigrations(); // db:migrate runs the sealing step after the SQL migrations
    const sealed = await rawValue('stripe_secret_key');
    expect(sealed?.startsWith(ENC_PREFIX)).toBe(true);
    expect(await getSetting('stripe_secret_key')).toBe('rk_live_legacy_plain');
    expect(await encryptPlaintextSecrets()).toEqual({ sealed: 0, skipped: null });
    expect(await rawValue('stripe_secret_key')).toBe(sealed);
  });

  it('without a key (local dev) the migration step is a no-op', async () => {
    vi.stubEnv('CREDENTIALS_KEY', '');
    expect(await encryptPlaintextSecrets()).toEqual({ sealed: 0, skipped: 'dev-plaintext' });
  });
});
