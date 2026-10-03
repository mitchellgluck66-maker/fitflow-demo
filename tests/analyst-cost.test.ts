/**
 * Cost before and during a run (Analyst plan item 7): the estimate from a
 * token count, the per-run and monthly caps, the in-loop pause. All USD.
 */
import { describe, it, expect } from 'vitest';
import { calibrationFactor, capDecision, estimateRunUsd, shouldPause, RUN_ALLOWANCE } from '@/lib/analyst/cost';

describe('estimateRunUsd (item 5 model)', () => {
  it('prices the prefix as one cache write then reads; each round writes its tool tokens once and reads the earlier ones; thinking per round + the answer; uncalibrated with no history', () => {
    const e = estimateRunUsd('claude-opus-5-5', 30_000, 'ask');
    const a = RUN_ALLOWANCE.ask;
    let usd = (30_000 * 8) / 1e6; // the prefix is written at the 1-hour rate on Opus (item C)
    for (let r = 2; r <= a.rounds; r++) usd += (30_000 * 0.2 + (r - 2) * a.toolTokensPerRound * 0.2 + a.toolTokensPerRound * 5) / 1e6;
    usd += ((a.rounds * a.thinkingPerRound + a.answerTokens) * 20) / 1e6;
    expect(e.usd).toBe(Math.round(usd * 100) / 100);
    expect(e.detail).toBe('~4 rounds · 30K prompt (cached after round 1) · 10K out · uncalibrated (no completed runs of this kind yet)');
    expect(e).toMatchObject({ calibration: 1, calibrationRuns: 0, rounds: 4 });
    expect(estimateRunUsd('claude-fable-5-1', 30_000, 'report').usd).toBeGreaterThan(e.usd);
    expect(() => estimateRunUsd('claude-sonnet-5', 1, 'ask')).toThrow(/No price table/);
  });
  it('the first live smoke (Opus, ~30K prompt) is within the $0.40 target when the rounds hold', () => {
    expect(estimateRunUsd('claude-opus-5-5', 30_000, 'ask').usd).toBeLessThanOrEqual(0.6); // conservative for the cap; the smoke measures the real figure
  });
  it('calibration: median of actual ÷ estimate over completed runs, clamped to [0.5, 3], applied to the estimate and named in the detail', () => {
    expect(calibrationFactor([])).toEqual({ factor: 1, runs: 0 });
    expect(calibrationFactor([{ estimateUsd: 0.5, costUsd: 0.82 }, { estimateUsd: 0.6, costUsd: 0.86 }, { estimateUsd: 0.7, costUsd: 1.06 }])).toEqual({ factor: 1.51, runs: 3 }); // 1.64, 1.43, 1.51 → median 1.51
    expect(calibrationFactor([{ estimateUsd: 1, costUsd: 9 }])).toEqual({ factor: 3, runs: 1 });
    expect(calibrationFactor([{ estimateUsd: 1, costUsd: 0.1 }])).toEqual({ factor: 0.5, runs: 1 });
    expect(calibrationFactor([{ estimateUsd: 0, costUsd: 1 }, { estimateUsd: 1, costUsd: 0 }])).toEqual({ factor: 1, runs: 0 }); // nothing usable
    const base = estimateRunUsd('claude-opus-5-5', 30_000, 'ask');
    const cal = estimateRunUsd('claude-opus-5-5', 30_000, 'ask', { factor: 1.5, runs: 12 });
    expect(cal.usd).toBe(Math.round(base.usd * 1.5 * 100) / 100);
    expect(cal.detail).toContain('calibrated ×1.5 on 12 runs');
    expect(cal).toMatchObject({ calibration: 1.5, calibrationRuns: 12 });
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
