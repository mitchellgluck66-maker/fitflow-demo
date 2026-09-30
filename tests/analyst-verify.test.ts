/**
 * Answer schema, ledger and verifier (Analyst plan item 6): a number is shown
 * only with a ref that equals the tool-result value under its unit's rendering.
 */
import { describe, it, expect } from 'vitest';
import { Ledger, ledgerEntries, unitForPath } from '@/lib/analyst/ledger';
import { isExemptContext, renders, tokens, verifyAnswer, repairMessage } from '@/lib/analyst/verify';
import { ANSWER_SCHEMA, AnswerSchema, checkStructure, expectedSections, SECTION_KEYS, type Answer } from '@/lib/analyst/schema';
import { findUnsupportedKeywords } from '@/lib/anthropic/strictSchema';

const T0 = '2026-09-30T10:00:00.000Z';
const ledger = new Ledger();
ledger.add(
  'r1',
  {
    kpis: { enrollments: { current: 8, previous: 4, abs: 4, pct: 1 }, paidCacCents: { current: 92_442, previous: 184_884, pct: -0.5 }, roas: { current: 2.0871, previous: 0.94 } },
    marketing: { spendCents: 369_768, paidEnrollments: 4, ltvToCac: null },
    showRates: [{ type: 'Consult', rate: 0.6123, showed: 6, noShow: 4 }],
    stages: [{ key: 'applied', count: 52 }, { key: 'consult_booked', count: 7, conversionFromPrevious: 0.1346 }],
    frequency: 2.37,
    timeInStageHours: 41.6,
  },
  T0,
  'CAD',
);

const base = (over: Partial<Answer> = {}): Answer => ({
  kind: 'answer',
  headline: { text: 'Enrollments doubled to 8 last week.', ref: 'r1:data.kpis.enrollments.current' },
  sections: [],
  actions: [],
  findings: [],
  note_proposals: [],
  clarifying_question: '',
  ...over,
});

describe('schema', () => {
  it('is strict-compatible, every field required, and the zod schema accepts a full answer', () => {
    expect(findUnsupportedKeywords(ANSWER_SCHEMA as unknown as Record<string, unknown>)).toEqual([]);
    expect(AnswerSchema.safeParse(base()).success).toBe(true);
    expect(SECTION_KEYS.length).toBe(16);
  });
  it('checkStructure enforces the kind\'s sections and order', () => {
    expect(checkStructure(base({ sections: [{ key: 'what_happened', body_md: 'x', numbers: [] }, { key: 'do_this', body_md: 'y', numbers: [] }] }))).toBeNull();
    expect(checkStructure(base({ sections: [{ key: 'do_this', body_md: 'x', numbers: [] }, { key: 'why', body_md: 'y', numbers: [] }] }))).toMatch(/order/);
    expect(checkStructure(base({ sections: [] }))).toMatch(/at least one section/);
    expect(checkStructure(base({ sections: [{ key: 'what_it_is', body_md: 'x', numbers: [] }] }))).toMatch(/may only use/);
    expect(checkStructure(base({ kind: 'explain', sections: expectedSections('explain').keys.map((key) => ({ key, body_md: 'x', numbers: [] })) }))).toBeNull();
    expect(checkStructure(base({ kind: 'explain', sections: [{ key: 'what_it_is', body_md: 'x', numbers: [] }] }))).toMatch(/exactly the sections/);
    expect(checkStructure(base({ kind: 'clarify', headline: { text: 'Which period?', ref: '' }, clarifying_question: 'Which period do you mean?' }))).toBeNull();
    expect(checkStructure(base({ kind: 'clarify', headline: { text: 'x', ref: '' } }))).toMatch(/clarifying_question/);
    expect(checkStructure(base({ sections: [{ key: 'why', body_md: '   ', numbers: [] }] }))).toMatch(/empty/);
  });
});

