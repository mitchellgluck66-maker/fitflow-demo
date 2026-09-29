/**
 * Credentials at rest (H4, 2026-09-29 audit) — server only.
 *
 * Every settings row flagged `is_secret` (GHL / Meta / Stripe / Anthropic /
 * Google Ads keys) is stored AES-256-GCM encrypted:
 *
 *   enc:v1:<iv base64url>:<auth tag base64url>:<ciphertext base64url>
 *
 * The 32-byte key comes ONLY from env `CREDENTIALS_KEY` (base64 or hex; make
 * one with `openssl rand -base64 32`) — never from the database, so a leaked
 * table dump holds nothing usable. Decryption happens server-side, at call
 * time, inside lib/settings#getSetting; masked previews are computed from the
 * decrypted value exactly as before and nothing decrypted ever leaves the
 * server.
 *
 * Production / preview WITHOUT a valid key fails CLOSED: secrets cannot be
 * saved and stored ones read as absent (the integration shows "not
 * configured"), and Setup explains why. Local dev without a key stores and
 * reads plaintext, as before.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isProductionLike } from '../auth/policy';

export const ENC_PREFIX = 'enc:v1:';

export type KeyStatus =
  | { mode: 'on'; key: Buffer }
  /** Local dev, no key: plaintext storage (never in production / preview). */
  | { mode: 'dev-plaintext' }
  | { mode: 'missing' }
  | { mode: 'invalid'; error: string };

export class CredentialsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsKeyError';
  }
}

/** 32 raw bytes from base64 / base64url / hex. Anything else is rejected — no silent key stretching. */
export function parseKey(raw: string): Buffer {
  const v = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length !== 32) throw new CredentialsKeyError(`CREDENTIALS_KEY must decode to 32 bytes (got ${buf.length}) — generate one with: openssl rand -base64 32`);
  return buf;
}

export function keyStatus(env: Record<string, string | undefined> = process.env): KeyStatus {
  const raw = env.CREDENTIALS_KEY?.trim();
  if (!raw) return isProductionLike(env) ? { mode: 'missing' } : { mode: 'dev-plaintext' };
  try {
    return { mode: 'on', key: parseKey(raw) };
  } catch (e) {
    return { mode: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }
}

/** One sentence for Setup / API responses. Never includes key material. */
export function keyStatusMessage(s: KeyStatus): string {
  switch (s.mode) {
    case 'on':
      return 'Stored credentials are encrypted at rest (AES-256-GCM, key from CREDENTIALS_KEY).';
    case 'dev-plaintext':
      return 'Local development: CREDENTIALS_KEY is not set, so credentials are stored unencrypted on this machine.';
    case 'missing':
      return 'CREDENTIALS_KEY is not set. Stored credentials are locked and new ones cannot be saved. Add a 32-byte key (openssl rand -base64 32) in Vercel → Settings → Environment Variables and redeploy.';
    case 'invalid':
      return `${s.error}. Stored credentials are locked until it is fixed.`;
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

const b64 = (b: Buffer) => b.toString('base64url');

export function encryptValue(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${ENC_PREFIX}${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
}

/** Throws on a wrong key or a tampered value (GCM authentication). */
export function decryptValue(stored: string, key: Buffer): string {
  if (!isEncrypted(stored)) throw new CredentialsKeyError('not an encrypted value');
  const [iv, tag, ct] = stored.slice(ENC_PREFIX.length).split(':');
  if (!iv || !tag || ct === undefined) throw new CredentialsKeyError('malformed encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** What to WRITE for a secret. '' (disconnect) stays ''. Throws (fail closed) without a usable key in production. */
export function sealSecret(plain: string, status: KeyStatus = keyStatus()): string {
  if (plain === '') return '';
  if (status.mode === 'on') return encryptValue(plain, status.key);
  if (status.mode === 'dev-plaintext') return plain;
  throw new CredentialsKeyError(keyStatusMessage(status));
}

/**
 * What a stored secret READS as. Encrypted → decrypted with the key (null if
 * the key is missing / wrong). Legacy plaintext → returned only where
 * plaintext is allowed (local dev) or while a valid key exists (the next
 * `npm run db:migrate` / `credentials:encrypt` seals it); in production
 * without a key, null — fail closed.
 */
export function openSecret(stored: string | null, status: KeyStatus = keyStatus()): string | null {
  if (stored === null || stored === '') return stored;
  if (isEncrypted(stored)) {
    if (status.mode !== 'on') return null;
    try {
      return decryptValue(stored, status.key);
    } catch {
      return null;
    }
  }
  return status.mode === 'on' || status.mode === 'dev-plaintext' ? stored : null;
}
