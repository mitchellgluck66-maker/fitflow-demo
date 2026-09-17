/**
 * Anthropic integration: pure input assembly + validation, caching in
 * ai_reports, clean not-configured behaviour, key hygiene. The Messages API
 * is stubbed at fetch level (the SDK is constructed with globalThis.fetch).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, aiReports, pipelines, stages } from '@/db';
import { setSetting } from '@/lib/settings';
import { ANTHROPIC_KEYS } from '@/lib/anthropic/config';
import { buildInsightInput, hashInsightInput, validateInsights } from '@/lib/metrics/insights';
import { computeScorecard, computeRevenueSummary, type MetricsInput } from '@/lib/metrics';
import type { ScorecardResult } from '@/lib/metrics/service';
import { runInsights } from '@/lib/anthropic/insights';
import { runWeeklyNarrative, getNarrative } from '@/lib/anthropic/narrative';
import { suggestRoleForStage } from '@/lib/anthropic/remap';
import { testConnection } from '@/lib/anthropic/client';

// ---- hand-built ScorecardResult -------------------------------------------
const R = { start: '2026-08-16', end: '2026-08-22' };
const P = { start: '2026-08-09', end: '2026-08-15' };
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const c = (id: string, source: string, appliedOn: string, role: string) => ({
  id, name: id, email: `${id}@x.com`, source, stageId: null, stageName: null, role: role as never, appliedOn, monetaryValueCents: 0, origin: 'ghl',
});
const t = (contactId: string, toRole: string, on: string) => ({ contactId, fromRole: null, toRole: toRole as never, toStageId: null, on, atMs: noon(on) });
const a = (contactId: string, type: string, outcome: string | null, on: string) => ({ contactId, type, outcome, on, atMs: noon(on) });

const INPUT: MetricsInput = {
  contacts: [
    c('a1', 'Facebook', '2026-08-17', 'consult_noshow'),
    c('a2', 'Facebook', '2026-08-18', 'consult_booked'),
    c('a3', 'Google', '2026-08-19', 'enrolled'),
    c('p1', 'Facebook', '2026-08-10', 'enrolled'),
    c('p2', 'Google', '2026-08-11', 'enrolled'),
  ],
  transitions: [
    t('a1', 'consult_booked', '2026-08-18'), t('a2', 'consult_booked', '2026-08-19'), t('a3', 'consult_booked', '2026-08-19'), t('a3', 'enrolled', '2026-08-22'),
    t('p1', 'consult_booked', '2026-08-11'), t('p1', 'enrolled', '2026-08-14'), t('p2', 'consult_booked', '2026-08-12'), t('p2', 'enrolled', '2026-08-15'),
  ],
  appointments: [a('a1', 'Consult', 'no_show', '2026-08-20'), a('a3', 'Consult', 'showed', '2026-08-21'), a('p1', 'Consult', 'showed', '2026-08-13'), a('p2', 'Consult', 'showed', '2026-08-14')],
  spend: [{ date: '2026-08-16', platform: 'meta', spendCents: 40_000, origin: 'manual' }],
  payments: [],
};

function fakeResult(): ScorecardResult {
  const scorecard = computeScorecard(INPUT, R, P, null);
  return {
    timezone: 'America/New_York',
    today: '2026-08-26',
    range: { ...R, preset: 'last_week', presetLabel: 'Last week', resolvedLabel: 'Aug 16–22' },
    comparison: { mode: 'previous_period', range: { ...P, preset: 'custom', presetLabel: 'Previous period', resolvedLabel: 'Aug 9–15' }, label: 'vs previous period · Aug 9–15' },
    baseline: { start: '2026-06-21', end: '2026-08-15' },
    scorecard,
    trend: { grain: 'day', current: [], comparison: null },
    trendWeekly: { current: [], comparison: null },
    ads: { kpis: { spendCents: 0, costPerLeadCents: null, costPerConsultCents: null, cacCents: null, roas: null, awaitingStripe: true, apiConnected: false, byPlatform: [] }, previousKpis: null, campaigns: [], previousCampaigns: null },
    revenue: computeRevenueSummary(INPUT, R),
  };
}

describe('buildInsightInput (pure)', () => {
  const input = buildInsightInput(fakeResult());

  it('snapshots funnel stages with comparison deltas and baseline tones', () => {
    const applied = input.funnel.find((f) => f.stage === 'applied')!;
    expect(applied).toMatchObject({ count: 3, previousCount: 2, changePct: 0.5 });
    const enrolled = input.funnel.find((f) => f.stage === 'enrolled')!;
    expect(enrolled).toMatchObject({ count: 1, previousCount: 2, changePct: -0.5 });
    expect(input.period).toMatchObject({ label: 'Aug 16–22', preset: 'last_week' });
    expect(input.comparison?.label).toBe('Aug 9–15');
    expect(input.showRates).toEqual([{ type: 'Consult', showed: 1, noShow: 1, rate: 0.5 }]);
  });

  it('respects awaitingStripe and carries CAC', () => {
    expect(input.money.revenue).toEqual({ awaitingStripe: true });
    expect(input.money.cacCents).toBe(40_000);
  });

  it('lists sources and builds deep links for stages, sources and tabs', () => {
    expect(input.sources.map((s) => s.source)).toEqual(['Facebook', 'Google']);
    expect(input.deepLinks['stage:consult_showed']).toBe('/funnel?range=last_week&compare=previous_period&stage=consult_showed');
    expect(input.deepLinks['source:Facebook']).toBe('/clients?source=Facebook');
    expect(input.deepLinks.ads).toBe('/ads?range=last_week&compare=previous_period');
  });

  it('hashes stably', () => {
    expect(hashInsightInput(input)).toBe(hashInsightInput(buildInsightInput(fakeResult())));
    expect(hashInsightInput(input)).toHaveLength(64);
  });

  it('validateInsights enforces max 3 findings and known links', () => {
    const f = { title: 'x', detail: 'y', metric: 'cac', direction: 'up', severity: 'info', link: input.deepLinks.ads };
    expect(validateInsights({ findings: [f, f, f, f] }, input.deepLinks).ok).toBe(false);
    expect(validateInsights({ findings: [{ ...f, link: 'https://evil.example' }] }, input.deepLinks).ok).toBe(false);
    expect(validateInsights({ findings: [f] }, input.deepLinks)).toMatchObject({ ok: true });
    expect(validateInsights({ findings: [] }, input.deepLinks)).toMatchObject({ ok: true, findings: [] });
  });
});

// ---- DB-backed behaviour ------------------------------------------------------
const fetchSpy = vi.fn();

function messagesResponse(toolInput: unknown) {
  return new Response(
    JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_findings', input: toolInput }],
      usage: { input_tokens: 500, output_tokens: 80 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeAll(async () => {
  await runMigrations();
  await db.insert(pipelines).values({ id: 'pipe-1', name: 'Application', source: 'ghl', origin: 'ghl' });
  await db.insert(stages).values([
    { id: 'st-applied', pipelineId: 'pipe-1', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', source: 'ghl', origin: 'ghl' },
    { id: 'st-weird', pipelineId: 'pipe-1', name: 'Roadmap No Show', position: 1, semanticRole: null, roleSource: 'unmapped', source: 'ghl', origin: 'ghl' },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchSpy.mockReset();
});

describe('runInsights', () => {
  it('returns notConfigured without touching the network', async () => {
    vi.stubGlobal('fetch', fetchSpy);
    const r = await runInsights({ range: 'last_week' });
    expect(r).toMatchObject({ ok: false, notConfigured: true, findings: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.select().from(aiReports)).toHaveLength(0);
  });

  it('with a key: calls the API once, stores ai_reports, caches on the same input, force regenerates', async () => {
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-test-key-1234', { secret: true });
    const finding = { title: 'Enrollments fell to 1 from 2', detail: 'Google carried the only enrollment; Facebook produced the no-show.', metric: 'enrolled', direction: 'down', severity: 'warning', link: '/funnel?range=last_week&compare=previous_period&stage=enrolled' };
    fetchSpy.mockImplementation(async () => messagesResponse({ findings: [finding] }));
    vi.stubGlobal('fetch', fetchSpy);

    const first = await runInsights({ range: 'last_week' });
    expect(first.ok).toBe(true);
    expect(first.cached).toBe(false);
    expect(first.findings).toEqual([finding]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/v1/messages');
    const body = JSON.parse(String(init.body));
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_findings' });
    expect(body.tools[0].strict).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-ant-test-key-1234');

    const rows = await db.select().from(aiReports).where(eq(aiReports.kind, 'insight'));
    expect(rows).toHaveLength(1);
    expect(rows[0].inputHash).toBe(first.inputHash);
    expect((rows[0].content as { input?: unknown }).input).toBeTruthy();

    const second = await runInsights({ range: 'last_week' });
    expect(second.cached).toBe(true);
    expect(second.reportId).toBe(first.reportId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const third = await runInsights({ range: 'last_week', force: true });
    expect(third.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await db.select().from(aiReports).where(eq(aiReports.kind, 'insight'))).toHaveLength(2);
  });

  it('rejects a finding whose link is not a deep link, and never stores it', async () => {
    fetchSpy.mockImplementation(async () =>
      messagesResponse({ findings: [{ title: 't', detail: 'd', metric: 'm', direction: 'up', severity: 'info', link: 'https://example.com' }] }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const r = await runInsights({ range: 'this_week', force: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/link/);
  });

  it('scrubs the key from API error text', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key sk-ant-test-key-1234' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await runInsights({ range: 'this_month', force: true });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('sk-ant-test-key-1234');
    expect(r.error).toMatch(/401/);
  });
});

describe('narrative', () => {
  it('generates, stores and is readable by the email builder; empty periods produce nothing', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu', name: 'submit_paragraph', input: { paragraph: 'Quiet week: nothing moved.' } }], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const r = await runWeeklyNarrative('weekly', { force: true });
    // The in-memory DB has no contacts → the period is empty → no narrative, no API call.
    expect(r.paragraph).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getNarrative('weekly', r.periodStart, r.periodEnd)).toBeNull();
  });
});

describe('remap suggestion + connection test', () => {
  it('suggests a role (never applies it) and reports notConfigured cleanly', async () => {
    await setSetting(ANTHROPIC_KEYS.apiKey, '', { secret: true });
    vi.stubGlobal('fetch', fetchSpy);
    const off = await suggestRoleForStage('st-weird');
    expect(off).toMatchObject({ ok: false, notConfigured: true, stageName: 'Roadmap No Show' });
    expect(fetchSpy).not.toHaveBeenCalled();

    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-test-key-1234', { secret: true });
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu', name: 'submit_role', input: { role: 'other', confidence: 0.9, rationale: 'A roadmap no-show is not a booked or showed state.' } }], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const on = await suggestRoleForStage('st-weird');
    expect(on).toMatchObject({ ok: true, role: 'other', confidence: 0.9 });
    const [stage] = await db.select().from(stages).where(eq(stages.id, 'st-weird'));
    expect(stage.semanticRole).toBeNull(); // suggestion only

    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    fetchSpy.mockClear();
    const conn = await testConnection();
    expect(conn.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
