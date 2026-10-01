/** The smoke's pure parts (tuning items 7, 8, 10): which turns run, the per-turn line, the targets and the budget rule. */
import { describe, it, expect } from 'vitest';
import { formatSmokeTurn, smokeTurns, SMOKE_TURNS, type SmokeTurnLine } from '@/lib/analyst/smoke';

const line = (over: Partial<SmokeTurnLine> = {}): SmokeTurnLine => ({ status: 'PASS', turn: 1, question: 'q', tools: 3, cost: '18.2K in (15.9K cached) · 2.4K out · $0.19 USD', estimateUsd: 0.21, seconds: 21, headline: 'Enrollments doubled.', flagged: 0, repairs: 0, proposals: [], sections: ['what_happened'], error: null, cacheRead: 15_900, ...over });

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

describe('the per-turn line', () => {
  it('names repairs, flagged numbers and proposals; a FAIL carries the error', () => {
    expect(formatSmokeTurn(line())).toBe('PASS turn 1 · 3 tools · 18.2K in (15.9K cached) · 2.4K out · $0.19 USD · 21s · estimate $0.21 USD · sections what_happened · repairs 0\n     ↳ Enrollments doubled.');
    expect(formatSmokeTurn(line({ repairs: 1, flagged: 2, proposals: ['2026-09-30: cap $4,000 CAD'], cacheRead: 0 }))).toContain(' · NO CACHE READ · sections what_happened · repairs 1 · 2 FLAGGED number(s) · 1 note proposal(s): "2026-09-30: cap $4,000 CAD"');
    expect(formatSmokeTurn(line({ status: 'FAIL', error: 'memory check: the owner stated a durable fact but the answer proposed no note' }))).toBe('FAIL turn 1 · "q" · 3 tools · 18.2K in (15.9K cached) · 2.4K out · $0.19 USD · 21s · memory check: the owner stated a durable fact but the answer proposed no note');
  });
});
