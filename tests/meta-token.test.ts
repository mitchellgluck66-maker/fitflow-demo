/**
 * H2 — Meta token self-check: debug_token → stored status → 7-day warning
 * incident, against a mocked Graph API and in-memory PGlite.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, syncIncidents } from '@/db';
import { setSetting, getSetting } from '@/lib/settings';
import { META_KEYS } from '@/lib/meta/config';
import { MetaDebugTokenSchema } from '@/lib/meta/schemas';
import {
  assessMetaToken,
  runMetaTokenCheck,
  statusFromDebugToken,
  META_TOKEN_INCIDENT_KIND,
  META_TOKEN_STATUS_KEY,
  type MetaTokenStatus,
} from '@/lib/meta/token';
import { outcomeReason } from '@/lib/dispatch';

const TZ = 'America/Edmonton';
const TOKEN = 'EAAG-token-under-test-5678';
const NOW = new Date('2026-10-25T15:00:00Z');
const unix = (isoStr: string) => Math.floor(Date.parse(isoStr) / 1000);
const OCT31 = unix('2026-10-31T06:00:00Z'); // Oct 31 00:00 in Edmonton (MDT)

const status = (over: Partial<MetaTokenStatus> = {}): MetaTokenStatus => ({
  checkedAt: NOW.toISOString(),
  valid: true,
  expiresAt: null,
  dataAccessExpiresAt: null,
  type: 'USER',
  scopes: ['ads_read'],
  error: null,
  ...over,
});

describe('assessMetaToken (pure)', () => {
  const at = NOW.getTime();
  it('never-expiring system-user token → ok', () => {
    expect(assessMetaToken(status(), at, TZ)).toMatchObject({ level: 'ok', daysLeft: null, message: 'Meta token never expires' });
  });
  it('more than 7 days out → ok, with the date', () => {
    expect(assessMetaToken(status({ expiresAt: '2026-12-01T07:00:00Z' }), at, TZ)).toMatchObject({ level: 'ok', daysLeft: 36, message: 'Meta token expires Dec 1, 2026 (36 days)' });
  });
  it('inside 7 days → warning with the exact incident wording', () => {
    expect(assessMetaToken(status({ expiresAt: new Date(OCT31 * 1000).toISOString() }), at, TZ)).toMatchObject({
      level: 'warning',
      daysLeft: 5,
      which: 'token',
      message: 'Meta token expires Oct 31, 2026 — regenerate in Business Settings',
    });
  });
  it('the data-access window counts when it is the earlier clock', () => {
    const a = assessMetaToken(status({ expiresAt: '2027-01-01T07:00:00Z', dataAccessExpiresAt: '2026-10-28T06:00:00Z' }), at, TZ);
    expect(a).toMatchObject({ level: 'warning', which: 'data_access', message: 'Meta data access expires Oct 28, 2026 — regenerate in Business Settings' });
  });
  it('expired and invalid are critical-level', () => {
    expect(assessMetaToken(status({ expiresAt: '2026-10-20T06:00:00Z' }), at, TZ).level).toBe('expired');
    expect(assessMetaToken(status({ valid: false, error: 'Session has been invalidated' }), at, TZ)).toMatchObject({
      level: 'invalid',
      message: 'Meta says the token is invalid (Session has been invalidated) — regenerate in Business Settings',
    });
  });
  it('parses debug_token with 0 = never and numeric strings', () => {
    const parsed = MetaDebugTokenSchema.parse({ data: { is_valid: true, expires_at: 0, data_access_expires_at: String(OCT31), type: 'USER', scopes: ['ads_read'] } });
    expect(statusFromDebugToken(parsed, NOW)).toMatchObject({ valid: true, expiresAt: null, dataAccessExpiresAt: '2026-10-31T06:00:00.000Z' });
  });
});

describe('runMetaTokenCheck (mocked Graph API)', () => {
  let reply: Record<string, unknown> = {};
  const calls: string[] = [];
  const fakeFetch = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?input_token=${url.searchParams.get('input_token') ? 'set' : 'missing'}`);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const openIncidents = () => db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, META_TOKEN_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));

  beforeAll(async () => {
    await runMigrations();
    vi.stubGlobal('fetch', fakeFetch);
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    calls.length = 0;
  });

  it('not connected → notConfigured, no request, no incident', async () => {
    const r = await runMetaTokenCheck(NOW);
    expect(r).toMatchObject({ ok: false, notConfigured: true });
    expect(calls).toEqual([]);
  });

  it('5 days from expiry: one GET to /debug_token, status stored, ONE warning incident with the exact message', async () => {
    await setSetting('timezone', TZ);
    await setSetting(META_KEYS.token, TOKEN, { secret: true });
    await setSetting(META_KEYS.adAccountId, 'act_123');
    reply = { data: { is_valid: true, expires_at: OCT31, data_access_expires_at: 0, type: 'USER', scopes: ['ads_read'] } };
    const r = await runMetaTokenCheck(NOW);
    expect(calls).toEqual([expect.stringMatching(/\/debug_token\?input_token=set$/)]);
    expect(r).toMatchObject({ ok: true, reason: 'Meta token expires Oct 31, 2026 — regenerate in Business Settings' });
    expect(JSON.parse((await getSetting(META_TOKEN_STATUS_KEY))!)).toMatchObject({ valid: true, expiresAt: '2026-10-31T06:00:00.000Z' });
    const open = await openIncidents();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: 'warning', message: 'Meta token expires Oct 31, 2026 — regenerate in Business Settings' });
    expect(JSON.stringify(open[0])).not.toContain(TOKEN);
    // The dispatch row records the assessment as its reason.
    expect(outcomeReason({ status: 'succeeded', durationMs: 5, result: r })).toBe('Meta token expires Oct 31, 2026 — regenerate in Business Settings');
  });

  it('checking again the next night keeps ONE open incident', async () => {
    await runMetaTokenCheck(new Date('2026-10-26T15:00:00Z'));
    expect(await openIncidents()).toHaveLength(1);
  });

  it('after expiry: critical, and the step fails so the dispatch row says so', async () => {
    reply = { data: { is_valid: false, expires_at: OCT31, type: 'USER', error: { code: 190, message: 'Error validating access token: Session has expired' } } };
    const r = await runMetaTokenCheck(new Date('2026-11-02T15:00:00Z'));
    expect(r.ok).toBe(false);
    const open = await openIncidents();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: 'critical', message: 'Meta token expired Oct 31, 2026 — regenerate in Business Settings; Meta spend has stopped syncing' });
  });

  it('a regenerated never-expiring token resolves the incident', async () => {
    reply = { data: { is_valid: true, expires_at: 0, data_access_expires_at: 0, type: 'SYSTEM_USER' } };
    const r = await runMetaTokenCheck(new Date('2026-11-03T15:00:00Z'));
    expect(r).toMatchObject({ ok: true, reason: 'Meta token never expires' });
    expect(await openIncidents()).toHaveLength(0);
  });
});
