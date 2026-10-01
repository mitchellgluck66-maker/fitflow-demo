/**
 * Tuning item 3 (2026-09-30): every money / ratio leaf of a tool result carries its display string, which is
 * EXACTLY what the verifier accepts for that ref — so copying it verbatim can never be flagged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { displayFor, withDisplayStrings } from '@/lib/analyst/display';
import { Ledger, ledgerEntries } from '@/lib/analyst/ledger';
import { renders, verifyAnswer } from '@/lib/analyst/verify';
import { runAnalystTool, type Freshness, type ToolContext, type ToolResult } from '@/lib/analyst/tools';
import { runMigrations } from '@/db/migrate';
import { seedDemo } from '@/db/seed-demo';
import type { Answer } from '@/lib/analyst/schema';

const SAMPLE = {
  kpis: { enrollments: { current: 8, previous: 4, abs: 4, pct: 1 }, paidCacCents: { current: 92_442, previous: 184_884, pct: -0.5 }, roas: { current: 2.0871, previous: 0.94 } },
  marketing: { spendCents: 369_768, paidEnrollments: 4, ltvToCac: 11.0294, costPerRoadmapCents: 25_000, ltvCoverage: { used: 21, total: 24, partial: true, note: 'x' } },
  showRates: [{ type: 'Consult', rate: 0.6123, coverage: 0.95, showed: 6 }],
  stages: [{ key: 'applied', count: 52, conversionFromPrevious: 0.1346, costPerCents: -1234 }],
  frequency: 2.37,
  timeInStageHours: 41.6,
  nested: { already: 1, alreadyText: 'keep me', deltaCents: 0 },
};

describe('withDisplayStrings', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = withDisplayStrings(SAMPLE as unknown, 'CAD') as any;
  it('adds <key>Text beside money and ratio leaves only; counts, hours and plain numbers get none; paths and values are unchanged', () => {
    expect(out).toMatchObject({
      kpis: {
        enrollments: { current: 8, previous: 4, abs: 4, pct: 1, pctText: '100.0%' },
        paidCacCents: { current: 92_442, currentText: '$924.42 CAD', previous: 184_884, previousText: '$1,848.84 CAD', pct: -0.5, pctText: '50.0%' },
        roas: { current: 2.0871, currentText: '2.1×', previous: 0.94, previousText: '0.9×' },
      },
      marketing: { spendCents: 369_768, spendCentsText: '$3,697.68 CAD', ltvToCac: 11.0294, ltvToCacText: '11.0×', costPerRoadmapCents: 25_000, costPerRoadmapCentsText: '$250 CAD' },
      showRates: [{ rate: 0.6123, rateText: '61.2%', coverage: 0.95, coverageText: '95.0%' }],
      stages: [{ count: 52, conversionFromPrevious: 0.1346, conversionFromPreviousText: '13.5%', costPerCents: -1234, costPerCentsText: '$12.34 CAD' }],
      frequency: 2.37,
      nested: { already: 1, alreadyText: 'keep me', deltaCents: 0, deltaCentsText: '$0 CAD' },
    });
    for (const k of ['enrollmentsText', 'currentText', 'absText']) expect(JSON.stringify(out.kpis.enrollments)).not.toContain(`"${k}"`);
    expect(out.marketing).not.toHaveProperty('paidEnrollmentsText');
    expect(out.marketing.ltvCoverage).not.toHaveProperty('usedText');
    expect(out).not.toHaveProperty('timeInStageHoursText');
    expect(out).not.toHaveProperty('frequencyText'); // the ledger reads a bare `frequency` as a plain number
    expect(out.showRates[0]).not.toHaveProperty('showedText');
    // The ledger sees the same numeric refs as before (strings are not entries).
    const before = ledgerEntries('r1', SAMPLE, 't', 'CAD').map((e) => e.ref);
    expect(ledgerEntries('r1', out, 't', 'CAD').map((e) => e.ref)).toEqual(before);
    expect(withDisplayStrings(null, 'CAD')).toBeNull();
    expect(displayFor('data.x.spendCents', 150_000, 'USD')).toBe('$1,500 USD');
  });

  it('every display string is accepted by the verifier for its own ref — copy verbatim, never flagged', () => {
    const ledger = new Ledger();
    ledger.add('r1', out, '2026-09-30T10:00:00.000Z', 'CAD');
    const pairs: Array<[string, string]> = [];
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k.endsWith('Text') && typeof x === 'string' && k !== 'alreadyText') pairs.push([`${path}.${k.slice(0, -4)}`, x]);
        walk(x, `${path}.${k}`);
      }
    };
    walk(out, 'data');
    expect(pairs.length).toBeGreaterThan(10);
    for (const [path, text] of pairs) expect(renders(ledger.get(`r1:${path}`)!, text), `${path} → ${text}`).toBe(true);
    // A ref to the Text field resolves to the number beside it.
    expect(ledger.get('r1:data.marketing.spendCentsText')?.value).toBe(369_768);
    const answer: Answer = {
      kind: 'answer',
      headline: { text: 'Spend was $3,697.68 CAD.', ref: 'r1:data.marketing.spendCentsText' },
      sections: [{ key: 'what_happened', body_md: 'Paid CAC fell to **$924.42 CAD** (down 50.0%); ROAS 2.1×.', numbers: [{ text: '$924.42 CAD', ref: 'r1:data.kpis.paidCacCents.current' }, { text: '50.0%', ref: 'r1:data.kpis.paidCacCents.pct' }, { text: '2.1×', ref: 'r1:data.kpis.roas.current' }] }],
      actions: [],
      findings: [],
      note_proposals: [],
      clarifying_question: '',
    };
    expect(verifyAnswer(answer, ledger)).toMatchObject({ ok: true, verified: 4 });
  });
});

describe('through the real tools (demo database)', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);
  const freshness: Freshness = { stale: false, line: 'data fresh — test', sources: [] };
  const ctx = (ref: string): ToolContext => ({ ref, freshness, resolveRef: () => undefined });
  it('get_scorecard carries spendCentsText and every Text string renders its ref', async () => {
    const r = await runAnalystTool('get_scorecard', { range: { preset: 'last_month', start: '', end: '' }, compare: 'previous_period' }, ctx('r1'));
    expect(r.error).toBeUndefined();
    const d = r.data as { marketing: { spendCents: number; spendCentsText: string } };
    expect(d.marketing.spendCentsText).toMatch(/^\$[\d,]+(\.\d{2})? CAD$/);
    const ledger = new Ledger();
    ledger.add('r1', r.data, '2026-09-30T10:00:00.000Z', r.currency);
    let checked = 0;
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k.endsWith('Text') && typeof x === 'string' && typeof (v as Record<string, unknown>)[k.slice(0, -4)] === 'number') {
          checked += 1;
          expect(renders(ledger.get(`r1:${path}.${k.slice(0, -4)}`)!, x), `${path}.${k}`).toBe(true);
        }
        walk(x, `${path}.${k}`);
      }
    };
    walk(r.data, 'data');
    expect(checked).toBeGreaterThan(20);
  });
});

describe('starter snapshot row (item 4)', () => {
  it('ONE user message: instruction → a text block per result (prefix + ToolResult JSON) → the question; refs r1, r2; no fabricated assistant turn', async () => {
    const { starterRows, starterMessages, STARTER_CALLS, STARTER_INSTRUCTION, SNAPSHOT_PREFIX } = await import('@/lib/analyst/starter');
    const { ledgerFromLog } = await import('@/lib/analyst/run');
    expect(STARTER_CALLS.map((c) => c.name)).toEqual(['get_data_health', 'get_scorecard']);
    const r1: ToolResult = { ref: 'r1', freshness: { stale: false, line: 'ok', sources: [] }, range: null, currency: 'CAD', fx: '', data: { stale: false, count: 3 } };
    const r2: ToolResult = { ref: 'r2', freshness: { stale: false, line: 'ok', sources: [] }, range: null, currency: 'CAD', fx: '', data: null, error: 'boom' };
    const rows = starterRows('turn-1', 'How did we do?', 'Today: 2026-09-30.\nHow did we do?', [
      { ref: 'r1', name: 'get_data_health', input: STARTER_CALLS[0].input, result: r1 },
      { ref: 'r2', name: 'get_scorecard', input: STARTER_CALLS[1].input, result: r2 },
    ]);
    expect(rows.map((r) => [r.role, r.turnId])).toEqual([['tool_results', 'turn-1']]);
    const [message] = starterMessages(rows) as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(message.role).toBe('user');
    expect(message.content.map((b) => b.type)).toEqual(['text', 'text', 'text', 'text']);
    expect(message.content[0].text).toBe(STARTER_INSTRUCTION);
    expect(message.content[1].text).toBe(`${SNAPSHOT_PREFIX}${JSON.stringify(r1)}`);
    expect(message.content[2].text).toBe(`${SNAPSHOT_PREFIX}${JSON.stringify(r2)}`);
    expect(message.content[3].text).toBe('Today: 2026-09-30.\nHow did we do?');
    expect(rows[0].display).toMatchObject({ starter: true, refs: ['r1', 'r2'], question: 'How did we do?' });
    // The ledger reads the snapshot blocks like tool results: r1's leaves are refs, the next call is r3.
    const log = ledgerFromLog([{ id: 'm1', threadId: 't', seq: 1, turnId: 'turn-1', role: 'tool_results', apiJson: rows[0].apiJson, display: rows[0].display ?? null, createdAt: new Date('2026-09-30T10:00:00Z') }]);
    expect(log.calls).toBe(2);
    expect(log.ledger.resolve('r1:data.count')).toBe(3);
  });
});

describe('units reach the verifier for every ref (2026-10-01: "$4,937.50 CAD" vs results[16].value = 493750 was flagged)', () => {
  it('a batch calculate in cents: the row carries unit + valueText, the ledger reads the unit, and the copied string verifies', async () => {
    const { calculateBatch } = await import('@/lib/analyst/tools');
    const src = new Ledger();
    src.add('r2', { marketing: { spendCents: 1_975_000, enrollments: 4, paidEnrollments: 3 }, kpis: { roas: { current: 2.0871 } } }, '2026-10-01T00:00:00.000Z', 'CAD');
    const ref = (r: string) => ({ kind: 'ref' as const, ref: r, value: 0 });
    const rows = calculateBatch(
      [
        { label: 'blended', op: 'per_unit', a: ref('r2:data.marketing.spendCents'), b: ref('r2:data.marketing.enrollments') },
        { label: 'organic', op: 'difference', a: ref('r2:data.marketing.enrollments'), b: ref('r2:data.marketing.paidEnrollments') },
        { label: 'paid_share', op: 'ratio', a: ref('r2:data.marketing.paidEnrollments'), b: ref('r2:data.marketing.enrollments') },
        { label: 'double', op: 'product', a: ref('#blended'), b: { kind: 'value', ref: '', value: 2 } },
      ],
      'r7',
      (r) => src.resolve(r),
      (r) => src.info(r),
    );
    expect(rows).toEqual([
      { label: 'blended', op: 'per_unit', ref: 'r7:data.results[0].value', value: 493_750, unit: 'cents', valueText: '$4,937.50 CAD', error: null },
      { label: 'organic', op: 'difference', ref: 'r7:data.results[1].value', value: 1, unit: 'count', valueText: '1', error: null },
      { label: 'paid_share', op: 'ratio', ref: 'r7:data.results[2].value', value: 0.75, unit: 'ratio', valueText: '75.0%', valueMultipleText: '0.8×', error: null },
      { label: 'double', op: 'product', ref: 'r7:data.results[3].value', value: 987_500, unit: 'cents', valueText: '$9,875 CAD', error: null },
    ]);
    // Stored as a tool result, the ledger holds each row to ITS unit — not "number".
    const ledger = new Ledger();
    ledger.add('r7', withDisplayStrings({ results: rows, failed: 0 }, 'CAD'), '2026-10-01T00:00:00.000Z', 'CAD');
    expect(['r7:data.results[0].value', 'r7:data.results[1].value', 'r7:data.results[2].value', 'r7:data.results[3].value'].map((r) => ledger.get(r)?.unit)).toEqual(['cents', 'count', 'ratio', 'cents']);
    expect(renders(ledger.get('r7:data.results[0].value')!, '$4,937.50 CAD')).toBe(true); // the false flag
    expect(renders(ledger.get('r7:data.results[0].value')!, '493750')).toBe(false);
    expect(renders(ledger.get('r7:data.results[2].value')!, '75.0%')).toBe(true);
    expect(renders(ledger.get('r7:data.results[2].value')!, '0.8×')).toBe(true);
    // A LATER calculate call reads the row with its unit and currency (the loop passes ledger.info).
    const next = calculateBatch([{ label: 'again', op: 'sum', a: ref('r7:data.results[0].value'), b: ref('r7:data.results[3].value') }], 'r8', (r) => ledger.resolve(r), (r) => ledger.info(r));
    expect(next[0]).toMatchObject({ value: 1_481_250, unit: 'cents', valueText: '$14,812.50 CAD' });
    // Money with no known currency is an error row, never "$… CAD" by default.
    expect(calculateBatch([{ label: 'x', op: 'sum', a: ref('r2:data.marketing.spendCents'), b: { kind: 'value', ref: '', value: 0 } }], 'r9', (r) => src.resolve(r))[0]).toMatchObject({ value: null, error: expect.stringMatching(/currency is unknown/) });
  });

  it('a declared `unit` gives generic value keys their unit (compare_periods rows, trend points, conversions); names still win', () => {
    const data = {
      kpis: [{ kpi: 'paidCacCents', unit: 'cents', current: 92_442, against: 184_884, abs: -92_442, pct: -0.5 }, { kpi: 'roas', unit: 'ratio', current: 2.0871, against: 0.94, abs: 1.1471, pct: 1.22 }, { kpi: 'enrollments', unit: 'count', current: 8, against: 4, abs: 4, pct: 1 }],
      trend: { unit: 'pct', spanValue: 0.4123, current: [{ label: 'w1', value: 0.5 }], spendCents: 100 },
      conversions: [{ from: 'applied', to: 'consult_booked', unit: 'pct', current: 0.7, baseline: 0.647 }],
      coverage: { unit: 'new clients', used: 2, total: 3 },
    };
    const units = Object.fromEntries(ledgerEntries('r1', data, 't', 'CAD').map((e) => [e.ref.slice(8), e.unit]));
    expect(units).toMatchObject({
      'kpis[0].current': 'cents', 'kpis[0].against': 'cents', 'kpis[0].abs': 'cents', 'kpis[0].pct': 'ratio',
      'kpis[1].current': 'ratio', 'kpis[2].current': 'count', 'kpis[2].abs': 'count',
      'trend.spanValue': 'ratio', 'trend.current[0].value': 'ratio', 'trend.spendCents': 'cents',
      'conversions[0].current': 'ratio', 'conversions[0].baseline': 'ratio',
      'coverage.used': 'number', // "new clients" is not a unit declaration
    });
    const out = withDisplayStrings(data, 'CAD') as unknown as { kpis: Array<Record<string, unknown>>; trend: Record<string, unknown>; conversions: Array<Record<string, unknown>> };
    expect(out.kpis[0]).toMatchObject({ currentText: '$924.42 CAD', againstText: '$1,848.84 CAD', absText: '$924.42 CAD', pctText: '50.0%' });
    expect(out.kpis[1]).toMatchObject({ currentText: '2.1×', pctText: '122.0%' });
    expect(out.kpis[2]).not.toHaveProperty('currentText');
    expect(out.trend).toMatchObject({ spanValueText: '41.2%' });
    expect(out.conversions[0]).toMatchObject({ currentText: '70.0%', baselineText: '64.7%' });
  });
});

describe('sweep: no unit-less ref reaches the verifier (every tool, demo database)', () => {
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
  }, 120_000);
  /** Leaf keys that ARE plain integers / identifiers — a new numeric field must get a unit by name, a declared `unit`, or be added here on purpose. */
  const PLAIN = new Set(['used', 'trackedConsults', 'trackedRoadmaps', 'dropOff', 'cancelled', 'noShow', 'past', 'activeSubscriptions', 'paymentsInPeriod', 'otherPipelines', 'withoutFormRecord', 'applicantsWithoutDate', 'frequency', 'previousLeads', 'daysWaiting', 'daysInStage', 'unsupportedMoneyRows', 'appliedFromMove', 'candidate', 'unresolved', 'sampleExcluded', 'rolling7', 'meta', 'fitflow', 'refundCount', 'failedLaterPaid', 'linkClicks', 'landingPageViews', 'platformLeads']);
  it('every numeric leaf of every tool result has a unit, or is a known plain count', async () => {
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
    const unitless: string[] = [];
    for (const [name, input] of calls) {
      const r = await runAnalystTool(name, input, ctx('r1'));
      expect(r.error, `${name}: ${r.error}`).toBeUndefined();
      for (const e of ledgerEntries('r1', r.data, 't', r.currency)) {
        if (e.unit !== 'number' || typeof e.value !== 'number') continue;
        const key = e.ref.split(/[.[]/).filter(Boolean).pop()!.replace(/\]$/, '');
        if (!PLAIN.has(key)) unitless.push(`${name}:${e.ref.replace(/^r1:/, '').replace(/\[\d+\]/g, '[]')}`);
      }
    }
    expect([...new Set(unitless)]).toEqual([]);
  });
});
