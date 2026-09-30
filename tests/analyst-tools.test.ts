/**
 * Analyst tools (plan item 4): the contract (strict, clean schemas, name-sorted,
 * ≤ 20), parity with the page functions on the demo-seeded database, no email
 * or phone in any result, error RESULTS instead of thrown rounds, and
 * `calculate` in cents with the ratio-average refusal.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import { ANALYST_TOOLS, ANALYST_TOOL_DEFINITIONS, calculate, runAnalystTool, scrubContact, type Freshness, type ToolContext } from '@/lib/analyst/tools';
import { findUnsupportedKeywords } from '@/lib/anthropic/strictSchema';
import { getScorecard, getMetricTrend, getTodoBuckets } from '@/lib/metrics/service';
import { listClients, getClientProfile } from '@/lib/queries/clients';
import { glossaryEntry } from '@/lib/metrics/glossary';
import { loadMetricsInput } from '@/lib/metrics/load';
import { getTimezone } from '@/lib/settings';
import { todayInTimezone, rangeFromParams } from '@/lib/dates';

const freshness: Freshness = { stale: false, line: 'data fresh — test', sources: [] };
const values = new Map<string, number | null>();
const ctx = (ref: string): ToolContext => ({ ref, freshness, resolveRef: (r) => (values.has(r) ? values.get(r) : undefined) });
const LAST_WEEK = { preset: 'last_week', start: null, end: null };

describe('contract', () => {
  it('every tool is strict, its schema passes the strict-mode rules, the list is name-sorted and ≤ 20', () => {
    const names = ANALYST_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names.length).toBeLessThanOrEqual(20);
    expect(names).toEqual(['calculate', 'compare_periods', 'get_campaigns', 'get_client', 'get_data_health', 'get_funnel', 'get_metric', 'get_notes', 'get_payments', 'get_revenue', 'get_scorecard', 'get_stage_people', 'get_todo', 'get_trend', 'list_clients']);
    for (const t of ANALYST_TOOL_DEFINITIONS) {
      expect(t.strict, t.name).toBe(true);
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(40);
      expect(findUnsupportedKeywords(t.input_schema as Record<string, unknown>), t.name).toEqual([]);
    }
  });
});

describe('calculate (pure)', () => {
  const resolve = (r: string) => ({ 'r1:data.marketing.spendCents': 369_768, 'r1:data.marketing.enrollments': 8, 'r2:data.marketing.spendCents': 300_000, 'r1:data.showRates[0].rate': 0.6, 'r2:data.showRates[0].rate': 0.5, 'r1:data.marketing.roas': null } as Record<string, number | null>)[r];
  it('money stays in cents; percent change is a ratio; per_unit rounds to cents', () => {
    expect(calculate('difference', { ref: 'r1:data.marketing.spendCents', value: null }, { ref: 'r2:data.marketing.spendCents', value: null }, resolve)).toEqual({ value: 69_768, unit: 'cents', text: '$697.68' });
    expect(calculate('percent_change', { ref: 'r1:data.marketing.spendCents', value: null }, { ref: 'r2:data.marketing.spendCents', value: null }, resolve)).toMatchObject({ value: 0.23256, unit: 'ratio', text: '23.3%' });
    expect(calculate('per_unit', { ref: 'r1:data.marketing.spendCents', value: null }, { ref: 'r1:data.marketing.enrollments', value: null }, resolve)).toEqual({ value: 46_221, unit: 'cents', text: '$462.21' });
    expect(calculate('product', { ref: null, value: 3 }, { ref: null, value: 4 }, resolve)).toEqual({ value: 12, unit: 'number', text: '12' });
  });
  it('refuses to add or average ratios, unknown refs, null refs and division by zero', () => {
    expect(() => calculate('sum', { ref: 'r1:data.showRates[0].rate', value: null }, { ref: 'r2:data.showRates[0].rate', value: null }, resolve)).toThrow(/recompute from the totals/);
    expect(() => calculate('sum', { ref: 'r9:data.nope', value: null }, { ref: null, value: 1 }, resolve)).toThrow(/unknown ref/);
    expect(() => calculate('ratio', { ref: 'r1:data.marketing.roas', value: null }, { ref: null, value: 1 }, resolve)).toThrow(/null \(withheld\)/);
    expect(() => calculate('ratio', { ref: null, value: 1 }, { ref: null, value: 0 }, resolve)).toThrow(/b is 0/);
    expect(() => calculate('sum', { ref: 'r1:data.marketing.spendCents', value: null }, { ref: 'r1:data.showRates[0].rate', value: null }, resolve)).toThrow(/mixes units/);
  });
  it('scrubContact removes email/phone fields and values that look like them', () => {
    expect(scrubContact({ name: 'A', email: 'a@b.co', phone: '+1 403 555 0100', note: 'call a@b.co', nested: [{ customerEmail: 'x@y.z', keep: 1 }] })).toEqual({ name: 'A', note: 'call a@b.co', nested: [{ keep: 1 }] });
    expect(scrubContact({ detail: '4035550100' })).toEqual({ detail: '[withheld]' });
  });
});

describe('parity with the page functions on the demo database', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);

  it('get_scorecard = getScorecard for last week', async () => {
    const [tool, page] = await Promise.all([runAnalystTool('get_scorecard', { range: LAST_WEEK, compare: 'previous_period' }, ctx('r1')), getScorecard({ range: 'last_week', compare: 'previous_period' })]);
    expect(tool.error).toBeUndefined();
    const d = tool.data as { kpis: Record<string, { current: number | null; previous: number | null }>; marketing: Record<string, unknown>; funnelCohort: { stages: Array<{ key: string; count: number | null }> }; appliedCaveat: { text: string } };
    for (const k of Object.keys(page.scorecard.kpis) as Array<keyof typeof page.scorecard.kpis>) {
      expect(d.kpis[k].current, k).toBe(page.scorecard.kpis[k].current);
      expect(d.kpis[k].previous, k).toBe(page.scorecard.kpis[k].previous);
    }
    expect(d.marketing.paidCacCents).toBe(page.scorecard.marketing.paidCacCents);
    expect(d.marketing.roas).toBe(page.scorecard.marketing.roas);
    expect(d.funnelCohort.stages.map((s) => s.count)).toEqual(page.scorecard.cohort.funnel.stages.map((s) => (s.withheld ? null : s.count)));
    expect(d.appliedCaveat.text).toBe(page.scorecard.appliedCaveat.text);
    expect(tool.range).toEqual({ start: page.range.start, end: page.range.end, label: `${page.range.presetLabel} · ${page.range.resolvedLabel}` });
    expect(tool.currency).toBe(page.money.currency);
    expect(tool.ref).toBe('r1');
    expect(tool.freshness).toEqual(freshness);
  });

  it('get_funnel, get_campaigns, get_revenue and compare_periods match the same engine call', async () => {
    const page = await getScorecard({ range: 'last_month', compare: 'previous_period' });
    const R = { preset: 'last_month', start: null, end: null };
    const funnel = (await runAnalystTool('get_funnel', { range: R, mode: 'cohort' }, ctx('r2'))).data as { stages: Array<{ count: number | null; conversionFromPrevious: number | null }>; conversions: unknown[] };
    expect(funnel.stages.map((s) => s.conversionFromPrevious)).toEqual(page.scorecard.cohort.funnel.stages.map((s) => s.conversionFromPrevious));
    const camps = (await runAnalystTool('get_campaigns', { range: R, compare: 'previous_period' }, ctx('r3'))).data as { campaigns: Array<{ campaign: string; spendCents: number; trackedApplied: number; roas: number | null }> };
    expect(camps.campaigns.map((c) => [c.campaign, c.spendCents, c.trackedApplied, c.roas])).toEqual(page.ads.campaigns.map((c) => [c.campaignName, c.spendCents, c.tracked.applied, c.roas]));
    const rev = (await runAnalystTool('get_revenue', { range: R }, ctx('r4'))).data as { collectedCents: number; mrrCents: number; failedCount: number };
    expect([rev.collectedCents, rev.mrrCents, rev.failedCount]).toEqual([page.revenue.collectedCents, page.revenue.mrrCents, page.revenue.failedCount]);
    const cmp = (await runAnalystTool('compare_periods', { range: R, against: { preset: null, start: page.comparison.range!.start, end: page.comparison.range!.end } }, ctx('r5'))).data as { kpis: Array<{ kpi: string; current: number | null; against: number | null }> };
    const enr = cmp.kpis.find((k) => k.kpi === 'enrollments')!;
    expect([enr.current, enr.against]).toEqual([page.scorecard.kpis.enrollments.current, page.scorecard.kpis.enrollments.previous]);
  });

  it('get_trend, get_metric, list_clients, get_client, get_stage_people, get_todo, get_notes, get_data_health', async () => {
    const trend = (await runAnalystTool('get_trend', { metric: 'enrollments', window: '3m' }, ctx('r6'))).data as { spanValue: number | null; current: Array<{ value: number | null }> };
    const t = (await getMetricTrend('enrollments', { window: '3m' }))!;
    expect(trend.spanValue).toBe(t.spanValue);
    expect(trend.current.map((p) => p.value)).toEqual(t.current.map((p) => p.value));

    const tz = await getTimezone();
    const range = rangeFromParams({ range: 'last_week' }, todayInTimezone(tz));
    const metric = (await runAnalystTool('get_metric', { key: 'blended_cac', range: LAST_WEEK, mode: 'period' }, ctx('r7'))).data as { value: number | null; worked: string };
    const worked = glossaryEntry('blended_cac')!.worked(await loadMetricsInput({ start: range.start, end: range.end, timezone: tz }), range);
    expect(metric.value).toBe(worked.value);
    expect(metric.worked).toBe(worked.text);

    const clients = (await runAnalystTool('list_clients', { query: null, attribution: 'paid', from: null, to: null, page: 1 }, ctx('r8'))).data as { total: number; rows: Array<{ id: string; name: string }>; dateBasis: string };
    const page = await listClients({ attribution: 'paid', limit: 25, offset: 0 });
    expect(clients.total).toBe(page.total);
    expect(clients.rows.map((r) => r.id)).toEqual(page.rows.map((r) => r.id));
    expect(clients.dateBasis).toContain('application date');

    const client = (await runAnalystTool('get_client', { id: page.rows[0].id }, ctx('r9'))).data as { name: string; stage: string | null; timeline: unknown[] };
    const profile = (await getClientProfile(page.rows[0].id))!;
    expect(client.name).toBe(profile.name);
    expect(client.stage).toBe(profile.stageName);
    expect(client.timeline.length).toBe(Math.min(60, profile.timeline.length));

    const people = (await runAnalystTool('get_stage_people', { range: LAST_WEEK, stage: 'applied', mode: 'period', page: 1 }, ctx('r10'))).data as { total: number; rows: Array<{ name: string; link: string }> };
    const sc = await getScorecard({ range: 'last_week', compare: 'off' });
    expect(people.total).toBe(sc.scorecard.funnel.stages[0].contactIds.length);
    if (people.rows.length) expect(people.rows[0].link).toMatch(/^\/clients\//);

    const todo = (await runAnalystTool('get_todo', {}, ctx('r11'))).data as { total: number };
    expect(todo.total).toBe((await getTodoBuckets()).buckets.total);

    const notes = (await runAnalystTool('get_notes', {}, ctx('r12'))).data as { withheld: string | null; decisions: unknown[] };
    expect(notes.withheld).toBe('Withheld until filled: CAC payback, pace to target, funnel-leak $');
    expect(notes.decisions.length).toBeGreaterThan(5);

    const health = (await runAnalystTool('get_data_health', { range: LAST_WEEK }, ctx('r13'))).data as { appliedCaveat: { text: string; definitionUnderReview: boolean }; freshness: Freshness; spendAdviceAllowed: boolean; withheld: string | null };
    expect(health.appliedCaveat.text).toBe(sc.scorecard.appliedCaveat.text);
    expect(health.appliedCaveat.definitionUnderReview).toBe(true);
    expect(health.freshness).toEqual(freshness);
    expect(health.spendAdviceAllowed).toBe(true);
  });

  it('no tool result contains an email address or a phone number', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_scorecard', { range: LAST_WEEK, compare: 'off' }],
      ['get_funnel', { range: LAST_WEEK, mode: 'period' }],
      ['get_stage_people', { range: { preset: 'last_month', start: null, end: null }, stage: 'enrolled', mode: 'cohort', page: 1 }],
      ['get_payments', { range: { preset: 'last_month', start: null, end: null }, paymentClass: null, status: null, page: 1 }],
      ['list_clients', { query: null, attribution: null, from: null, to: null, page: 1 }],
      ['get_todo', {}],
      ['get_data_health', { range: LAST_WEEK }],
    ];
    const clients = await listClients({ limit: 3 });
    calls.push(['get_client', { id: clients.rows[0].id }]);
    for (const [name, input] of calls) {
      const json = JSON.stringify(await runAnalystTool(name, input, ctx('rX')));
      expect(json, name).not.toMatch(/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i);
      expect(json, name).not.toMatch(/\+1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\(\d{3}\) ?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/);
      expect(json, name).not.toMatch(/"(email|phone)"/);
    }
  });

  it('invalid input or a failing function returns an error RESULT, never a throw and never an empty success', async () => {
    expect(await runAnalystTool('get_metric', { key: 'nope', range: LAST_WEEK, mode: 'period' }, ctx('r20'))).toMatchObject({ ref: 'r20', data: null, error: 'unknown metric key "nope"' });
    expect(await runAnalystTool('get_client', { id: 'missing' }, ctx('r21'))).toMatchObject({ data: null, error: 'no client with id "missing"' });
    expect(await runAnalystTool('no_such_tool', {}, ctx('r22'))).toMatchObject({ data: null, error: 'unknown tool "no_such_tool"' });
    expect(await runAnalystTool('get_trend', { metric: 'enrollments', window: 'bogus' }, ctx('r23'))).toMatchObject({ error: expect.stringMatching(/get_trend failed|unknown/) });
    values.set('r1:data.marketing.spendCents', 100_000);
    values.set('r1:data.marketing.enrollments', 4);
    expect((await runAnalystTool('calculate', { op: 'per_unit', a: { ref: 'r1:data.marketing.spendCents', value: null }, b: { ref: 'r1:data.marketing.enrollments', value: null } }, ctx('r24'))).data).toMatchObject({ value: 25_000, unit: 'cents', text: '$250' });
    expect(await runAnalystTool('calculate', { op: 'sum', a: { ref: 'r1:data.x.rate', value: null }, b: { ref: 'r1:data.y.rate', value: null } }, ctx('r25'))).toMatchObject({ data: null, error: expect.stringMatching(/unknown ref/) });
  });

  it('the runtime tool list is the same object the wire contract sorts', () => {
    expect(ANALYST_TOOLS.map((t) => t.definition.name)).toEqual(ANALYST_TOOL_DEFINITIONS.map((t) => t.name));
  });
});
