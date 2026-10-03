/**
 * Verifier v2 (design review 2026-10-03, A): the model writes ref tokens, the server renders them. The checks:
 * every token resolves; no raw digits outside the exempt contexts (and the owner's own figures); evidence
 * refs exist; direction words agree with the delta's sign (sign words) or the metric's polarity (judgment
 * words). One repair; then marked, never silent. Plus the answer schema's structure rules.
 */
import { describe, it, expect } from 'vitest';
import { Ledger, ledgerEntries, unitForPath } from '@/lib/analyst/ledger';
import { isExemptContext, refTokens, tokens, verifyAnswer, repairMessage, withoutTokens } from '@/lib/analyst/verify';
import { renderAnswer, renderText, NO_SOURCE } from '@/lib/analyst/render';
import { checkDirection, lowerIsBetter, sentences } from '@/lib/analyst/direction';
import { ANSWER_SCHEMA, AnswerSchema, checkStructure, expectedSections, SECTION_KEYS, type Answer } from '@/lib/analyst/schema';
import { findUnsupportedKeywords } from '@/lib/anthropic/strictSchema';

const T0 = '2026-09-30T10:00:00.000Z';
const ledger = new Ledger();
ledger.add(
  'r1',
  {
    kpis: { enrollments: { current: 8, previous: 4, abs: 4, pct: 1 }, paidCacCents: { current: 92_442, previous: 184_884, abs: -92_442, pct: -0.5 }, roas: { current: 2.0871, previous: 0.94, abs: 1.1471, pct: 1.22 } },
    marketing: { spendCents: 369_768, paidEnrollments: 4, ltvToCac: null },
    showRates: [{ type: 'Consult', rate: 0.6123, showed: 6, noShow: 4 }],
    stages: [{ key: 'applied', count: 52 }, { key: 'consult_booked', count: 7, conversionFromPrevious: 0.1346 }],
    frequency: 2.37,
    timeInStageHours: 41.6,
  },
  T0,
  'CAD',
);
ledger.add('r7', { results: [{ label: 'organic', op: 'difference', unit: 'count', delta: true, metric: null, value: 4 }, { label: 'mix', op: 'ratio', unit: 'pct', delta: false, metric: null, value: 0.5 }], failed: 0 }, T0, 'CAD');

const base = (over: Partial<Answer> = {}): Answer => ({
  kind: 'answer',
  headline: { text: 'Enrollments doubled to {r1:data.kpis.enrollments.current} last week.' },
  sections: [],
  actions: [],
  findings: [],
  note_proposals: [],
  clarifying_question: '',
  ...over,
});
const sec = (key: Answer['sections'][number]['key'], body_md: string) => ({ key, body_md });
const action = (over: Partial<Answer['actions'][number]> = {}): Answer['actions'][number] => ({ action: 'Shift budget', why: 'because', owner: 'Jake', kind: 'spend', expected_impact: 'unknown', confidence: 'medium', metric: 'paid_cac', check_date: '2026-10-07', ...over });

describe('schema', () => {
  it('is strict-compatible (0 optional, 0 unions), every field required, and the zod schema accepts a full answer', () => {
    expect(findUnsupportedKeywords(ANSWER_SCHEMA as unknown as Record<string, unknown>)).toEqual([]);
    expect(AnswerSchema.safeParse(base()).success).toBe(true);
    expect(JSON.stringify(ANSWER_SCHEMA)).not.toMatch(/"numbers"|expected_impact_ref|"ref"/); // v2: refs live in the text
    expect(SECTION_KEYS.length).toBe(16);
  });
  it('checkStructure enforces the kind\'s sections and order', () => {
    expect(checkStructure(base({ sections: [sec('what_happened', 'x'), sec('do_this', 'y')] }))).toBeNull();
    expect(checkStructure(base({ sections: [sec('do_this', 'x'), sec('why', 'y')] }))).toMatch(/order/);
    expect(checkStructure(base({ sections: [] }))).toMatch(/at least one section/);
    expect(checkStructure(base({ sections: [sec('what_it_is', 'x')] }))).toMatch(/may only use/);
    expect(checkStructure(base({ kind: 'explain', sections: expectedSections('explain').keys.map((key) => sec(key, 'x')) }))).toBeNull();
    expect(checkStructure(base({ kind: 'explain', sections: [sec('what_it_is', 'x')] }))).toMatch(/exactly the sections/);
    expect(checkStructure(base({ kind: 'clarify', headline: { text: 'Which period?' }, clarifying_question: 'Which period do you mean?' }))).toBeNull();
    expect(checkStructure(base({ kind: 'clarify', headline: { text: 'x' } }))).toMatch(/clarifying_question/);
    expect(checkStructure(base({ sections: [sec('why', '   ')] }))).toMatch(/empty/);
  });
});

