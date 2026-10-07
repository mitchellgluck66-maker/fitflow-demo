/** The smoke's pure parts (tuning items 7, 8, 10): which turns run, the per-turn line, the targets and the budget rule. */
import { describe, it, expect } from 'vitest';
import { formatSmokeTurn, sectionsMiss, runMisses, smokeTurns, SMOKE_TARGETS, SMOKE_TURNS, turnMisses, type SmokeTurnLine, formatRepairs, repairKinds, repairProblems, repairRounds } from '@/lib/analyst/smoke';

const line = (over: Partial<SmokeTurnLine> = {}): SmokeTurnLine => ({ status: 'PASS', turn: 1, question: 'q', tools: 3, cost: '18.2K in (15.9K cached) · 2.4K out · $0.19 USD', costUsd: 0.19, split: null, estimateUsd: 0.21, seconds: 21, headline: 'Enrollments doubled.', flagged: 0, repairs: 0, proposals: [], sections: ['what_happened'], error: null, cacheRead: 15_900, rounds: [{ toolCalls: 2, cacheSharePct: 0, cacheReadTokens: 0, cacheWriteTokens: 35_700 }, { toolCalls: 1, cacheSharePct: 91.2, cacheReadTokens: 35_700, cacheWriteTokens: 2_000 }, { toolCalls: 0, cacheSharePct: 94.8, cacheReadTokens: 40_000, cacheWriteTokens: 1_000 }], misses: [], ...over });

describe('item 7: one turn by default, the whole conversation with --full', () => {
  it('default = the first turn only; --full = every turn incl. the memory check and the explain', () => {
    expect(smokeTurns({}).length).toBe(1);
    expect(smokeTurns({ full: false })[0]).toBe(SMOKE_TURNS[0]);
    expect(smokeTurns({ full: true })).toBe(SMOKE_TURNS);
    expect(SMOKE_TURNS.length).toBe(5);
    expect(SMOKE_TURNS.filter((t) => t.expectsProposal).length).toBe(1);
    expect(SMOKE_TURNS.at(-1)?.kind).toBe('explain');
  });
});

