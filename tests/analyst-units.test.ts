/**
 * Units are a contract (design review 2026-10-03, A1): every numeric leaf of every tool result resolves a
 * unit by the Cents suffix, a declared `unit`, the kpis.<metric> parent or the explicit catalog — never a
 * regex guess — and the sweep over all 15 tools fails on an `unknown`. The one formatter renders from the
 * ledger entry, sign-free.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Ledger, ledgerEntries } from '@/lib/analyst/ledger';
import { resolveUnit, UNIT_CATALOG } from '@/lib/analyst/units';
import { renderRef } from '@/lib/analyst/render';
import { calculateBatch, runAnalystTool, type Freshness, type ToolContext } from '@/lib/analyst/tools';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';

const T0 = '2026-10-01T00:00:00.000Z';

describe('resolveUnit — the four rules, in order', () => {
  it('Cents suffix → cents; declared unit → the generic value keys; kpis.<metric> parent; catalog by name; else unknown', () => {
    expect(resolveUnit('data.marketing.spendCents', null)).toMatchObject({ unit: 'cents', by: 'suffix' });
    expect(resolveUnit('data.kpis[3].current', 'cents')).toMatchObject({ unit: 'cents', by: 'declared' });
    expect(resolveUnit('data.trend.current[2].value', 'pct')).toMatchObject({ unit: 'ratio', reading: 'pct', by: 'declared' });
    expect(resolveUnit('data.kpis.paidCacCents.current', null)).toMatchObject({ unit: 'cents', by: 'parent' });
    expect(resolveUnit('data.kpis.roas.previous', null)).toMatchObject({ unit: 'ratio', reading: 'multiple', by: 'parent' });
    expect(resolveUnit('data.kpis.enrollments.abs', null)).toMatchObject({ unit: 'count', by: 'parent' });
    expect(resolveUnit('data.kpis.paidCacCents.pct', null)).toMatchObject({ unit: 'ratio', reading: 'pct', by: 'catalog' }); // a delta's pct is a share
    expect(resolveUnit('data.sources[0].appliedToEnrolled', null)).toMatchObject({ unit: 'ratio', reading: 'pct' }); // the regex read this as a COUNT
    expect(resolveUnit('data.fxRate', null)).toMatchObject({ unit: 'number' }); // the regex read this as a ratio
    expect(resolveUnit('data.timeInStageHours', null)).toMatchObject({ unit: 'hours' });
    expect(resolveUnit('data.results[0].value', null)).toMatchObject({ unit: 'unknown', by: 'unknown' }); // a generic key with nothing declared and an index parent
    expect(resolveUnit('data.e.roas.current', null)).toMatchObject({ unit: 'ratio', reading: 'multiple', by: 'parent' });
    expect(resolveUnit('data.somethingNew', null)).toMatchObject({ unit: 'unknown', by: 'unknown' });
    expect(Object.values(UNIT_CATALOG).every((u) => ['cents', 'count', 'pct', 'multiple', 'ratio', 'hours', 'number'].includes(u))).toBe(true);
  });
});

describe('ledger entries carry unit, reading, delta and metric', () => {
  it('from declared units, kpis parents, row kpi / metric fields and delta rows', () => {
    const data = {
      kpis: { paidCacCents: { current: 92_442, previous: 184_884, abs: -92_442, pct: -0.5 }, roas: { current: 2.0871 } },
      rows: [{ kpi: 'enrollments', unit: 'count', current: 8, against: 4, abs: 4, pct: 1 }],
      trend: { metric: 'paid_cac', unit: 'cents', spanValue: 100, current: [{ value: 50 }] },
      results: [{ label: 'd', op: 'difference', unit: 'cents', delta: true, metric: 'paidCacCents', value: -1000 }],
      coverage: { unit: 'new clients', used: 2, total: 3 },
      zone: { timeInStageHours: 41.6 },
    };
    const by = Object.fromEntries(ledgerEntries('r1', data, T0, 'CAD').map((e) => [e.ref.slice(8), e]));
    expect(by['kpis.paidCacCents.current']).toMatchObject({ unit: 'cents', delta: false, metric: 'paidCacCents' });
    expect(by['kpis.paidCacCents.abs']).toMatchObject({ unit: 'cents', delta: true, metric: 'paidCacCents' });
    expect(by['kpis.paidCacCents.pct']).toMatchObject({ unit: 'ratio', reading: 'pct', delta: true, metric: 'paidCacCents' });
    expect(by['kpis.roas.current']).toMatchObject({ unit: 'ratio', reading: 'multiple', delta: false, metric: 'roas' });
    expect(by['rows[0].against']).toMatchObject({ unit: 'count', delta: false, metric: 'enrollments' });
    expect(by['rows[0].pct']).toMatchObject({ unit: 'ratio', reading: 'pct', delta: true, metric: 'enrollments' });
    expect(by['trend.current[0].value']).toMatchObject({ unit: 'cents', metric: 'paid_cac', delta: false });
    expect(by['results[0].value']).toMatchObject({ unit: 'cents', delta: true, metric: 'paidCacCents' });
    expect(by['coverage.used']).toMatchObject({ unit: 'count' }); // "new clients" is not a unit declaration
    expect(by['zone.timeInStageHours']).toMatchObject({ unit: 'hours' });
    const ledger = new Ledger();
    ledger.add('r1', data, T0, 'CAD');
    expect(ledger.info('r1:data.results[0].value')).toEqual({ unit: 'cents', currency: 'CAD', metric: 'paidCacCents', delta: true });
    expect(ledger.info('r1:data.zone.timeInStageHours')?.unit).toBe('number');
  });
});

describe('renderRef — the one formatter, sign-free', () => {
  const e = (over: Partial<Parameters<typeof renderRef>[0]>) => ({ ref: 'r', value: 0, unit: 'number' as const, reading: null, fetchedAt: T0, currency: 'CAD', delta: false, metric: null, ...over });
  it('cents, shares, multiples, counts, hours, plain numbers, nulls and hints', () => {
    expect(renderRef(e({ unit: 'cents', value: 369_768 }))).toBe('$3,697.68 CAD');
    expect(renderRef(e({ unit: 'cents', value: -493_750 }))).toBe('$4,937.50 CAD'); // sign-free
    expect(renderRef(e({ unit: 'cents', value: 25_000, currency: 'USD' }))).toBe('$250 USD');
    expect(renderRef(e({ unit: 'cents', value: 1_975_000 }), 'k')).toBe('$19.8k CAD');
    expect(renderRef(e({ unit: 'cents', value: 197_500 }), 'k')).toBe('$1,975 CAD'); // compact only from $10k
    expect(renderRef(e({ unit: 'ratio', reading: 'pct', value: 0.4123 }))).toBe('41.2%');
    expect(renderRef(e({ unit: 'ratio', reading: 'pct', value: -0.5 }))).toBe('50%');
    expect(renderRef(e({ unit: 'ratio', reading: 'multiple', value: 2.0871 }))).toBe('2.1×');
    expect(renderRef(e({ unit: 'ratio', reading: 'multiple', value: 2.0871 }), '%')).toBe('208.7%');
    expect(renderRef(e({ unit: 'ratio', reading: null, value: 0.75 }))).toBe('75%');
    expect(renderRef(e({ unit: 'ratio', reading: null, value: 0.75 }), 'x')).toBe('0.8×');
    expect(renderRef(e({ unit: 'count', value: 1234 }))).toBe('1,234');
    expect(renderRef(e({ unit: 'hours', value: 41.64 }))).toBe('41.6 h');
    expect(renderRef(e({ unit: 'number', value: 1.4188 }))).toBe('1.42');
    expect(renderRef(e({ unit: 'unknown', value: 7 }))).toBe('7');
    expect(renderRef(e({ unit: 'cents', value: null }))).toBe('—');
  });
});

describe('calculate rows are tool results like any other', () => {
  it('a batch in cents: unit + delta + metric on each row; the ledger reads them; a later call keeps cents and currency', () => {
    const src = new Ledger();
    src.add('r2', { marketing: { spendCents: 1_975_000, enrollments: 4, paidEnrollments: 3 }, kpis: { paidCacCents: { current: 92_442, previous: 100_000 } } }, T0, 'CAD');
    const ref = (r: string) => ({ kind: 'ref' as const, ref: r, value: 0 });
    const rows = calculateBatch(
      [
        { label: 'blended', op: 'per_unit', a: ref('r2:data.marketing.spendCents'), b: ref('r2:data.marketing.enrollments') },
        { label: 'organic', op: 'difference', a: ref('r2:data.marketing.enrollments'), b: ref('r2:data.marketing.paidEnrollments') },
        { label: 'paid_share', op: 'ratio', a: ref('r2:data.marketing.paidEnrollments'), b: ref('r2:data.marketing.enrollments') },
        { label: 'cac_change', op: 'percent_change', a: ref('r2:data.kpis.paidCacCents.current'), b: ref('r2:data.kpis.paidCacCents.previous') },
        { label: 'roas_like', op: 'ratio', a: ref('r2:data.marketing.spendCents'), b: ref('r2:data.kpis.paidCacCents.current') },
      ],
      'r7',
      (r) => src.resolve(r),
      (r) => src.info(r),
    );
    expect(rows).toEqual([
      { label: 'blended', op: 'per_unit', ref: 'r7:data.results[0].value', value: 493_750, unit: 'cents', delta: false, metric: null, error: null },
      { label: 'organic', op: 'difference', ref: 'r7:data.results[1].value', value: 1, unit: 'count', delta: true, metric: null, error: null },
      { label: 'paid_share', op: 'ratio', ref: 'r7:data.results[2].value', value: 0.75, unit: 'pct', delta: false, metric: null, error: null },
      { label: 'cac_change', op: 'percent_change', ref: 'r7:data.results[3].value', value: -0.07558, unit: 'pct', delta: true, metric: 'paidCacCents', error: null },
      { label: 'roas_like', op: 'ratio', ref: 'r7:data.results[4].value', value: 21.364748, unit: 'multiple', delta: false, metric: null, error: null },
    ]);
    const ledger = new Ledger();
    ledger.add('r7', { results: rows, failed: 0 }, T0, 'CAD');
    expect(['r7:data.results[0].value', 'r7:data.results[1].value', 'r7:data.results[2].value', 'r7:data.results[3].value'].map((r) => ledger.get(r)?.unit)).toEqual(['cents', 'count', 'ratio', 'ratio']);
    expect(renderRef(ledger.get('r7:data.results[0].value')!)).toBe('$4,937.50 CAD'); // the recorded false flag, rendered by the server
    expect(renderRef(ledger.get('r7:data.results[3].value')!)).toBe('7.6%');
    expect(renderRef(ledger.get('r7:data.results[4].value')!)).toBe('21.4×');
    expect(ledger.get('r7:data.results[3].value')).toMatchObject({ delta: true, metric: 'paidCacCents' });
    const next = calculateBatch([{ label: 'again', op: 'sum', a: ref('r7:data.results[0].value'), b: { kind: 'value', ref: '', value: 100 } }], 'r8', (r) => ledger.resolve(r), (r) => ledger.info(r));
    expect(next[0]).toMatchObject({ value: 493_850, unit: 'cents' });
    expect(calculateBatch([{ label: 'x', op: 'sum', a: ref('r2:data.marketing.spendCents'), b: { kind: 'value', ref: '', value: 0 } }], 'r9', (r) => src.resolve(r))[0]).toMatchObject({ value: null, error: expect.stringMatching(/currency is unknown/) });
  });
});

describe('sweep: every numeric leaf of every tool result has a unit (demo database)', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);
  it('0 unknown across all 15 tools — a new numeric field must get a Cents suffix, a declared unit, or a catalog line', async () => {
    const freshness: Freshness = { stale: false, line: 'data fresh — test', sources: [] };
    const ctx = (ref: string): ToolContext => ({ ref, freshness, resolveRef: () => undefined });
    const R = { preset: 'last_month', start: '', end: '' };
    const lc = await runAnalystTool('list_clients', { query: '', attribution: 'any', from: '', to: '', page: 1 }, ctx('r0'));
    const id = (lc.data as { rows: Array<{ id: string }> }).rows[0].id;
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_data_health', { range: R }], ['get_scorecard', { range: R, compare: 'previous_period' }], ['get_funnel', { range: R, mode: 'cohort' }], ['get_funnel', { range: R, mode: 'period' }],
      ['get_campaigns', { range: R, compare: 'previous_period' }], ['get_revenue', { range: R }],
      ['get_trend', { metric: 'paid_cac', window: '3m' }], ['get_trend', { metric: 'roas', window: '3m' }], ['get_trend', { metric: 'enrollments', window: '3m' }], ['get_trend', { metric: 'consult_show_rate', window: '3m' }],
      ['compare_periods', { range: R, against: { preset: 'last_week', start: '', end: '' } }], ['get_notes', {}], ['get_todo', {}],
      ['get_metric', { key: 'paid_cac', range: R, mode: 'period' }], ['get_metric', { key: 'roas', range: R, mode: 'period' }], ['get_metric', { key: 'enrollments', range: R, mode: 'period' }],
      ['list_clients', { query: '', attribution: 'any', from: '', to: '', page: 1 }], ['get_client', { id }], ['get_stage_people', { range: R, stage: 'enrolled', mode: 'cohort', page: 1 }], ['get_payments', { range: R, page: 1, paymentClass: 'any', status: 'any' }],
    ];
    const unknown: string[] = [];
    for (const [name, input] of calls) {
      const r = await runAnalystTool(name, input, ctx('r1'));
      expect(r.error, `${name}: ${r.error}`).toBeUndefined();
      for (const e of ledgerEntries('r1', r.data, T0, r.currency)) if (e.unit === 'unknown' && typeof e.value === 'number') unknown.push(`${name}:${e.ref.replace(/^r1:/, '').replace(/\[\d+\]/g, '[]')}`);
    }
    expect([...new Set(unknown)]).toEqual([]);
  });
});
