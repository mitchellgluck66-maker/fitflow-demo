/**
 * The golden eval's pure parts (Wave 2 item 12): the numbers scorer on the replay fixture (the headline's ref token
 * resolved through the ledger vs the independent SQL's value — exact for counts / cents, ± 0.0005 for ratios, withheld
 * handled, flagged fails), the explain scorer, the behaviour scorers, the show-rate rule, the case catalogues.
 */
import { describe, it, expect } from 'vitest';
import { readFixtures, replayFixture } from '@/lib/analyst/replay';
import { headlineValue, scoreCampaignRow, scoreClarify, scoreContext, scoreExplain, scoreHealthy, scoreNumbers, scoreStale, formatExpected } from '@/lib/analyst/evalScore';
import { BEHAVIOUR_CASES, EXPLAIN_CASES, NUMBERS_QUESTIONS, showRateFromSql, type SqlOut } from '@/lib/analyst/evalQuestions';
import { EXPLAIN_SECTIONS } from '@/lib/analyst/schema';
import type { TurnOutcome } from '@/lib/analyst/run';
import type { MessageRow } from '@/lib/analyst/store';

const outcome = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
  status: 'done',
  answer: { kind: 'answer', headline: { text: 'x' }, sections: [{ key: 'what_happened', body_md: 'a' }], actions: [], findings: [], note_proposals: [], clarifying_question: '' },
  rendered: { kind: 'answer', headline: 'x', sections: [{ key: 'what_happened', body_md: 'a' }], actions: [], findings: [], note_proposals: [], clarifying_question: '' },
  flagged: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
  costUsd: 0.1,
  rounds: 1,
  error: null,
  compacted: false,
  split: null,
  firstSectionSeconds: 10,
  spendDecisions: [],
  ...over,
});

describe('scoreNumbers on the replay fixture', () => {
  it('the headline token resolves through the ledger; the right expected value passes, a wrong one fails with the reason, flags fail', async () => {
    const fixtures = readFixtures();
    if (fixtures.length === 0) return;
    const [r] = await replayFixture(fixtures[0].fixture);
    const rows = r.rows as MessageRow[];
    const h = headlineValue(r.outcome, rows);
    expect(h.ref).toMatch(/^r\d+:data\./);
    if (typeof h.value !== 'number') return; // a withheld or text headline: nothing numeric to score here
    const unit = h.unit === 'cents' ? 'cents' : h.unit === 'count' ? 'count' : 'ratio';
    expect(scoreNumbers(r.outcome, rows, h.value, unit)).toMatchObject({ ok: true, expected: formatExpected(h.value, unit) });
    expect(scoreNumbers(r.outcome, rows, h.value + 1, unit)).toMatchObject({ ok: false, reason: 'the headline figure differs from the independent SQL' });
    if (unit === 'ratio') expect(scoreNumbers(r.outcome, rows, h.value + 0.0004, unit).ok).toBe(true);
    expect(scoreNumbers({ ...r.outcome, flagged: [{ kind: 'digits', section: 'headline', text: '8', reason: 'x' }] }, rows, h.value, unit)).toMatchObject({ ok: false, reason: expect.stringMatching(/^verifier flagged digits "8"/) });
  });

  it('a withheld expectation passes only when the headline says so; a headline with no token fails', () => {
    const says = outcome({ answer: { kind: 'answer', headline: { text: 'The show rate is withheld.' }, sections: [], actions: [], findings: [], note_proposals: [], clarifying_question: '' }, rendered: { kind: 'answer', headline: 'The consult show rate is not available: attendance recorded for 3% of consults.', sections: [], actions: [], findings: [], note_proposals: [], clarifying_question: '' } });
    expect(scoreNumbers(says, [], null, 'ratio').ok).toBe(true);
    expect(scoreNumbers(outcome(), [], null, 'ratio')).toMatchObject({ ok: false, reason: 'the headline neither cites the withheld value nor says why it is withheld' });
    expect(scoreNumbers(outcome(), [], 43, 'count')).toMatchObject({ ok: false, reason: 'the headline carries no ref token (no number to check)' });
    expect(scoreNumbers(outcome({ status: 'failed', answer: null, error: 'boom' }), [], 43, 'count')).toMatchObject({ ok: false, got: 'boom' });
  });
});