describe('ledger', () => {
  it('lists every numeric leaf with its unit; nulls are kept as withheld', () => {
    const entries = ledgerEntries('r9', { a: { spendCents: 5 }, b: [{ rate: 0.5 }, { count: 3 }], c: null, d: 'text', e: { roas: { current: 2 } } }, T0, 'CAD');
    expect(entries.map((e) => [e.ref, e.value, e.unit])).toEqual([
      ['r9:data.a.spendCents', 5, 'cents'],
      ['r9:data.b[0].rate', 0.5, 'ratio'],
      ['r9:data.b[1].count', 3, 'count'],
      ['r9:data.c', null, 'unknown'], // no name, no declaration: the sweep test would name it
      ['r9:data.e.roas.current', 2, 'ratio'],
    ]);
    expect(unitForPath('data.kpis.paidCacCents.current')).toBe('cents');
    expect(unitForPath('data.kpis.enrollments.pct')).toBe('ratio');
    expect(unitForPath('data.kpis.enrollments.abs')).toBe('count');
    expect(unitForPath('data.kpis.paidCacCents.pct')).toBe('ratio');
    expect(unitForPath('data.kpis.paidCacCents.abs')).toBe('cents');
    expect(unitForPath('data.timeInStageHours')).toBe('hours');
    expect(ledger.resolve('r1:data.marketing.ltvToCac')).toBeNull();
    expect(ledger.resolve('r1:data.nope')).toBeUndefined();
  });
});