describe('item 10: the per-turn line and the targets', () => {
  it('prints rounds, tools per round, cache per round, repairs, flagged, seconds, cost vs estimate; a FAIL names what it missed', () => {
    expect(formatSmokeTurn(line())).toBe('PASS turn 1 · 3 rounds · tools/round 2,1,0 · cache 0%/91%/95% · prefix: written (35.7K, 1h on Opus) · repairs 0 · flagged 0 · 21s · $0.19 USD vs est $0.21 USD (-10%) · sections 1 (what_happened)\n     ↳ Enrollments doubled.');
    expect(formatSmokeTurn(line({ repairs: 1, repairKinds: { ref: 1, digits: 2 }, flagged: 2, proposals: ['2026-09-30: cap $4,000 CAD'] }))).toContain(' · repairs 1 (digits×2, ref×1) · flagged 2');
    expect(formatSmokeTurn(line({ repairs: 0, repairKinds: {} }))).toContain(' · repairs 0 · flagged 0');
    const round = (costUsd: number) => ({ type: 'round' as const, stopReason: 'end_turn', inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cacheSharePct: 0, outputTokens: 50, droppedThinking: 0, progressUpdates: 0, toolCalls: 0, costUsd });
    expect(formatRepairs([round(0.3), { type: 'repair', problems: [{ kind: 'digits', section: 'what_happened', text: '8', reason: '"8" is a number written as digits' }, { kind: 'structure', section: 'answer', text: '', reason: 'sections out of order' }], targeted: false, paths: [] }, { type: 'status', text: 'Repairing the answer…' }, round(0.1)])).toEqual(['   repair 1 · digits (what_happened): "8" — "8" is a number written as digits', '   repair 1 · structure (answer) — sections out of order', '   repair 1 · full regeneration · $0.10 USD (25% of the turn)']);
    // Oct 7 item 2a: a targeted repair names its fields and its share of the turn; ≥ 20% is a miss.
    const targeted = [round(0.36), { type: 'repair' as const, problems: [{ kind: 'digits' as const, section: 'what_happened', text: '8', reason: 'r' }], targeted: true, paths: ['what_happened'] }, round(0.04)];
    expect(formatRepairs(targeted).at(-1)).toBe('   repair 1 · targeted (what_happened) · $0.04 USD (10% of the turn)');
    expect(repairRounds(targeted)[0]).toMatchObject({ targeted: true, paths: ['what_happened'], costUsd: 0.04, sharePct: 10 });
    expect(turnMisses({ costUsd: 0.4, estimateUsd: 0.4, rounds: line().rounds, repairSharePct: 10 })).toEqual([]);
    expect(turnMisses({ costUsd: 0.4, estimateUsd: 0.4, rounds: line().rounds, repairSharePct: 24 })).toEqual(['repair cost 24% of the turn ≥ 20%']);
    expect(repairKinds(repairProblems([{ type: 'repair', problems: [{ kind: 'ref', section: 'why', text: '{r2:data.x}', reason: 'no such ref' }, { kind: 'ref', section: 'why', text: '{r2:data.y}', reason: 'no such ref' }], targeted: true, paths: ['why'] }]))).toEqual({ ref: 2 });
    expect(formatSmokeTurn(line({ repairs: 1, flagged: 2, proposals: ['2026-09-30: cap $4,000 CAD'] }))).toContain(' · repairs 1 · flagged 2 · 21s · $0.19 USD vs est $0.21 USD (-10%) · sections 1 (what_happened) · 1 note proposal(s): "2026-09-30: cap $4,000 CAD"');
    expect(formatSmokeTurn(line({ status: 'FAIL', costUsd: 0.62, misses: ['cost $0.62 USD > $0.60 USD (cold)'] }))).toBe('FAIL turn 1 · "q" · 3 rounds · tools/round 2,1,0 · cache 0%/91%/95% · prefix: written (35.7K, 1h on Opus) · repairs 0 · flagged 0 · 21s · $0.62 USD vs est $0.21 USD (+195%) · missed: cost $0.62 USD > $0.60 USD (cold)');
    expect(formatSmokeTurn(line({ status: 'FAIL', rounds: [], seconds: 0, costUsd: 0, estimateUsd: null, error: 'memory check: the owner stated a durable fact but the answer proposed no note' }))).toBe('FAIL turn 1 · "q" · 0 rounds · tools/round — · cache — · prefix: — · repairs 0 · flagged 0 · 0s · $0.00 USD · memory check: the owner stated a durable fact but the answer proposed no note');
  });
  it('per-turn targets: cost ≤ $0.60 cold / $0.45 warm (by the measured prefix), cache ≥ 80% from round 2, estimate within ±25%; run-level: p50 ≤ 45 s, repairs < 20%, 0 flagged', async () => {
    expect(SMOKE_TARGETS).toEqual({ p50Seconds: 45, maxUsd: { cold: 0.6, warm: 0.45 }, cacheSharePctFromRound2: 80, repairRateMax: 0.2, repairSharePctMax: 20, flaggedMax: 0, estimateTolerance: 0.25 });
    const warmRounds = [{ toolCalls: 2, cacheSharePct: 90, cacheReadTokens: 35_700, cacheWriteTokens: 300 }];
    expect(turnMisses({ costUsd: 0.5, estimateUsd: 0.5, rounds: line().rounds })).toEqual([]); // cold: ≤ $0.60
    expect(turnMisses({ costUsd: 0.5, estimateUsd: 0.5, rounds: warmRounds })).toEqual(['cost $0.50 USD > $0.45 USD (warm)']);
    expect(turnMisses({ costUsd: 0.61, estimateUsd: 0.61, rounds: line().rounds })).toEqual(['cost $0.61 USD > $0.60 USD (cold)']);
    expect(turnMisses(line())).toEqual([]);
    expect(turnMisses(line({ costUsd: 0.62, estimateUsd: 0.4 }))).toEqual(['cost $0.62 USD > $0.60 USD (cold)', 'estimate +55% outside ±25%']);
    expect(turnMisses(line({ rounds: [{ toolCalls: 3, cacheSharePct: 0, cacheReadTokens: 0, cacheWriteTokens: 1 }, { toolCalls: 0, cacheSharePct: 71.4, cacheReadTokens: 1, cacheWriteTokens: 0 }] }))).toEqual(['cache round 2 71.4% < 80%']);
    expect(turnMisses(line({ costUsd: 0.1, estimateUsd: 0.2 }))).toEqual(['estimate -50% outside ±25%']);
    expect(turnMisses(line({ estimateUsd: null }))).toEqual([]);
    expect(runMisses([line({ seconds: 30 }), line({ seconds: 44 }), line({ seconds: 90 })])).toEqual([]); // p50 = 44
    expect(runMisses([line({ seconds: 30 }), line({ seconds: 46 }), line({ seconds: 90 })])).toEqual(['p50 46s > 45s']);
    expect(runMisses([line({ repairs: 1 })])).toEqual(['repairs 1/1 turns ≥ 20%']);
    expect(runMisses([line(), line(), line(), line(), line({ repairs: 1 })])).toEqual(['repairs 1/5 turns ≥ 20%']); // 20% is not < 20%
    expect(runMisses([line(), line(), line(), line(), line(), line({ repairs: 1 })])).toEqual([]); // 1/6 = 16.7%
    expect(runMisses([line({ flagged: 1 })])).toEqual(['1 flagged number(s) > 0']);
    const { prefixLine } = await import('@/lib/analyst/smoke');
    expect(prefixLine([{ toolCalls: 1, cacheSharePct: 90, cacheReadTokens: 35_700, cacheWriteTokens: 300 }])).toBe('prefix: hit (35.7K read)');
    // Oct 4 item 5: the estimate names its prefix state; a disagreement with the measured first round is printed, not hidden.
    const { prefixMismatchLine, measuredPrefix } = await import('@/lib/analyst/smoke');
    expect(measuredPrefix([])).toBeNull();
    expect(measuredPrefix(line().rounds)).toBe('cold');
    expect(formatSmokeTurn(line({ estimatePrefix: 'cold' }))).toContain(' · $0.19 USD vs est $0.21 USD (cold) (-10%) · sections');
    expect(formatSmokeTurn(line({ estimatePrefix: 'warm' }))).toContain(' vs est $0.21 USD (warm) (-10%) · prefix predicted warm, measured written · sections');
    expect(prefixMismatchLine({ estimatePrefix: 'cold', rounds: [{ toolCalls: 1, cacheSharePct: 90, cacheReadTokens: 35_700, cacheWriteTokens: 300 }] })).toBe(' · prefix predicted cold, measured hit');
    expect(prefixMismatchLine({ estimatePrefix: 'cold', rounds: line().rounds })).toBe('');
    expect(prefixMismatchLine({ estimatePrefix: null, rounds: line().rounds })).toBe('');
    // Oct 7 item 1: the gates from the snapshot and the answer's spend decisions, comparable across runs.
    const { spendLine, starterGates } = await import('@/lib/analyst/smoke');
    const { SNAPSHOT_PREFIX } = await import('@/lib/analyst/starter');
    expect(spendLine([{ kind: 'spend', campaign: 'Scaling', spend_change: 'hold' }, { kind: 'creative', campaign: '', spend_change: 'none' }, { kind: 'spend', campaign: '', spend_change: 'shift' }])).toBe('spend: hold Scaling, shift account');
    expect(spendLine([])).toBe('spend: none');
    expect(formatSmokeTurn(line({ spend: 'spend: hold Scaling' }))).toContain(' · sections 1 (what_happened) · spend: hold Scaling');
    const row = { apiJson: JSON.stringify({ role: 'user', content: [{ type: 'text', text: `${SNAPSHOT_PREFIX}${JSON.stringify({ ref: 'r2', data: { spendGates: { account: { campaign: 'account', decision: 'hold', basis: '3 of 4 tracked enrollments, 5 of 4 weeks with spend' }, campaigns: [{ campaign: 'Scaling', decision: 'may_change', basis: '6 tracked enrollments over 5 weeks with spend' }] } } })}` }] }) };
    expect(starterGates([row])).toBe('spend gates: account hold (3 of 4 tracked enrollments, 5 of 4 weeks with spend) · Scaling may change (6 tracked enrollments over 5 weeks with spend)');
    expect(starterGates(null)).toBeNull();
    expect(runMisses([line({ seconds: 0, rounds: [] })])).toEqual([]); // a turn that never ran is not judged
  });
});

