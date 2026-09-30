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
import { computeScorecard, computeRevenueSummary, computeAdsKpis, type MetricsInput } from '@/lib/metrics';
import type { ScorecardResult } from '@/lib/metrics/service';
import { computeMaturity } from '@/lib/metrics/maturity';
import { runInsights } from '@/lib/anthropic/insights';
import { runWeeklyNarrative, getNarrative } from '@/lib/anthropic/narrative';
import { suggestRoleForStage } from '@/lib/anthropic/remap';
import { testConnection, askClaude } from '@/lib/anthropic/client';
import { z } from 'zod';
import { and, isNull } from 'drizzle-orm';
import { syncIncidents } from '@/db';

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
  spend: [{ date: '2026-08-16', platform: 'meta', currency: 'CAD' as const, spendCents: 40_000, origin: 'manual' }],
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
    trendWeeklyCohort: { current: [], comparison: null },
    trailingWeeks: [],
    ads: { kpis: computeAdsKpis(INPUT, R), previousKpis: null, campaigns: [], previousCampaigns: null },
    revenue: computeRevenueSummary(INPUT, R),
    maturity: computeMaturity({ range: R, today: '2026-08-26', historyCompleteSince: '2026-09-01', sunset: '2026-10-15' }),
    money: { currency: 'CAD' as const, fx: { reporting: 'CAD' as const, from: 'USD' as const, rate: 1.36, text: 'displayed in CAD · USD converted at 1.36' }, unsupportedRows: 0 },
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

  it('validateInsights keeps at most 3 findings (extra ones trimmed) and pins known links', () => {
    const f = { title: 'x', detail: 'y', metric: 'cac', direction: 'up', severity: 'info', link: input.deepLinks.ads };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const four = validateInsights({ findings: [f, f, f, f] }, input.deepLinks);
    expect(four.ok && four.findings).toHaveLength(3);
    warn.mockRestore();
    expect(validateInsights({ findings: [f] }, input.deepLinks)).toMatchObject({ ok: true, warnings: [] });
    expect(validateInsights({ findings: [] }, input.deepLinks)).toMatchObject({ ok: true, findings: [] });
  });

  // 2026-09-30 hotfix — production smoke: "FAIL insights · link not in deepLinks: stage:consult_showed".
  it('a KEY, a URL and an unknown link all produce findings: key → its URL, URL kept, unknown → Command Center + warning', () => {
    const f = (link: string, title: string) => ({ title, detail: 'd', metric: 'm', direction: 'up', severity: 'info', link });
    const r = validateInsights({ findings: [f('stage:consult_showed', 'by key'), f(input.deepLinks.ads, 'by url'), f('https://evil.example', 'unknown')] }, input.deepLinks);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.map((x) => [x.title, x.link])).toEqual([
      ['by key', input.deepLinks['stage:consult_showed']],
      ['by url', input.deepLinks.ads],
      ['unknown', input.deepLinks.command_center],
    ]);
    expect(r.warnings).toEqual(['finding "unknown": link "https://evil.example" is not one we offered — linked to the Command Center instead']);
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

  it('minIntervalMs (the 30-min heartbeat): a fresh card for the period is served even when the numbers moved', async () => {
    // Pretend the numbers moved since the stored cards: their hash no longer matches.
    await db.update(aiReports).set({ inputHash: 'numbers-moved' }).where(eq(aiReports.kind, 'insight'));
    vi.stubGlobal('fetch', fetchSpy);
    const calls = fetchSpy.mock.calls.length;
    const fresh = await runInsights({ range: 'last_week', minIntervalMs: 20 * 3_600_000 });
    expect(fresh).toMatchObject({ ok: true, cached: true });
    expect(fresh.skipped).toMatch(/at most every 20h/);
    expect(fetchSpy).toHaveBeenCalledTimes(calls);

    const later = await runInsights({ range: 'last_week', minIntervalMs: 20 * 3_600_000, now: new Date(Date.now() + 21 * 3_600_000) });
    expect(later.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(calls + 1);
  });

  it('the SENT schema narrows link to an enum of exactly this snapshot\'s deepLinks keys; a key answer is stored as its URL', async () => {
    fetchSpy.mockImplementation(async () =>
      messagesResponse({ findings: [{ title: 'Consult shows', detail: 'd', metric: 'm', direction: 'down', severity: 'warning', link: 'stage:consult_showed' }] }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const r = await runInsights({ range: 'this_week', force: true });
    expect(r.ok, r.error).toBe(true);
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    const sentEnum = body.tools[0].input_schema.properties.findings.items.properties.link.enum as string[];
    const [stored] = await db.select().from(aiReports).where(eq(aiReports.id, r.reportId!));
    const offered = Object.keys((stored.content as { input: { deepLinks: Record<string, string> } }).input.deepLinks);
    expect([...sentEnum].sort()).toEqual([...offered].sort());
    expect(sentEnum).toContain('stage:consult_showed');
    expect(r.findings[0].link).toMatch(/^\/funnel\?.*stage=consult_showed$/);
  });

  it('an unknown link does not discard the answer: the finding is kept and links to the Command Center', async () => {
    fetchSpy.mockImplementation(async () =>
      messagesResponse({ findings: [{ title: 't', detail: 'd', metric: 'm', direction: 'up', severity: 'info', link: 'https://example.com' }] }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runInsights({ range: 'this_week', force: true });
    warn.mockRestore();
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].link).toMatch(/^\/\?/);
    expect(r.warnings?.[0]).toMatch(/not one we offered/);
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

  it('is generated once per period: an unforced run reuses the stored paragraph whatever the numbers do', async () => {
    const probe = await runWeeklyNarrative('weekly', { force: true });
    await db.insert(aiReports).values({ kind: 'weekly_narrative', periodStart: probe.periodStart, periodEnd: probe.periodEnd, model: 'm', inputHash: 'older-numbers', content: { paragraph: 'Stored earlier.' } });
    vi.stubGlobal('fetch', fetchSpy);
    const calls = fetchSpy.mock.calls.length;
    const r = await runWeeklyNarrative('weekly');
    expect(r).toMatchObject({ ok: true, cached: true, paragraph: 'Stored earlier.' });
    expect(fetchSpy).toHaveBeenCalledTimes(calls);
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

  });
});

// 2026-09-30: Verify used to send a plain ping (no tools) and said "Connected" for a key whose every feature 400'd.
describe('Setup Verify = a real strict structured call', () => {
  const reply = (content: unknown[], stop = 'tool_use') =>
    new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: stop, content, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('sends a strict, sanitized tool and says "Connected · verified with a structured call · <model>"', async () => {
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-test-key-1234', { secret: true });
    fetchSpy.mockImplementation(async () => reply([{ type: 'tool_use', id: 't', name: 'submit_check', input: { status: 'ok', note: 'all good' } }]));
    vi.stubGlobal('fetch', fetchSpy);
    const conn = await testConnection();
    expect(conn).toMatchObject({ ok: true, message: 'Connected · verified with a structured call · claude-sonnet-5' });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.tools[0]).toMatchObject({ name: 'submit_check', strict: true });
    expect(JSON.stringify(body.tools[0].input_schema)).not.toContain('maxLength');
  });

  it('a text-only reply is NOT connected', async () => {
    fetchSpy.mockImplementation(async () => reply([{ type: 'text', text: 'ok' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await testConnection()).toMatchObject({ ok: false, message: 'Verification failed: No structured answer returned.' });
  });

  it('a bad key shows the exact API error', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json', 'request-id': 'req_verify_1' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const conn = await testConnection();
    expect(conn.ok).toBe(false);
    expect(conn.message).toMatch(/^Verification failed: Anthropic 401 · authentication_error: invalid x-api-key \(request_id req_verify_1\)$/);
  });
});

// 2026-09-30: an AI failure is visible in Setup → Incidents — ONE open anthropic_error, severity by class.
describe('anthropic_error incident', () => {
  const ok = () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'submit', input: { v: 'x' } }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const err = (status: number, type: string, message: string) => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', 'request-id': `req_${status}` } });
  const call = () => askClaude({ system: 's', user: 'u', inputSchema: { type: 'object', properties: { v: { type: 'string' } } }, schema: z.object({ v: z.string() }), retryDelayMs: 0 });
  const open = () => db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'anthropic_error'), isNull(syncIncidents.resolvedAt)));

  it('a 400 opens ONE critical incident (refreshed, not duplicated); the next success resolves it', async () => {
    await setSetting(ANTHROPIC_KEYS.apiKey, 'sk-ant-test-key-1234', { secret: true });
    fetchSpy.mockImplementation(async () => err(400, 'invalid_request_error', "For 'array' type, property 'maxItems' is not supported"));
    vi.stubGlobal('fetch', fetchSpy);
    await call();
    const r = await call();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // a 400 is never retried
    expect(r.error).toMatch(/Anthropic 400 · invalid_request_error: For 'array' type, property 'maxItems' is not supported \(request_id req_400\)/);
    const rows = await open();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical' });
    expect(rows[0].message).toMatch(/^AI request failed \(submit\): Anthropic 400/);

    fetchSpy.mockImplementation(async () => ok());
    expect((await call()).ok).toBe(true);
    expect(await open()).toHaveLength(0);
  });

  it('429 / 529 overloaded: retried once; still failing → WARNING incident; recovering on the retry → no incident', async () => {
    fetchSpy.mockImplementation(async () => err(529, 'overloaded_error', 'Overloaded'));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await call();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    expect((await open())[0]).toMatchObject({ severity: 'warning' });

    fetchSpy.mockReset();
    let n = 0;
    fetchSpy.mockImplementation(async () => (n++ === 0 ? err(429, 'rate_limit_error', 'slow down') : ok()));
    expect((await call()).ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await open()).toHaveLength(0);
  });

  it('401 / 403 and an invalid structured answer are critical', async () => {
    fetchSpy.mockImplementation(async () => err(403, 'permission_error', 'no access'));
    vi.stubGlobal('fetch', fetchSpy);
    await call();
    expect((await open())[0]).toMatchObject({ severity: 'critical' });

    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'submit', input: { v: 7 } }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await call();
    expect(r.error).toMatch(/^Answer failed validation at v:/);
    const rows = await open();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical' });
    fetchSpy.mockImplementation(async () => ok());
    await call();
  });
});
