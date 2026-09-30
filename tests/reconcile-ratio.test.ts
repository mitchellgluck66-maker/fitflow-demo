/**
 * The Meta-to-FitFlow ratio monitor (plan item 3): the pure drift rule on the doc's numbers, the
 * exact Meta request (contract), the job on PGlite with a mocked Graph API (null never becomes 0,
 * one incident per campaign with hysteresis), and parity with the campaign table.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, ghlOpportunities, stageTransitions, adSpend, appliedRatioDaily, syncIncidents, syncRuns } from '@/db';
import { judgeRatio, shift, type RatioDay } from '@/lib/reconcile/ratioDrift';
import { fetchCampaignSubmits, CAMPAIGN_SUBMITS_QUERY } from '@/lib/meta/client';
import { runAppliedLedger } from '@/lib/reconcile/appliedLedger';
import { runAppliedRatio, readRatioSummary, RATIO_INCIDENT_KIND } from '@/lib/reconcile/appliedRatio';
import { writeMarker } from '@/lib/sync/markers';
import { setSetting, SETTING_KEYS } from '@/lib/settings';
import { META_KEYS } from '@/lib/meta/config';
import { loadMetricsInput } from '@/lib/metrics/load';
import { computeCampaignTable } from '@/lib/metrics';

const ASOF = '2026-09-26';
const series = (f: (i: number, date: string) => RatioDay): RatioDay[] => Array.from({ length: 40 }, (_, k) => 39 - k).map((i) => f(i, shift(ASOF, -i)));

describe('judgeRatio (pure)', () => {
  it('the doc: a steady ~2× is stable', () => {
    const v = judgeRatio(series((_, date) => ({ date, meta: 12, fitflow: 6 })), ASOF);
    expect(v).toMatchObject({ state: 'stable', rolling7: 2, baseline: 2, meta7: 84, fitflow7: 42 });
    expect(v.text).toBe("Meta counts 2.00× FitFlow's applications over 7 days (baseline 2.00×) — stable");
  });
  it('the pixel fixed: the ratio halves for 2 consecutive days → drift_down; one day alone is not enough', () => {
    const halved = (from: number) => series((i, date) => ({ date, meta: i < from ? 6 : 12, fitflow: 6 }));
    expect(judgeRatio(halved(8), ASOF).state).toBe('drift_down'); // last 8 days at 1×: today and yesterday both < 0.6 × 2
    expect(judgeRatio(halved(6), ASOF).state).toBe('stable'); // yesterday's window was not yet below the line
    expect(judgeRatio(series((i, date) => ({ date, meta: i < 8 ? 30 : 12, fitflow: 6 })), ASOF).state).toBe('drift_up');
  });
  it('hysteresis: an open drift resolves only inside 1.3× / 0.77× of the baseline', () => {
    const at = (r: number) => series((i, date) => ({ date, meta: i < 7 ? Math.round(6 * r) : 12, fitflow: 6 }));
    expect(judgeRatio(at(1.4), ASOF, 'drift_down').state).toBe('drift_down'); // 0.7× — still out
    expect(judgeRatio(at(1.6), ASOF, 'drift_down').state).toBe('stable'); // 0.8× — back inside
    expect(judgeRatio(at(1.4), ASOF, null).state).toBe('stable'); // never drifted: 0.7× is not below 0.6×
  });
  it('broken tracking, too small to judge, learning, and incomplete (a null day is never a 0)', () => {
    expect(judgeRatio(series((i, date) => ({ date, meta: 12, fitflow: i < 7 ? 0 : 6 })), ASOF)).toMatchObject({ state: 'broken_meta', meta7: 84, fitflow7: 0 });
    expect(judgeRatio(series((i, date) => ({ date, meta: i < 7 ? 0 : 12, fitflow: 6 })), ASOF)).toMatchObject({ state: 'broken_fitflow' });
    expect(judgeRatio(series((_, date) => ({ date, meta: 1, fitflow: 1 })), ASOF)).toMatchObject({ state: 'insufficient', meta7: 7 });
    expect(judgeRatio(series((i, date) => ({ date, meta: i < 20 ? 12 : null, fitflow: 6 })), ASOF)).toMatchObject({ state: 'learning' });
    const inc = judgeRatio(series((i, date) => ({ date, meta: i === 2 ? null : 12, fitflow: 6 })), ASOF);
    expect(inc).toMatchObject({ state: 'incomplete', rolling7: null, missingDays: [shift(ASOF, -2)] });
    expect(judgeRatio([], ASOF).state).toBe('incomplete');
  });
});

// ---------------------------------------------------------------------------
// The job, with a mocked Graph API
// ---------------------------------------------------------------------------

const TZ = 'America/Edmonton';
const TODAY = '2026-09-29';
const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
const d = (iso: string) => new Date(iso);
const FORM = 'New Application 7.10';
const requests: URL[] = [];
let failChunk: string | null = null;
/** Meta: campaign 1 "(Sept 7) Scaling" 2 submits/day, campaign 2 "(July 16) New VSL" 1/day; no row for a day = no delivery. */
const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  requests.push(url);
  if (url.pathname.endsWith('/insights')) {
    const range = JSON.parse(url.searchParams.get('time_range') ?? '{}') as { since: string; until: string };
    if (failChunk && range.since === failChunk) return new Response(JSON.stringify({ error: { message: 'boom', type: 'OAuthException', code: 1 } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const data: unknown[] = [];
    for (let day = range.since; day <= range.until; day = shift(day, 1)) {
      data.push({ date_start: day, date_stop: day, campaign_id: 'c1', campaign_name: '(Sept 7) Scaling', conversions: [{ action_type: 'submit_application_website', value: '2' }, { action_type: 'offsite_conversion.fb_pixel_custom', value: '9' }] });
      if (day !== '2026-09-25') data.push({ date_start: day, date_stop: day, campaign_id: 'c2', campaign_name: '(July 16) New VSL', conversions: [{ action_type: 'submit_application_website', value: 1 }] });
    }
    return new Response(JSON.stringify({ data, paging: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
});

describe('runAppliedRatio (PGlite, mocked Graph API)', () => {
  beforeAll(async () => {
    await runMigrations();
    vi.stubGlobal('fetch', fakeFetch);
    await setSetting(SETTING_KEYS.backfillFrom, '2026-08-01');
    await db.insert(pipelines).values([{ id: 'pf', name: 'Application', isTracked: true, ...prov }]);
    await db.insert(stages).values([{ id: 's-app', pipelineId: 'pf', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov }]);
    // 3 applicants a day tracked to Scaling from Aug 20 through today, one on Sep 24 with an unmatched utm.
    const rows: Array<typeof contacts.$inferInsert> = [];
    const opps: Array<typeof ghlOpportunities.$inferInsert> = [];
    for (let day = '2026-08-20'; day <= TODAY; day = shift(day, 1)) {
      for (let n = 0; n < 3; n++) {
        const id = `${day}-${n}`;
        rows.push({ ghlContactId: `g-${id}`, ghlOpportunityId: `o-${id}`, pipelineId: 'pf', stageId: 's-app', firstName: id, lastName: '', ghlCreatedAt: d(`${day}T18:00:00Z`), attributionSource: FORM, utmCampaign: '(Sept 7) Scaling', ...prov });
        opps.push({ id: `o-${id}`, ghlContactId: `g-${id}`, pipelineId: 'pf', stageId: 's-app', status: 'open', ghlCreatedAt: d(`${day}T18:30:00Z`), ...prov });
      }
    }
    rows.push({ ghlContactId: 'g-odd', ghlOpportunityId: 'o-odd', pipelineId: 'pf', stageId: 's-app', firstName: 'odd', lastName: '', ghlCreatedAt: d('2026-09-24T18:00:00Z'), attributionSource: FORM, utmCampaign: 'TH | TOF Quiz', ...prov });
    opps.push({ id: 'o-odd', ghlContactId: 'g-odd', pipelineId: 'pf', stageId: 's-app', status: 'open', ghlCreatedAt: d('2026-09-24T18:30:00Z'), ...prov });
    await db.insert(contacts).values(rows);
    await db.insert(ghlOpportunities).values(opps);
    const ids = await db.select({ id: contacts.id, ghl: contacts.ghlContactId, opp: contacts.ghlOpportunityId }).from(contacts);
    await db.insert(stageTransitions).values(ids.map((c) => ({ contactId: c.id, ghlOpportunityId: c.opp, pipelineId: 'pf', toStageId: 's-app', observedAt: d('2026-09-27T00:00:00Z'), kind: 'initial', ...prov })));
    await db.insert(adSpend).values({ externalId: 'meta:c1:2026-09-22', platform: 'meta', level: 'campaign', campaignId: 'c1', campaignName: '(Sept 7) Scaling', date: '2026-09-22', spendCents: 10_000, currency: 'CAD', ...prov, origin: 'meta', source: 'meta' });
    await writeMarker({ family: 'ghl.opportunities', runId: null, fetched: 1 });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('not configured → notConfigured; no account timezone → skipped; waits for the ledger', async () => {
    expect(await runAppliedRatio({ trigger: 'cli', today: TODAY })).toMatchObject({ ok: false, notConfigured: true });
    await setSetting(META_KEYS.token, 'EAAtest', { secret: true });
    await setSetting(META_KEYS.adAccountId, 'act_123');
    expect(await runAppliedRatio({ trigger: 'cli', today: TODAY })).toMatchObject({ skipped: expect.stringContaining('Meta account timezone unknown') });
    await setSetting(SETTING_KEYS.metaAccount, JSON.stringify({ id: 'act_123', name: 'x', currency: 'CAD', timezone: 'America/Los_Angeles', checkedAt: TODAY }));
    expect(await runAppliedRatio({ trigger: 'cli', today: TODAY })).toMatchObject({ skipped: 'waiting for the first Applied ledger run' });
    expect(requests.filter((u) => u.pathname.endsWith('/insights')).length).toBe(0);
  });

  it('sends the exact request (contract), stores Meta submits per campaign per account day, and judges each campaign', async () => {
    expect((await runAppliedLedger({ trigger: 'cli', today: TODAY })).ok).toBe(true);
    const r = await runAppliedRatio({ trigger: 'cli', today: TODAY });
    expect(r).toMatchObject({ ok: true, partial: false });
    const insights = requests.filter((u) => u.pathname.endsWith('/insights'));
    expect(insights.length).toBe(6); // 36 days in ≤7-day chunks
    for (const u of insights) {
      expect(u.searchParams.get('fields')).toBe('campaign_id,campaign_name,conversions');
      expect(u.searchParams.get('level')).toBe('campaign');
      expect(u.searchParams.get('time_increment')).toBe('1');
      expect(u.searchParams.get('action_report_time')).toBe('conversion');
      expect(u.searchParams.get('action_attribution_windows')).toBe('["7d_click","1d_view"]');
      expect(u.searchParams.get('access_token')).toBe('EAAtest');
    }
    expect(CAMPAIGN_SUBMITS_QUERY.action_report_time).toBe('conversion');
    const rows = await db.select().from(appliedRatioDaily);
    const c1 = rows.filter((x) => x.campaignId === 'c1').sort((a, b) => a.date.localeCompare(b.date));
    expect(c1.length).toBe(36);
    expect(c1.every((x) => x.metaSubmits === 2 && x.metaDayTz === 'America/Los_Angeles')).toBe(true);
    expect(c1.find((x) => x.date === '2026-09-22')).toMatchObject({ fitflowApplied: 3, fitflowFormApplicants: 3, campaignKey: 'sept 7 scaling' });
    // A fetched day with no row for the campaign is a real 0 (no delivery), never null.
    expect(rows.find((x) => x.campaignId === 'c2' && x.date === '2026-09-25')?.metaSubmits).toBe(0);
    const summary = (await readRatioSummary())!;
    const scaling = summary.campaigns.find((c) => c.campaignId === 'c1')!;
    // 3 applicants/day since Aug 20 vs 2 submits/day → 0.67× everywhere → stable.
    expect(scaling).toMatchObject({ state: 'stable', meta7: 14, fitflow7: 21 });
    expect(scaling.rolling7).toBeCloseTo(0.6667, 3);
    // New VSL: no FitFlow rows at all in the baseline → learning (6 Meta submits in 7 days is under the broken_meta line).
    expect(summary.campaigns.find((c) => c.campaignId === 'c2')).toMatchObject({ state: 'learning', meta7: 6, fitflow7: 0 });
    expect(summary.unmatchedUtmRows).toBe(1); // "TH | TOF Quiz" on Sep 24
    expect(summary.metaDayTz).toBe('America/Los_Angeles');
    expect(r.reason).toContain('5 campaigns'.replace('5', '2'));
  });

  it('parity: FitFlow applications per campaign for the week equal the campaign table\'s tracked applied', async () => {
    const week = { start: '2026-09-20', end: '2026-09-26' };
    const input = await loadMetricsInput({ ...week, timezone: TZ });
    const table = computeCampaignTable(input, week).find((c) => c.campaignName === '(Sept 7) Scaling')!;
    const rows = await db.select().from(appliedRatioDaily).where(eq(appliedRatioDaily.campaignId, 'c1'));
    const ledgerWeek = rows.filter((x) => x.date >= week.start && x.date <= week.end).reduce((a, x) => a + x.fitflowApplied, 0);
    expect(ledgerWeek).toBe(table.tracked.applied);
    expect(ledgerWeek).toBe(21);
  });

  it('a failed chunk leaves those days null (incomplete), keeps earlier rows, and the run is partial; a later run fills them', async () => {
    failChunk = TODAY; // the last (one-day) chunk of the 36-day window
    const r = await runAppliedRatio({ trigger: 'cli', today: TODAY, force: true });
    expect(r).toMatchObject({ ok: true, partial: true, error: expect.stringContaining('boom') });
    const rows = await db.select().from(appliedRatioDaily).where(eq(appliedRatioDaily.campaignId, 'c1'));
    // The earlier rows keep their fetched values (coalesce): a failed chunk never overwrites with null.
    expect(rows.find((x) => x.date === TODAY)?.metaSubmits).toBe(2);
    const run = (await db.select().from(syncRuns).where(eq(syncRuns.kind, 'applied_ratio'))).at(-1)!;
    expect(run.status).toBe('partial');
    expect(String(run.stats?.reason)).toContain('chunk error');
    failChunk = null;
    // A brand-new campaign day that was never fetched stays null → incomplete for that campaign.
    await db.delete(appliedRatioDaily).where(and(eq(appliedRatioDaily.campaignId, 'c1'), eq(appliedRatioDaily.date, TODAY)));
    failChunk = TODAY;
    await runAppliedRatio({ trigger: 'cli', today: TODAY, force: true });
    expect((await db.select().from(appliedRatioDaily).where(and(eq(appliedRatioDaily.campaignId, 'c1'), eq(appliedRatioDaily.date, TODAY))))[0].metaSubmits).toBeNull();
    expect((await readRatioSummary())!.campaigns.find((c) => c.campaignId === 'c1')!.state).toBe('incomplete');
    failChunk = null;
    await runAppliedRatio({ trigger: 'cli', today: TODAY, force: true });
    expect((await readRatioSummary())!.campaigns.find((c) => c.campaignId === 'c1')!.state).toBe('stable');
  });

  it('once per day, and ONE applied_ratio_drift incident per campaign that resolves with hysteresis', async () => {
    expect(await runAppliedRatio({ trigger: 'cli', today: TODAY })).toMatchObject({ skipped: expect.stringMatching(/^already ran today at \d{2}:\d{2}$/) });
    // Make Scaling's last 8 account days read 8 submits/day (4× the baseline 0.67×) → drift_up.
    for (let i = 0; i < 8; i++) await db.update(appliedRatioDaily).set({ metaSubmits: 8 }).where(and(eq(appliedRatioDaily.campaignId, 'c1'), eq(appliedRatioDaily.date, shift(TODAY, -i))));
    // Re-judge without re-fetching: point the fake at the same numbers by re-running with the fetch failing everywhere (rows keep their values).
    failChunk = '__all__';
    fakeFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 }));
    failChunk = null;
    // Simpler: judge directly from stored rows via a forced run whose fetch returns the stored 8s.
    const eight = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const range = JSON.parse(url.searchParams.get('time_range') ?? '{}') as { since: string; until: string };
      const data: unknown[] = [];
      for (let day = range.since; day <= range.until; day = shift(day, 1)) data.push({ date_start: day, date_stop: day, campaign_id: 'c1', campaign_name: '(Sept 7) Scaling', conversions: [{ action_type: 'submit_application_website', value: day >= shift(TODAY, -7) ? 8 : 2 }] });
      return new Response(JSON.stringify({ data, paging: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', eight);
    const r = await runAppliedRatio({ trigger: 'cli', today: TODAY, force: true });
    expect(r.summary?.campaigns.find((c) => c.campaignId === 'c1')).toMatchObject({ state: 'drift_up' });
    const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, RATIO_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));
    expect(open.length).toBe(1);
    expect(open[0].message).toMatch(/^Applied ratio · \(Sept 7\) Scaling: Meta-to-FitFlow ratio drifted UP/);
    await runAppliedRatio({ trigger: 'cli', today: TODAY, force: true });
    expect((await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, RATIO_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)))).length).toBe(1); // refreshed, not duplicated
    // Back to 2/day everywhere → inside the band → resolved with the reason.
    vi.stubGlobal('fetch', fakeFetch);
    await runAppliedRatio({ trigger: 'cli', today: TODAY, force: true });
    const all = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, RATIO_INCIDENT_KIND));
    expect(all.length).toBe(1);
    expect(all[0].resolvedAt).not.toBeNull();
    expect((all[0].details as { resolvedBy?: string }).resolvedBy).toContain('stable');
  });
});