describe('explain and behaviour scorers', () => {
  const explainOutcome = outcome({ answer: { kind: 'explain', headline: { text: 'x' }, sections: EXPLAIN_SECTIONS.map((key) => ({ key, body_md: 'y' })), actions: [], findings: [], note_proposals: [], clarifying_question: '' } });
  const info = { key: 'paid_cac', label: 'Paid CAC', definition: 'd', differsFrom: 'x', formula: 'f', worked: '$9,890.33 CAD ÷ 6 = $1,648.39 CAD', value: 164_839, reason: null, maturing: false };
  it('scoreExplain: three sections exactly, the formula box equal to the engine, nothing flagged', () => {
    expect(scoreExplain(explainOutcome, info, { worked: info.worked, value: info.value }).ok).toBe(true);
    expect(scoreExplain(explainOutcome, { ...info, worked: 'other' }, { worked: info.worked, value: info.value })).toMatchObject({ ok: false, reason: 'the formula box differs from the engine' });
    expect(scoreExplain(explainOutcome, null, { worked: info.worked, value: info.value })).toMatchObject({ ok: false, reason: 'the server emitted no formula box' });
    expect(scoreExplain(outcome(), info, { worked: info.worked, value: info.value })).toMatchObject({ ok: false, reason: 'not exactly What it is / What yours says / What to do' });
  });
  it('stale: the notice first and every decision a server hold; healthy: "No action needed" or dated actions; clarify: kind clarify', () => {
    const hold = { campaign: 'account', gate: 'hold' as const, basis: 'b', decision: 'hold' as const, decidedBy: 'server' as const, ref: 'r' };
    expect(scoreStale([outcome({ spendDecisions: [hold] })], [{ type: 'tools' }, { type: 'notice', stale: true }]).ok).toBe(true);
    expect(scoreStale([outcome({ spendDecisions: [{ ...hold, decision: 'increase', decidedBy: 'model' }] })], [{ type: 'notice', stale: true }])).toMatchObject({ ok: false, reason: 'a spend decision was not a server hold' });
    expect(scoreStale([outcome()], [{ type: 'notice', stale: false }])).toMatchObject({ ok: false, reason: 'the stale notice was not the first event' });
    const healthy = outcome({ rendered: { kind: 'explain', headline: 'h', sections: [{ key: 'what_to_do', body_md: 'No action needed; flag it if MRR drops below $9,000 CAD.' }], actions: [], findings: [], note_proposals: [], clarifying_question: '' } });
    expect(scoreHealthy([healthy]).ok).toBe(true);
    const invented = outcome({ answer: { kind: 'explain', headline: { text: 'x' }, sections: [{ key: 'what_to_do', body_md: 'Do things' }], actions: [{ action: 'a', why: 'w', owner: 'o', kind: 'other', campaign: '', spend_change: 'none', expected_impact: 'u', confidence: 'low', metric: 'mrr', check_date: 'soon' }], findings: [], note_proposals: [], clarifying_question: '' }, rendered: { kind: 'explain', headline: 'x', sections: [{ key: 'what_to_do', body_md: 'Do things' }], actions: [], findings: [], note_proposals: [], clarifying_question: '' } });
    expect(scoreHealthy([invented]).ok).toBe(false);
    const clarify = outcome({ answer: { kind: 'clarify', headline: { text: 'Which campaigns?' }, sections: [], actions: [], findings: [], note_proposals: [], clarifying_question: 'Which two campaigns do you mean?' }, rendered: { kind: 'clarify', headline: 'Which campaigns?', sections: [], actions: [], findings: [], note_proposals: [], clarifying_question: 'Which two campaigns do you mean?' } });
    expect(scoreClarify([clarify]).ok).toBe(true);
    expect(scoreClarify([outcome()]).ok).toBe(false);
  });
  it('context: the first answer names a campaign and every later one keeps it; campaign row: the answer names the campaign', () => {
    const mention = (text: string) => outcome({ rendered: { kind: 'answer', headline: text, sections: [], actions: [], findings: [], note_proposals: [], clarifying_question: '' } });
    const names = ['Summer Shred — Broad', 'Brand Search'];
    expect(scoreContext([mention('Brand Search wins.'), mention('Brand Search converts well.'), mention('Brand Search cost less.')], names).ok).toBe(true);
    expect(scoreContext([mention('Brand Search wins.'), mention('It converts well.')], names)).toMatchObject({ ok: false, reason: 'turn 2 lost the campaign' });
    expect(scoreContext([mention('Nothing named.'), mention('x')], names)).toMatchObject({ ok: false, reason: 'the first answer named no campaign' });
    expect(scoreCampaignRow([mention('Summer Shred — Retargeting books few consults.')], 'Summer Shred — Retargeting').ok).toBe(true);
    expect(scoreCampaignRow([mention('Spend is up.')], 'Summer Shred — Retargeting').ok).toBe(false);
  });
});

describe('the catalogues', () => {
  it('25 numbers questions over the four ranges, 20 explain cases, 5 behaviour cases; the show-rate rule withholds below 90 % coverage', () => {
    expect(NUMBERS_QUESTIONS).toHaveLength(25);
    expect(new Set(NUMBERS_QUESTIONS.map((q) => q.range))).toEqual(new Set(['week', 'month', 'mtd', 'jul16']));
    expect(NUMBERS_QUESTIONS.every((q) => /Lead with that one number\.$/.test(q.question))).toBe(true);
    expect(EXPLAIN_CASES).toHaveLength(20);
    expect(BEHAVIOUR_CASES.map((c) => c.kind)).toEqual(['stale', 'healthy', 'clarify', 'context', 'campaign_row']);
    expect(BEHAVIOUR_CASES.find((c) => c.kind === 'context')?.turns).toHaveLength(5);
    const S = { show_rates: [{ type: 'Consult', past: 10, showed: 6, no_show: 3, cancelled: 0 }, { type: 'Roadmap', past: 10, showed: 2, no_show: 1, cancelled: 0 }] } as unknown as SqlOut;
    expect(showRateFromSql(S, 'Consult')).toBeCloseTo(6 / 9, 6);
    expect(showRateFromSql(S, 'Roadmap')).toBeNull(); // 3 of 10 decided
    const sql = { period: { applied: 43, enrolled: 2, roadmap_booked: 9 }, cohort: {}, has_stripe: true, enrolled_by_att: { paid: 1 }, show_rates: [], by_ccy: { CAD: { spend: 365_322, initial_c: 427_455, initial_by_att: { paid: { cents: 100_000, n: 1 } } } } } as unknown as SqlOut;
    const by = Object.fromEntries(NUMBERS_QUESTIONS.map((q) => [q.id, q.expected(sql)]));
    expect(by.n07).toBe(365_322); // Paid CAC = spend ÷ 1 paid enrollment
    expect(by.n08).toBe(182_661); // Blended CAC = spend ÷ 2, rounded
    expect(by.n14).toBeCloseTo(100_000 / 365_322, 6);
    expect(by.n19).toBe(40_591);
  });
});