describe('item 8: the hard budget', () => {
  it('withinBudget and the stop message; --max-usd parsing refuses a bad value', async () => {
    const { withinBudget, budgetStopMessage, DEFAULT_MAX_USD, parseMaxUsd } = await import('@/lib/analyst/smoke');
    expect(DEFAULT_MAX_USD).toBe(1);
    expect(withinBudget(0.6, 0.4, 1)).toBe(true);
    expect(withinBudget(0.61, 0.4, 1)).toBe(false);
    expect(budgetStopMessage(0.84, 1, 0.31)).toBe('Stopped at $0.84 USD of $1.00 USD budget — the next request was estimated at $0.31 USD');
    expect(budgetStopMessage(1.02, 1, null)).toBe('Stopped at $1.02 USD of $1.00 USD budget');
    expect(parseMaxUsd([])).toBe(1);
    expect(parseMaxUsd(['--full', '--max-usd', '1.5'])).toBe(1.5);
    expect(parseMaxUsd(['--max-usd=0.25'])).toBe(0.25);
    expect(() => parseMaxUsd(['--max-usd', 'lots'])).toThrow(/positive USD amount/);
    expect(() => parseMaxUsd(['--max-usd'])).toThrow(/positive USD amount/);
  });
});

describe('2026-10-01: chat effort medium, and cheaper must not mean thinner', () => {
  it('chat threads (ask / explain on the default model) are medium; reports and the deep model keep the Setup effort', async () => {
    const { effortForThread, CHAT_EFFORT } = await import('@/lib/analyst/config');
    expect(CHAT_EFFORT).toBe('medium');
    expect(effortForThread({ kind: 'ask', model: 'claude-opus-5-5', settingEffort: 'high' })).toBe('medium');
    expect(effortForThread({ kind: 'explain', model: 'claude-opus-5-5', settingEffort: 'xhigh' })).toBe('medium');
    expect(effortForThread({ kind: 'report', model: 'claude-opus-5-5', settingEffort: 'high' })).toBe('high');
    expect(effortForThread({ kind: 'ask', model: 'claude-fable-5-1', settingEffort: 'high' })).toBe('high');
    expect(effortForThread({ kind: 'report', model: 'claude-fable-5-1', settingEffort: 'xhigh' })).toBe('xhigh');
  });
  it('turn 1 must keep its five sections; a missing one is a named miss', () => {
    expect(SMOKE_TURNS[0].expectsSections).toEqual(['what_happened', 'why', 'so_what', 'do_this', 'how_we_will_know']);
    expect(sectionsMiss(SMOKE_TURNS[0].expectsSections, ['what_happened', 'why', 'so_what', 'do_this', 'how_we_will_know'])).toBeNull();
    expect(sectionsMiss(SMOKE_TURNS[0].expectsSections, ['what_happened', 'why', 'do_this'])).toBe('sections 3/5: missing so_what, how_we_will_know');
    expect(sectionsMiss(undefined, [])).toBeNull();
  });
});

