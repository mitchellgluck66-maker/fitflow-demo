/**
 * Cost before and during a run (Analyst plan item 7): the estimate from a
 * token count, the per-run and monthly caps, the in-loop pause. All USD.
 */
import { describe, it, expect } from 'vitest';
import { capDecision, estimateRunUsd, shouldPause, RUN_ALLOWANCE } from '@/lib/analyst/cost';

describe('estimateRunUsd', () => {
  it('prices the prefix as one cache write then cache reads, accumulating tool tokens, plus the output allowance', () => {
    const e = estimateRunUsd('claude-opus-5-5', 30_000, 'ask');
    const a = RUN_ALLOWANCE.ask;
    let usd = (30_000 * 5) / 1e6;
    for (let r = 2; r <= a.rounds; r++) usd += (30_000 * 0.2 + (r - 1) * a.toolTokensPerRound * 4) / 1e6;
    usd += (a.outputTokens * 20) / 1e6;
    expect(e.usd).toBe(Math.round(usd * 100) / 100);
    expect(e.detail).toBe('~4 rounds · 30K prompt (cached after round 1) · 3K out');
    expect(estimateRunUsd('claude-fable-5-1', 30_000, 'report').usd).toBeGreaterThan(e.usd);
    expect(() => estimateRunUsd('claude-sonnet-5', 1, 'ask')).toThrow(/No price table/);
  });
});

describe('capDecision', () => {
  it('allows under both caps; asks over the per-run cap; asks when the month would be exceeded; a confirmed amount unlocks', () => {
    expect(capDecision({ estimateUsd: 0.4, capRunUsd: 3, spentMonthUsd: 10, capMonthUsd: 150 })).toEqual({ allowed: true, needsConfirmation: false, reason: null });
    expect(capDecision({ estimateUsd: 4.1, capRunUsd: 3, spentMonthUsd: 10, capMonthUsd: 150 })).toEqual({ allowed: false, needsConfirmation: true, reason: 'This run is estimated at $4.10 USD, above your $3.00 USD per-run cap' });
    expect(capDecision({ estimateUsd: 1, capRunUsd: 3, spentMonthUsd: 149.5, capMonthUsd: 150 })).toEqual({ allowed: false, needsConfirmation: true, reason: 'This run ($1.00 USD) would take this month to $150.50 USD, above your $150.00 USD monthly budget' });
    expect(capDecision({ estimateUsd: 4.1, capRunUsd: 3, spentMonthUsd: 149.5, capMonthUsd: 150, confirmedUsd: 4.1 })).toEqual({ allowed: true, needsConfirmation: false, reason: null });
    expect(capDecision({ estimateUsd: 4.1, capRunUsd: 3, spentMonthUsd: 0, capMonthUsd: 150, confirmedUsd: 3 }).needsConfirmation).toBe(true);
  });
});

describe('shouldPause', () => {
  it('pauses only when spent plus the next round exceeds what was allowed', () => {
    expect(shouldPause({ spentUsd: 2.5, nextRoundUsd: 0.4, allowedUsd: 3 })).toEqual({ pause: false, reason: null });
    expect(shouldPause({ spentUsd: 2.8, nextRoundUsd: 0.4, allowedUsd: 3 })).toEqual({ pause: true, reason: 'Spent $2.80 USD so far; the next round would take this run to about $3.20 USD, above the $3.00 USD allowed' });
  });
});
