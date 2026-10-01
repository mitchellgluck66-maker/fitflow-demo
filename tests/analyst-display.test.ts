/**
 * Tuning item 3 (2026-09-30): every money / ratio leaf of a tool result carries its display string, which is
 * EXACTLY what the verifier accepts for that ref — so copying it verbatim can never be flagged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { displayFor, withDisplayStrings } from '@/lib/analyst/display';
import { Ledger, ledgerEntries } from '@/lib/analyst/ledger';
import { renders, verifyAnswer } from '@/lib/analyst/verify';
import { runAnalystTool, type Freshness, type ToolContext } from '@/lib/analyst/tools';
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

describe('starter snapshot rows (item 4)', () => {
  it('instruction → fabricated assistant tool_use → tool_results + the question; refs r1, r2; a failed call is is_error', async () => {
    const { starterRows, starterMessages, STARTER_CALLS, STARTER_INSTRUCTION } = await import('@/lib/analyst/starter');
    expect(STARTER_CALLS.map((c) => c.name)).toEqual(['get_data_health', 'get_scorecard']);
    const rows = starterRows('turn-1', 'How did we do?', 'Today: 2026-09-30.\nHow did we do?', [
      { ref: 'r1', name: 'get_data_health', input: { range: { preset: 'last_week', start: '', end: '' } }, result: { ref: 'r1', freshness: { stale: false, line: 'ok', sources: [] }, range: null, currency: 'CAD', fx: '', data: { stale: false } } },
      { ref: 'r2', name: 'get_scorecard', input: { range: { preset: 'last_week', start: '', end: '' }, compare: 'previous_period' }, result: { ref: 'r2', freshness: { stale: false, line: 'ok', sources: [] }, range: null, currency: 'CAD', fx: '', data: null, error: 'boom' } },
    ]);
    expect(rows.map((r) => [r.role, r.turnId])).toEqual([['user', 'turn-1'], ['assistant', 'turn-1'], ['tool_results', 'turn-1']]);
    const [instruction, assistant, results] = starterMessages(rows) as Array<{ role: string; content: unknown }>;
    expect(instruction).toEqual({ role: 'user', content: STARTER_INSTRUCTION });
    expect(assistant).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'starter_r1', name: 'get_data_health', input: STARTER_CALLS[0].input }, { type: 'tool_use', id: 'starter_r2', name: 'get_scorecard', input: STARTER_CALLS[1].input }] });
    const blocks = results.content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(blocks[0]).toMatchObject({ tool_use_id: 'starter_r1' });
    expect(blocks[0]).not.toHaveProperty('is_error');
    expect(blocks[1]).toMatchObject({ tool_use_id: 'starter_r2', is_error: true });
    expect(blocks[2]).toEqual({ type: 'text', text: 'Today: 2026-09-30.\nHow did we do?' });
    expect(rows[2].display).toMatchObject({ starter: true, refs: ['r1', 'r2'], question: 'How did we do?' });
  });
});
