/**
 * Meta Ads integration against a mocked Graph API and in-memory PGlite.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, adSpend, syncRuns } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from '@/lib/settings';
import { META_KEYS, normalizeAdAccountId } from '@/lib/meta/config';
import { MetaInsightRowSchema, leadsFromActions } from '@/lib/meta/schemas';
import { runMetaSync, chunkWindows } from '@/lib/meta/ingest';
import { testConnection } from '@/lib/meta/client';

const TOKEN = 'EAAG-super-secret-token-1234';
/** Pin "today" (business tz America/New_York) so chunk windows are deterministic. */
const FAKE_NOW = '2026-08-12T16:00:00Z';

const page1 = {
  data: [
    {
      date_start: '2026-08-10',
      date_stop: '2026-08-10',
      campaign_id: 'c1',
      campaign_name: 'Summer Shred',
      adset_id: 's1',
      adset_name: 'Broad',
      ad_id: 'a1',
      ad_name: 'Video 1',
      spend: '12.34',
      impressions: '1000',
      clicks: '50',
      actions: [
        { action_type: 'lead', value: '3' },
        { action_type: 'link_click', value: '40' },
      ],
    },
    { date_start: '2026-08-10', date_stop: '2026-08-10', campaign_id: 'c1', campaign_name: 'Summer Shred', ad_id: 'a2', ad_name: 'Video 2', spend: '0.5', impressions: '10', clicks: '1' },
  ],
  paging: { cursors: { after: 'x' }, next: 'https://graph.facebook.com/v21.0/act_123/insights?after=x&access_token=' + TOKEN },
};
const page2 = {
  data: [{ date_start: '2026-08-11', date_stop: '2026-08-11', campaign_id: 'c2', campaign_name: 'Retarget', ad_id: 'a1', spend: '7', impressions: '5', clicks: '2', actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '1' }] }],
  paging: { cursors: {} },
};

const calls: string[] = [];
/** Windows (by their `since` date) the insights endpoint should 500 on. */
const failSince = new Set<string>();
/** The `since` of every insights window requested, in order. */
const requestedWindows: string[] = [];

const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  calls.push(url.toString());
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/v21.0/act_123') return json({ id: 'act_123', name: 'Fit Physician', currency: 'USD', account_status: 1 });
  if (url.pathname === '/v21.0/act_123/insights') {
    const range = JSON.parse(url.searchParams.get('time_range') ?? '{}') as { since?: string };
    if (!url.searchParams.get('after')) requestedWindows.push(range.since ?? '?');
    if (range.since && failSince.has(range.since)) {
      return json({ error: { message: 'unknown error', code: 1 } }, 500);
    }
    return url.searchParams.get('after') === 'x' ? json(page2) : json(page1);
  }
  if (url.pathname === '/v21.0/act_bad/insights') {
    return json({ error: { message: `Invalid request ${url.toString()}`, code: 100 } }, 400);
  }
  return json({ error: { message: 'not found' } }, 404);
});

beforeAll(async () => {
  vi.useFakeTimers({ now: new Date(FAKE_NOW), toFake: ['Date'] });
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  calls.length = 0;
  requestedWindows.length = 0;
  failSince.clear();
});

describe('config', () => {
  it('normalises the ad account id', () => {
    expect(normalizeAdAccountId('123')).toBe('act_123');
    expect(normalizeAdAccountId('act_123')).toBe('act_123');
    expect(normalizeAdAccountId('  ')).toBeNull();
  });
});

describe('schemas', () => {
  it('coerces numeric strings and sums lead actions only', () => {
    const row = MetaInsightRowSchema.parse(page1.data[0]);
    expect(row.spend).toBe(12.34);
    expect(row.impressions).toBe(1000);
    expect(leadsFromActions(row.actions)).toBe(3);
    expect(leadsFromActions(MetaInsightRowSchema.parse(page2.data[0]).actions)).toBe(1);
    expect(leadsFromActions(null)).toBe(0);
  });
});