describe('ledger', () => {
  it('lists every numeric leaf with a unit inferred from the path; nulls are kept as withheld', () => {
    const entries = ledgerEntries('r9', { a: { spendCents: 5 }, b: [{ rate: 0.5 }, { count: 3 }], c: null, d: 'text', e: { roas: { current: 2 } } }, T0, 'CAD');
    expect(entries.map((e) => [e.ref, e.value, e.unit])).toEqual([
      ['r9:data.a.spendCents', 5, 'cents'],
      ['r9:data.b[0].rate', 0.5, 'ratio'],
      ['r9:data.b[1].count', 3, 'count'],
      ['r9:data.c', null, 'number'],
      ['r9:data.e.roas.current', 2, 'ratio'],
    ]);
    expect(unitForPath('data.kpis.paidCacCents.current')).toBe('cents');
    expect(unitForPath('data.kpis.enrollments.pct')).toBe('ratio');
    expect(unitForPath('data.kpis.enrollments.abs')).toBe('count');
    expect(unitForPath('data.timeInStageHours')).toBe('hours');
    expect(ledger.resolve('r1:data.marketing.ltvToCac')).toBeNull();
    expect(ledger.resolve('r1:data.nope')).toBeUndefined();
  });
});

describe('renders — per-unit rounding', () => {
  const e = (ref: string) => ledger.get(ref)!;
  it('cents: whole dollars, two decimals, one-decimal k, with or without the code; never as a percent', () => {
    expect(renders(e('r1:data.marketing.spendCents'), '$3,698 CAD')).toBe(true);
    expect(renders(e('r1:data.marketing.spendCents'), '$3,697.68 CAD')).toBe(true);
    expect(renders(e('r1:data.marketing.spendCents'), '$3,697.68')).toBe(true);
    expect(renders(e('r1:data.marketing.spendCents'), '$3.7k')).toBe(true);
    expect(renders(e('r1:data.marketing.spendCents'), '$3,697')).toBe(false);
    expect(renders(e('r1:data.marketing.spendCents'), '3698%')).toBe(false);
    expect(renders(e('r1:data.kpis.paidCacCents.current'), '$924.42 CAD')).toBe(true);
    expect(renders(e('r1:data.kpis.paidCacCents.current'), '$924')).toBe(true);
  });
  it('ratios: percent (0 or 1 decimal) or a multiple (1 or 2 decimals)', () => {
    expect(renders(e('r1:data.showRates[0].rate'), '61%')).toBe(true);
    expect(renders(e('r1:data.showRates[0].rate'), '61.2%')).toBe(true);
    expect(renders(e('r1:data.showRates[0].rate'), '62%')).toBe(false);
    expect(renders(e('r1:data.kpis.roas.current'), '2.1×')).toBe(true);
    expect(renders(e('r1:data.kpis.roas.current'), '2.09x')).toBe(true);
    expect(renders(e('r1:data.kpis.roas.current'), '2.5×')).toBe(false);
    expect(renders(e('r1:data.kpis.enrollments.pct'), '100%')).toBe(true);
    expect(renders(e('r1:data.kpis.paidCacCents.pct'), '-50%')).toBe(false); // the sign is prose; "50%" is the number
    expect(renders(e('r1:data.kpis.paidCacCents.pct'), '50%')).toBe(false); // -0.5 renders as -50, not 50 — the model must cite the drop as a difference
  });
  it('counts exact; hours to one decimal', () => {
    expect(renders(e('r1:data.kpis.enrollments.current'), '8')).toBe(true);
    expect(renders(e('r1:data.kpis.enrollments.current'), '9')).toBe(false);
    expect(renders(e('r1:data.timeInStageHours'), '41.6')).toBe(true);
    expect(renders(e('r1:data.frequency'), '2.37')).toBe(true);
    expect(renders(e('r1:data.frequency'), '2.4')).toBe(true);
  });
});

describe('exempt contexts', () => {
  const check = (body: string, expected: boolean) => {
    const t = tokens(body).filter((x) => !x.money && x.suffix === '');
    expect(t.length, body).toBeGreaterThan(0);
    expect(isExemptContext(body, t[0]), body).toBe(expected);
  };
  it('dates, times, durations, ordinals, list numbers and refs pass; bare metric-like numbers do not', () => {
    check('applied on Sep 3 this year', true);
    check('the week of Sep 20–26', true);
    check('on 2026-09-30 the sync ran', true);
    check('at 14:30 local', true);
    check('over 12 weeks the pattern held', true);
    check('the trailing 8-week baseline', true);
    check('Day-3 follow-ups', true);
    check('the #1 action', true);
    check('in 2026 so far', true);
    check('3 enrollments is not a trend', false);
    check('we counted 52 people', false);
  });
});