describe('G: the smoke prints the full rendered answer', () => {
  it('headline, every section whole, actions, findings and proposals — nothing truncated', async () => {
    const { formatRenderedAnswer } = await import('@/lib/analyst/smoke');
    const long = 'x'.repeat(2_000);
    const text = formatRenderedAnswer({
      kind: 'answer',
      headline: 'Enrollments doubled to 8.',
      sections: [{ key: 'what_happened', body_md: `**8** enrollments.\nSecond line.` }, { key: 'do_this', body_md: long }],
      actions: [{ action: 'Shift budget', why: 'because', owner: 'Jake', kind: 'spend', campaign: 'account', spend_change: 'shift', expected_impact: '$1,000 CAD', confidence: 'medium', metric: 'paid_cac', check_date: '2026-10-07' }],
      findings: [{ area: 'funnel', metric: 'applied', finding: '52 applied', direction: 'flat', severity: 'info', evidence_refs: ['r1:data.stages[0].count'] }],
      note_proposals: ['2026-10-03: cap $4,000 CAD'],
      clarifying_question: '',
    });
    expect(text).toContain('┌ ANSWER · Enrollments doubled to 8.');
    expect(text).toContain('│ ## What happened\n   │ **8** enrollments.\n   │ Second line.');
    expect(text).toContain(long);
    expect(text).toContain('1. [spend · Jake · medium] Shift budget — because · impact: $1,000 CAD · watch paid_cac on 2026-10-07');
    expect(text).toContain('• [funnel · applied · flat · info] 52 applied (r1:data.stages[0].count)');
    expect(text).toContain('○ 2026-10-03: cap $4,000 CAD');
    expect(text.trim().endsWith('└')).toBe(true);
  });
});