describe('runMetaSync', () => {
  it('reports not configured without touching the network', async () => {
    const r = await runMetaSync({ mode: 'delta', trigger: 'cli' });
    expect(r.ok).toBe(false);
    expect(r.notConfigured).toBe(true);
    expect(calls).toHaveLength(0);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, r.runId));
    expect(run.status).toBe('failed');
  });

  it('verifies with one request once configured', async () => {
    await setSetting(META_KEYS.token, TOKEN, { secret: true });
    await setSetting(META_KEYS.adAccountId, '123');
    const t = await testConnection();
    expect(t.ok).toBe(true);
    expect(t.message).toContain('Fit Physician');
    expect(calls).toHaveLength(1);
  });

  it('follows paging, upserts ad×day rows in cents, and is idempotent', async () => {
    const r = await runMetaSync({ mode: 'backfill', trigger: 'cli', since: '2026-08-10' });
    expect(r.ok).toBe(true);
    expect(r.requestsUsed).toBe(2);
    expect(r.stats).toMatchObject({ rows: 3, days: 2, campaigns: 2, spendCents: 1234 + 50 + 700 });

    const rows = await db.select().from(adSpend).where(eq(adSpend.origin, 'meta'));
    expect(rows).toHaveLength(3);
    const a1 = rows.find((x) => x.externalId === 'meta:a1:2026-08-10')!;
    expect(a1).toMatchObject({ platform: 'meta', level: 'ad', campaignName: 'Summer Shred', spendCents: 1234, impressions: 1000, clicks: 50, leads: 3, source: 'meta', backfilled: true });

    const again = await runMetaSync({ mode: 'backfill', trigger: 'cli', since: '2026-08-10' });
    expect(again.ok).toBe(true);
    expect((await db.select().from(adSpend).where(eq(adSpend.origin, 'meta'))).length).toBe(3);
  });

  it('splits long windows into sequential ≤7-day chunks', () => {
    expect(chunkWindows('2026-08-10', '2026-08-12')).toEqual([{ since: '2026-08-10', until: '2026-08-12' }]);
    expect(chunkWindows('2026-08-01', '2026-08-01')).toEqual([{ since: '2026-08-01', until: '2026-08-01' }]);
    const june16 = chunkWindows('2026-06-16', '2026-09-01');
    expect(june16[0]).toEqual({ since: '2026-06-16', until: '2026-06-22' });
    expect(june16[1].since).toBe('2026-06-23');
    expect(june16.at(-1)!.until).toBe('2026-09-01');
    // Every day covered exactly once, no gaps or overlaps.
    for (let i = 1; i < june16.length; i += 1) {
      expect(june16[i].since > june16[i - 1].until).toBe(true);
    }
    expect(june16.every((c) => c.until >= c.since)).toBe(true);
  });

  it('backfill: retries a failing chunk, saves the cursor, and a re-run resumes', async () => {
    await setSetting(SETTING_KEYS.backfillFrom, '2026-08-01');
    await setSetting(SETTING_KEYS.metaBackfillCursor, '');
    // Chunks for 2026-08-01 → 2026-08-12: [08-01..08-07], [08-08..08-12].
    failSince.add('2026-08-08');

    const first = await runMetaSync({ mode: 'backfill', trigger: 'cli' });
    expect(first.ok).toBe(false);
    expect(first.error).toContain('2026-08-08');
    expect(first.stats.chunksTotal).toBe(2);
    expect(first.stats.chunksDone).toBe(1);
    // The failing chunk was attempted twice (retry with backoff).
    expect(requestedWindows.filter((s) => s === '2026-08-08')).toHaveLength(2);
    expect(await getSetting(SETTING_KEYS.metaBackfillCursor)).toBe('2026-08-08');
    const [failedRun] = await db.select().from(syncRuns).where(eq(syncRuns.id, first.runId));
    expect(failedRun.status).toBe('failed');
    expect((failedRun.stats as Record<string, number>).chunksDone).toBe(1);

    // Meta recovers; a plain re-run resumes at the cursor, not 2026-08-01.
    failSince.clear();
    requestedWindows.length = 0;
    const second = await runMetaSync({ mode: 'backfill', trigger: 'cli' });
    expect(second.ok).toBe(true);
    expect(requestedWindows[0]).toBe('2026-08-08');
    expect(requestedWindows).not.toContain('2026-08-01');
    expect(second.stats.chunksTotal).toBe(1);
    expect(await getSetting(SETTING_KEYS.metaBackfillCursor)).toBe('');
  }, 30_000);

  it('never stores the token in an error message', async () => {
    await setSetting(META_KEYS.adAccountId, 'bad');
    const r = await runMetaSync({ mode: 'delta', trigger: 'cli' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain(TOKEN);
    expect(r.error).toContain('[token]');
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, r.runId));
    expect(run.error ?? '').not.toContain(TOKEN);
  });
});