describe('tokens and rendering', () => {
  it('finds ref tokens with hints; renders them from the ledger; withoutTokens leaves prose only', () => {
    const text = 'CAC {r1:data.kpis.paidCacCents.current} (down {r1:data.kpis.paidCacCents.pct}) · ROAS {r1:data.kpis.roas.current|%} · {r7:data.results[1].value|x} · {r9:data.nope}';
    expect(refTokens(text).map((t) => [t.ref, t.hint])).toEqual([['r1:data.kpis.paidCacCents.current', null], ['r1:data.kpis.paidCacCents.pct', null], ['r1:data.kpis.roas.current', '%'], ['r7:data.results[1].value', 'x'], ['r9:data.nope', null]]);
    expect(renderText(text, ledger)).toBe(`CAC $924.42 CAD (down 50%) · ROAS 208.7% · 0.5× · ${NO_SOURCE}`);
    expect(withoutTokens(text)).toBe('CAC REF (down REF) · ROAS REF · REF · REF');
    expect(renderText('**{r1:data.kpis.enrollments.current}** enrollments; {r1:data.marketing.ltvToCac} LTV', ledger)).toBe(`**8** enrollments; ${NO_SOURCE} LTV`);
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

describe('verifyAnswer v2', () => {
  it('a clean answer: every token resolves, no raw digits, dates / durations / ordinals allowed', () => {
    const a = base({ sections: [sec('what_happened', 'Enrollments rose to **{r1:data.kpis.enrollments.current}** in the week of Sep 20–26 (up {r1:data.kpis.enrollments.pct}); over 12 weeks the pattern held.\n1. first\n2. second')] });
    expect(verifyAnswer(a, ledger)).toEqual({ ok: true, flagged: [], verified: 3 });
  });
  it('unknown, withheld and stale refs are flagged with the reason; evidence refs too', () => {
    const a = base({ sections: [sec('why', '{r9:data.nope} and {r1:data.marketing.ltvToCac}')], findings: [{ area: 'marketing', metric: 'roas', finding: 'x', direction: 'up', severity: 'info', evidence_refs: ['r1:data.kpis.roas.current', 'r1:data.zzz'] }] });
    const v = verifyAnswer(a, ledger);
    expect(v.ok).toBe(false);
    expect(v.flagged.map((f) => [f.kind, f.section, f.text])).toEqual([['ref', 'why', '{r9:data.nope}'], ['ref', 'why', '{r1:data.marketing.ltvToCac}'], ['evidence', 'findings', 'x']]);
    expect(v.flagged[0].reason).toMatch(/no such ref "r9:data.nope"/);
    expect(v.flagged[1].reason).toMatch(/withheld \(null\)/);
    expect(verifyAnswer(base(), ledger, { staleBefore: '2026-09-30T11:00:00.000Z' }).flagged[0].reason).toMatch(/predates the latest sync — re-fetch/);
  });
  it('a raw digit outside a token is flagged unless the owner wrote it in this question', () => {
    const a = base({ sections: [sec('what_happened', 'We got 8 enrollments and spent $3,697.68 CAD; the cap is $4,000 CAD.')] });
    const v = verifyAnswer(a, ledger, { question: 'From October we cap Meta at $4,000 CAD a month — does that change anything?' });
    expect(v.flagged.map((f) => [f.kind, f.text])).toEqual([['digits', '8'], ['digits', '$3,697.68 CAD']]);
    expect(v.flagged[0].reason).toMatch(/write its ref in braces/);
    expect(verifyAnswer(a, ledger).flagged.length).toBe(3); // without the question, $4,000 CAD is a raw digit too
  });
  it('actions and findings are checked like sections', () => {
    const a = base({ actions: [action({ expected_impact: 'about {r9:data.gone} more', why: 'CAC is 924 dollars' })], findings: [{ area: 'funnel', metric: 'applied', finding: '{r1:data.stages[0].count} applied', direction: 'flat', severity: 'info', evidence_refs: [] }] });
    expect(verifyAnswer(a, ledger).flagged.map((f) => [f.kind, f.section])).toEqual([['digits', 'actions[0].why'], ['ref', 'actions[0].expected_impact']]);
  });
  it('the repair message explains the token rule', () => {
    expect(repairMessage(['x'])).toMatch(/write its ref in braces/);
  });
});

describe('direction check (E): sign words vs the sign, judgment words vs the metric\'s polarity', () => {
  const L = ledger;
  it('sign words: "fell" needs a negative delta, "rose" a positive one; neutral wording never flags', () => {
    expect(checkDirection('Paid CAC fell {r1:data.kpis.paidCacCents.pct}.', L)).toEqual([]);
    expect(checkDirection('Paid CAC rose {r1:data.kpis.paidCacCents.pct}.', L).map((p) => p.reason)).toEqual(['direction: "rose" next to {r1:data.kpis.paidCacCents.pct} which is −50%']);
    expect(checkDirection('Enrollments were up {r1:data.kpis.enrollments.pct}.', L)).toEqual([]);
    expect(checkDirection('Enrollments dropped by {r1:data.kpis.enrollments.abs}.', L).map((p) => p.reason)).toEqual(['direction: "dropped" next to {r1:data.kpis.enrollments.abs} which is +4']);
    expect(checkDirection('Enrollments changed by {r1:data.kpis.enrollments.pct}; CAC moved {r1:data.kpis.paidCacCents.pct}.', L)).toEqual([]);
    expect(checkDirection('CAC is {r1:data.kpis.paidCacCents.current}, down from last week.', L)).toEqual([]); // not a delta
  });
  it('judgment words: a cost metric improves when it falls; a volume metric improves when it rises — both directions', () => {
    expect(lowerIsBetter('paidCacCents')).toBe(true);
    expect(lowerIsBetter('enrollments')).toBe(false);
    expect(lowerIsBetter('nope')).toBeNull();
    expect(checkDirection('Paid CAC improved {r1:data.kpis.paidCacCents.pct}.', L)).toEqual([]);
    expect(checkDirection('Paid CAC worsened {r1:data.kpis.paidCacCents.pct}.', L).map((p) => p.reason)).toEqual(['"worsened" next to {r1:data.kpis.paidCacCents.pct} which is −50% — paidCacCents is lower-is-better']);
    expect(checkDirection('Enrollments improved {r1:data.kpis.enrollments.pct}.', L)).toEqual([]);
    expect(checkDirection('Enrollments got worse ({r1:data.kpis.enrollments.pct}).', L).map((p) => p.reason)).toEqual(['"worse" next to {r1:data.kpis.enrollments.pct} which is +100% — enrollments is higher-is-better']);
    // A calculate delta over two different things has no metric: a judgment word is refused with the reason, a sign word is fine.
    expect(checkDirection('The organic gap improved by {r7:data.results[0].value}.', L).map((p) => p.reason)).toEqual(['"improved" judges {r7:data.results[0].value} (+4) but that change belongs to no single metric — use a sign word (up / down) or cite the metric\'s own delta']);
    expect(checkDirection('The organic gap grew by {r7:data.results[0].value}.', L)).toEqual([]);
  });
  it('the nearest word decides when a sentence cites two deltas; sentences split on . ! ? and line breaks', () => {
    expect(checkDirection('Enrollments rose {r1:data.kpis.enrollments.pct} while CAC fell {r1:data.kpis.paidCacCents.pct}.', L)).toEqual([]);
    expect(checkDirection('Enrollments fell {r1:data.kpis.enrollments.pct} while CAC rose {r1:data.kpis.paidCacCents.pct}.', L).length).toBe(2);
    expect(sentences('CAC fell.\nEnrollments rose! Spend is $1.5 up? Yes').map((s) => s.text.trim())).toEqual(['CAC fell.', 'Enrollments rose!', 'Spend is $1.5 up?', 'Yes']);
    expect(checkDirection('CAC fell {r1:data.kpis.paidCacCents.pct}.\nEnrollments fell {r1:data.kpis.enrollments.pct}.', L).length).toBe(1);
  });
  it('after the repair, verifyAnswer flags the sentence and renderAnswer marks it [check direction]; unresolved tokens read [no source]; raw digits [unverified]', () => {
    const a = base({ sections: [sec('what_happened', 'Paid CAC rose {r1:data.kpis.paidCacCents.pct} to {r1:data.kpis.paidCacCents.current}. We saw 8 wins. {r9:data.nope} applied.')] });
    const v = verifyAnswer(a, ledger);
    expect(v.flagged.map((f) => f.kind)).toEqual(['ref', 'digits', 'direction']);
    const r = renderAnswer(a, ledger, v.flagged);
    expect(r.sections[0].body_md).toBe(`[check direction] Paid CAC rose 50% to $924.42 CAD. We saw [unverified: 8] wins. ${NO_SOURCE} applied.`);
    expect(r.headline).toBe('Enrollments doubled to 8 last week.');
  });
});
