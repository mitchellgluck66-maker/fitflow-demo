/** The smoke's pure parts (tuning items 7, 8, 10): which turns run, the per-turn line, the targets and the budget rule. */
import { describe, it, expect } from 'vitest';
import { formatSmokeTurn, sectionsMiss, runMisses, smokeTurns, SMOKE_TARGETS, SMOKE_TURNS, turnMisses, type SmokeTurnLine } from '@/lib/analyst/smoke';

const line = (over: Partial<SmokeTurnLine> = {}): SmokeTurnLine => ({ status: 'PASS', turn: 1, question: 'q', tools: 3, cost: '18.2K in (15.9K cached) · 2.4K out · $0.19 USD', costUsd: 0.19, estimateUsd: 0.21, seconds: 21, headline: 'Enrollments doubled.', flagged: 0, repairs: 0, proposals: [], sections: ['what_happened'], error: null, cacheRead: 15_900, rounds: [{ toolCalls: 2, cacheSharePct: 0 }, { toolCalls: 1, cacheSharePct: 91.2 }, { toolCalls: 0, cacheSharePct: 94.8 }], misses: [], ...over });

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
    expect(formatSmokeTurn(line())).toBe('PASS turn 1 · 3 rounds · tools/round 2,1,0 · cache 0%/91%/95% · repairs 0 · flagged 0 · 21s · $0.19 USD vs est $0.21 USD (-10%) · sections 1 (what_happened)\n     ↳ Enrollments doubled.');
    expect(formatSmokeTurn(line({ repairs: 1, flagged: 2, proposals: ['2026-09-30: cap $4,000 CAD'] }))).toContain(' · repairs 1 · flagged 2 · 21s · $0.19 USD vs est $0.21 USD (-10%) · sections 1 (what_happened) · 1 note proposal(s): "2026-09-30: cap $4,000 CAD"');
    expect(formatSmokeTurn(line({ status: 'FAIL', costUsd: 0.52, misses: ['cost $0.52 USD > $0.40 USD'] }))).toBe('FAIL turn 1 · "q" · 3 rounds · tools/round 2,1,0 · cache 0%/91%/95% · repairs 0 · flagged 0 · 21s · $0.52 USD vs est $0.21 USD (+148%) · missed: cost $0.52 USD > $0.40 USD');
    expect(formatSmokeTurn(line({ status: 'FAIL', rounds: [], seconds: 0, costUsd: 0, estimateUsd: null, error: 'memory check: the owner stated a durable fact but the answer proposed no note' }))).toBe('FAIL turn 1 · "q" · 0 rounds · tools/round — · cache — · repairs 0 · flagged 0 · 0s · $0.00 USD · memory check: the owner stated a durable fact but the answer proposed no note');
  });
  it('per-turn targets: cost ≤ $0.40, cache ≥ 80% from round 2, estimate within ±25%; run-level: p50 ≤ 45 s, repairs < 20%, 0 flagged', () => {
    expect(SMOKE_TARGETS).toEqual({ p50Seconds: 45, maxUsd: 0.4, cacheSharePctFromRound2: 80, repairRateMax: 0.2, flaggedMax: 0, estimateTolerance: 0.25 });
    expect(turnMisses(line())).toEqual([]);
    expect(turnMisses(line({ costUsd: 0.52, estimateUsd: 0.4 }))).toEqual(['cost $0.52 USD > $0.40 USD', 'estimate +30% outside ±25%']);
    expect(turnMisses(line({ rounds: [{ toolCalls: 3, cacheSharePct: 0 }, { toolCalls: 0, cacheSharePct: 71.4 }] }))).toEqual(['cache round 2 71.4% < 80%']);
    expect(turnMisses(line({ costUsd: 0.1, estimateUsd: 0.2 }))).toEqual(['estimate -50% outside ±25%']);
    expect(turnMisses(line({ estimateUsd: null }))).toEqual([]);
    expect(runMisses([line({ seconds: 30 }), line({ seconds: 44 }), line({ seconds: 90 })])).toEqual([]); // p50 = 44
    expect(runMisses([line({ seconds: 30 }), line({ seconds: 46 }), line({ seconds: 90 })])).toEqual(['p50 46s > 45s']);
    expect(runMisses([line({ repairs: 1 })])).toEqual(['repairs 1/1 turns ≥ 20%']);
    expect(runMisses([line(), line(), line(), line(), line({ repairs: 1 })])).toEqual(['repairs 1/5 turns ≥ 20%']); // 20% is not < 20%
    expect(runMisses([line(), line(), line(), line(), line(), line({ repairs: 1 })])).toEqual([]); // 1/6 = 16.7%
    expect(runMisses([line({ flagged: 1 })])).toEqual(['1 flagged number(s) > 0']);
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
