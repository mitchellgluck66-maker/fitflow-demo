/**
 * Phase G item 8 — Ask-the-dashboard: context assembly, number grounding,
 * rate limit, and the DB-backed flow against a mocked Anthropic API.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, aiReports } from '@/db';
import { setSetting } from '@/lib/settings';
import { ANTHROPIC_KEYS } from '@/lib/anthropic/config';
import { buildAskContext, collectNumbers, isGroundedNumber, verifyAnswerNumbers, hashAskContext } from '@/lib/metrics/ask';
import { askDashboard, checkAskRateLimit, resetAskRateLimit, listAskHistory, ASK_RATE_LIMIT } from '@/lib/anthropic/ask';
import { ASK_SYSTEM } from '@/lib/anthropic/prompts';
import { computeScorecard, computeTrend, computeAdsKpis, computeCampaignTable, computeRevenueSummary, type MetricsInput } from '@/lib/metrics';
import type { ScorecardResult } from '@/lib/metrics/service';

const R = { start: '2026-08-16', end: '2026-08-22' };
const P = { start: '2026-08-09', end: '2026-08-15' };
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const INPUT: MetricsInput = {
  contacts: [
    { id: 'a1', name: 'Ann', email: 'ann@x.com', source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: '2026-08-17', monetaryValueCents: 600_000, origin: 'ghl', campaign: 'VSL', attribution: 'paid' },
    { id: 'a2', name: 'Bob', email: 'bob@x.com', source: 'Referral', stageId: null, stageName: null, role: 'consult_booked', appliedOn: '2026-08-18', monetaryValueCents: 0, origin: 'ghl', attribution: 'organic' },
  ],
  transitions: [
    { contactId: 'a1', fromRole: null, toRole: 'consult_booked', toStageId: null, on: '2026-08-18', atMs: noon('2026-08-18') },
    { contactId: 'a1', fromRole: 'consult_booked', toRole: 'enrolled', toStageId: null, on: '2026-08-21', atMs: noon('2026-08-21') },
    { contactId: 'a2', fromRole: null, toRole: 'consult_booked', toStageId: null, on: '2026-08-19', atMs: noon('2026-08-19') },
  ],
  appointments: [],
  spend: [{ date: '2026-08-16', platform: 'meta', spendCents: 40_000, origin: 'meta', campaignId: 'c1', campaignName: 'VSL', impressions: 5000, clicks: 200 }],
  payments: [{ id: 'p1', stripeId: 'ch_1', contactId: 'a1', kind: 'charge', amountCents: 250_000, refundedCents: 0, status: 'succeeded', on: '2026-08-21', origin: 'stripe', paymentClass: 'initial' }],
};

function fakeResult(): ScorecardResult {
  const scorecard = computeScorecard(INPUT, R, P, null);
  const weeks = [{ ...P, label: 'Aug 9–15' }, { ...R, label: 'Aug 16–22' }];
  return {
    timezone: 'America/New_York',
    today: '2026-08-26',
    range: { ...R, preset: 'last_week', presetLabel: 'Last week', resolvedLabel: 'Aug 16–22' },
    comparison: { mode: 'previous_period', range: { ...P, preset: 'custom', presetLabel: 'Previous period', resolvedLabel: 'Aug 9–15' }, label: 'vs previous period · Aug 9–15' },
    baseline: { start: '2026-06-21', end: '2026-08-15' },
    scorecard,
    trend: { grain: 'day', current: [], comparison: null },
    trendWeekly: { current: computeTrend(INPUT, [weeks[1]]), comparison: computeTrend(INPUT, [weeks[0]]) },
    trendWeeklyCohort: { current: computeTrend(INPUT, [weeks[1]], 'cohort'), comparison: null },
    trailingWeeks: computeTrend(INPUT, weeks),
    ads: { kpis: computeAdsKpis(INPUT, R), previousKpis: computeAdsKpis(INPUT, P), campaigns: computeCampaignTable(INPUT, R), previousCampaigns: computeCampaignTable(INPUT, P) },
    revenue: computeRevenueSummary(INPUT, R),
  };
}

describe('buildAskContext (pure)', () => {
  const ctx = buildAskContext(fakeResult());

  it('carries both funnel modes, marketing economics, weekly series, campaigns and data-health notes', () => {
    expect(ctx.funnel.period.mode).toBe('period');
    expect(ctx.funnel.cohort.mode).toBe('cohort');
    expect(ctx.funnel.previousPeriod?.mode).toBe('period');
    expect(ctx.marketing.current).toMatchObject({ paidCacCents: 40_000, blendedCacCents: 40_000, paidInitialCents: 250_000, roas: 6.25 });
    expect(ctx.marketing.previous).toMatchObject({ spendCents: 0, enrollments: 0 });
    expect(ctx.weekly.trailing8.map((w) => w.week)).toEqual(['Aug 9–15', 'Aug 16–22']);
    expect(ctx.campaigns[0]).toMatchObject({ campaign: 'VSL', spendCents: 40_000, initialCents: 250_000, roas: 6.25 });
    expect(ctx.dataHealth).toEqual([]);
    expect(ctx.snapshot.period.label).toBe('Aug 16–22');
  });

  it('names missing inputs instead of hiding them', () => {
    const r = fakeResult();
    const ctx2 = buildAskContext({ ...r, scorecard: computeScorecard({ ...INPUT, payments: [], spend: [] }, R, P, null) });
    expect(ctx2.dataHealth.join(' ')).toMatch(/Stripe is not connected/);
    expect(ctx2.dataHealth.join(' ')).toMatch(/No ad spend/);
    expect(ctx2.marketing.current.roas).toBeNull();
  });

  it('hashes stably', () => {
    expect(hashAskContext(ctx)).toBe(hashAskContext(buildAskContext(fakeResult())));
  });
});

describe('number grounding', () => {
  const ctx = buildAskContext(fakeResult());
  const allowed = collectNumbers(ctx);

  it('collects every number in the context', () => {
    expect(allowed.has(40_000)).toBe(true); // spend cents
    expect(allowed.has(250_000)).toBe(true);
    expect(allowed.has(6.25)).toBe(true);
  });

  it('accepts context numbers as written, as dollars, as percentages and as multiples', () => {
    expect(isGroundedNumber(40000, '', allowed)).toBe(true);
    expect(isGroundedNumber(400, '', allowed)).toBe(true); // $400 ← 40,000¢
    expect(isGroundedNumber(2500, '', allowed)).toBe(true); // $2,500 ← 250,000¢
    expect(isGroundedNumber(6.25, '×', allowed)).toBe(true);
    expect(isGroundedNumber(50, '%', allowed)).toBe(true); // enrolled share 1/2 → 0.5
    expect(isGroundedNumber(2, '', allowed)).toBe(true); // small counts always pass
    expect(isGroundedNumber(2026, '', allowed)).toBe(true);
  });

  it('rejects numbers the context cannot have produced', () => {
    expect(isGroundedNumber(9_999, '', allowed)).toBe(false);
    expect(isGroundedNumber(73, '%', allowed)).toBe(false);
    expect(isGroundedNumber(3.7, '×', allowed)).toBe(false);
  });

  it('verifyAnswerNumbers passes a faithful answer and fails an invented one', () => {
    const good = 'Last week (Aug 16–22) you spent $400 and collected $2,500 of new-client cash from 1 paid enrollment — ROAS 6.25×, Paid CAC $400. Blended CAC was also $400 because the only enrollment was paid; 50% of applicants enrolled.';
    expect(verifyAnswerNumbers(good, [{ value: 40_000 }, { value: 6.25 }], ctx)).toEqual({ ok: true, unknown: [] });

    const bad = 'You spent $400 and should expect about $9,999 next week at a 73% conversion.';
    const r = verifyAnswerNumbers(bad, [{ value: 40_000 }], ctx);
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(['$9,999', '73%']);

    const badCitation = verifyAnswerNumbers('Spend was $400.', [{ value: 123_456 }], ctx);
    expect(badCitation).toEqual({ ok: false, unknown: ['citation 123456'] });
  });

  it('ignores ISO dates and date ranges in the prose', () => {
    expect(verifyAnswerNumbers('Between 2026-08-16 and 2026-08-22 (Aug 16–22) spend was $400.', [], ctx).ok).toBe(true);
  });
});

describe('rate limit', () => {
  it('allows 5 per minute, then blocks with a retry-after, and resets after the window', () => {
    resetAskRateLimit();
    const t0 = 1_000_000;
    for (let i = 0; i < ASK_RATE_LIMIT; i += 1) expect(checkAskRateLimit(t0 + i * 1000).ok).toBe(true);
    const blocked = checkAskRateLimit(t0 + 10_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBe(50);
    expect(checkAskRateLimit(t0 + 60_001).ok).toBe(true);
    resetAskRateLimit();
  });
});

// ---- DB-backed flow --------------------------------------------------------
const fetchSpy = vi.fn();
function messagesResponse(toolInput: unknown) {
  return new Response(
    JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_answer', input: toolInput }],
      usage: { input_tokens: 900, output_tokens: 120 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeAll(async () => {
  await runMigrations();
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchSpy.mockReset();
  resetAskRateLimit();
});

describe('askDashboard', () => {
  it('reports notConfigured without touching the network', async () => {
    vi.stubGlobal('fetch', fetchSpy);
    const r = await askDashboard({ question: 'What changed?' });
    expect(r).toMatchObject({ ok: false, notConfigured: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with a key: sends the context, verifies the numbers, persists the Q&A, and lists it in history', async () => {
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-test-key-9999', { secret: true });
    const ctx = buildAskContext(fakeResult());
    fetchSpy.mockImplementation(async () =>
      messagesResponse({ answer: 'Spend was $400 against $2,500 of paid initial cash — ROAS 6.25×.', citations: [{ label: 'Spend', value: 40000, path: 'marketing.current.spendCents' }, { label: 'ROAS', value: 6.25, path: 'marketing.current.roas' }] }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const r = await askDashboard({ question: '  How did ads do?  ', range: 'last_week', contextOverride: ctx });
    expect(r.ok).toBe(true);
    expect(r.answer).toContain('ROAS 6.25×');
    expect(r.citations).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.system).toBe(ASK_SYSTEM);
    expect(body.messages[0].content).toContain('Question: How did ads do?');
    expect(body.messages[0].content).toContain('"paidInitialCents":250000');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_answer' });
    expect(JSON.stringify(body)).not.toContain('sk-ant-test-key-9999');

    const rows = await db.select().from(aiReports).where(eq(aiReports.kind, 'ask'));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatchObject({ question: 'How did ads do?', contextHash: hashAskContext(ctx) });
    const history = await listAskHistory();
    expect(history[0]).toMatchObject({ question: 'How did ads do?', model: 'claude-sonnet-5' });
  });

  it('discards an answer that cites a number not in the context and stores nothing', async () => {
    const ctx = buildAskContext(fakeResult());
    fetchSpy.mockImplementation(async () => messagesResponse({ answer: 'Expect $9,999 next week.', citations: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const before = (await db.select().from(aiReports).where(eq(aiReports.kind, 'ask'))).length;
    const r = await askDashboard({ question: 'Forecast?', contextOverride: ctx });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\$9,999/);
    expect((await db.select().from(aiReports).where(eq(aiReports.kind, 'ask'))).length).toBe(before);
  });

  it('rate-limits the sixth question inside a minute', async () => {
    const ctx = buildAskContext(fakeResult());
    fetchSpy.mockImplementation(async () => messagesResponse({ answer: 'Spend was $400.', citations: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    for (let i = 0; i < ASK_RATE_LIMIT; i += 1) expect((await askDashboard({ question: `q${i}`, contextOverride: ctx })).ok).toBe(true);
    const sixth = await askDashboard({ question: 'one more', contextOverride: ctx });
    expect(sixth).toMatchObject({ ok: false, rateLimited: true });
    expect(fetchSpy).toHaveBeenCalledTimes(ASK_RATE_LIMIT);
  });

  it('rejects an empty question', async () => {
    expect((await askDashboard({ question: '   ' })).ok).toBe(false);
  });
});