describe('verifyAnswer', () => {
  it('accepts a fully cited answer', () => {
    const v = verifyAnswer(
      base({
        sections: [
          { key: 'what_happened', body_md: 'Enrollments reached 8 in the week of Sep 20–26, up from 4 the week before. Paid CAC fell to $924.42 CAD.', numbers: [{ text: '8', ref: 'r1:data.kpis.enrollments.current' }, { text: '4', ref: 'r1:data.kpis.enrollments.previous' }, { text: '$924.42 CAD', ref: 'r1:data.kpis.paidCacCents.current' }] },
          { key: 'so_what', body_md: 'ROAS is 2.1× on $3,698 CAD of spend.', numbers: [{ text: '2.1×', ref: 'r1:data.kpis.roas.current' }, { text: '$3,698 CAD', ref: 'r1:data.marketing.spendCents' }] },
        ],
      }),
      ledger,
    );
    expect(v).toEqual({ ok: true, flagged: [], verified: 6 });
  });
  it('rejects an uncited "3 enrollments" even though 3 is small, and a coincidental match without a ref', () => {
    const v = verifyAnswer(base({ sections: [{ key: 'what_happened', body_md: 'Only 3 enrollments came from Google. Spend was $3,698 CAD.', numbers: [] }] }), ledger);
    expect(v.ok).toBe(false);
    expect(v.flagged.map((f) => f.text)).toEqual(['3', '$3,698 CAD']);
    expect(v.flagged[0].reason).toBe('a number in the prose with no declared ref');
  });
  it('rejects a declared number that does not equal its ref, a null ref, an unknown ref, and a headline number without a ref', () => {
    const v = verifyAnswer(
      base({
        headline: { text: 'Enrollments hit 8.', ref: '' },
        sections: [{ key: 'why', body_md: 'Paid CAC was $900 CAD; LTV:CAC is 12×; spend was $5,000 CAD.', numbers: [{ text: '$900 CAD', ref: 'r1:data.kpis.paidCacCents.current' }, { text: '12×', ref: 'r1:data.marketing.ltvToCac' }, { text: '$5,000 CAD', ref: 'r7:data.nope' }] }],
      }),
      ledger,
    );
    expect(v.flagged.map((f) => f.reason)).toEqual([
      'the headline has a number but no ref',
      '"$900 CAD" does not equal r1:data.kpis.paidCacCents.current = 92442 (cents)',
      'ref "r1:data.marketing.ltvToCac" is withheld (null) — this number has no source',
      'no such ref "r7:data.nope" — cite a number from a tool result in this conversation',
    ]);
  });
  it('a stale ref (fetched before the newest sync marker) is rejected with "re-fetch"', () => {
    const v = verifyAnswer(base({ sections: [{ key: 'what_happened', body_md: '8 enrolled.', numbers: [{ text: '8', ref: 'r1:data.kpis.enrollments.current' }] }] }), ledger, { staleBefore: '2026-09-30T11:00:00.000Z' });
    expect(v.flagged[0].reason).toMatch(/predates the latest sync — re-fetch/);
    expect(verifyAnswer(base({ sections: [{ key: 'what_happened', body_md: '8 enrolled.', numbers: [{ text: '8', ref: 'r1:data.kpis.enrollments.current' }] }] }), ledger, { staleBefore: '2026-09-30T09:00:00.000Z' }).ok).toBe(true);
  });
  it('actions and findings: an impact with a number needs a ref; evidence refs must exist', () => {
    const v = verifyAnswer(
      base({
        actions: [{ action: 'Move budget', why: 'x', owner: 'Jake', kind: 'spend', expected_impact_ref: '', expected_impact: 'about $2,000 CAD more initial cash', confidence: 'low', metric: 'initial_cash', check_date: '2026-10-07' }],
        findings: [{ area: 'funnel', metric: 'consult_booked', finding: 'x', direction: 'down', severity: 'warning', evidence_refs: ['r1:data.stages[1].count', 'r2:data.missing'] }],
      }),
      ledger,
    );
    expect(v.flagged.map((f) => f.reason)).toEqual(['an expected impact with a number needs expected_impact_ref', 'no such evidence ref "r2:data.missing"']);
  });
  it('the repair message names each problem', () => {
    expect(repairMessage(['a', 'b'])).toContain('- a\n- b');
  });
});
