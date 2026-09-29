/** Dispatch isolation: one step's failure, hang or ok=false never stops the others; every outcome is recorded. */
import { describe, it, expect } from 'vitest';
import { runDispatch, statsForOutcome, outcomeReason, type StepOutcome } from '@/lib/dispatch';

describe('runDispatch', () => {
  it('runs every step in order; a throw, a hang and an ok=false result are recorded and the chain continues', async () => {
    const calls: string[] = [];
    const recorded: Array<[string, StepOutcome]> = [];
    const result = await runDispatch(
      [
        { name: 'stripe', ownsRun: true, run: async () => { calls.push('stripe'); return { ok: true, stats: { charges: 3 } }; } },
        { name: 'meta', ownsRun: true, run: async () => { calls.push('meta'); throw new Error('Meta 500 unknown error'); } },
        { name: 'ghl', ownsRun: true, timeoutMs: 20, run: () => new Promise(() => { calls.push('ghl'); /* never resolves */ }) },
        { name: 'reconcile', run: async () => { calls.push('reconcile'); return { ok: false, error: 'boom' }; } },
        { name: 'insights', run: async () => { calls.push('insights'); return { ok: false, notConfigured: true }; } },
        { name: 'daily', skip: 'before 7am local', run: async () => { calls.push('daily'); } },
        { name: 'weekly', run: async () => { calls.push('weekly'); return { status: 'stored' }; } },
      ],
      { record: async (name, outcome) => { recorded.push([name, outcome]); } },
    );
    expect(calls).toEqual(['stripe', 'meta', 'ghl', 'reconcile', 'insights', 'weekly']);
    expect(result.order).toEqual(['stripe', 'meta', 'ghl', 'reconcile', 'insights', 'daily', 'weekly']);
    expect(result.steps.stripe.status).toBe('succeeded');
    expect(result.steps.meta).toMatchObject({ status: 'failed', error: 'Meta 500 unknown error' });
    expect(result.steps.ghl.status).toBe('timed_out');
    expect(result.steps.reconcile).toMatchObject({ status: 'failed', error: 'boom' });
    expect(result.steps.insights.status).toBe('succeeded'); // not connected is not a failure
    expect(result.steps.daily).toEqual({ status: 'skipped', reason: 'before 7am local' });
    expect(result.steps.weekly.status).toBe('succeeded');
    expect(result.ok).toBe(false);
    // Sources own their sync_runs rows; everything else is recorded by the dispatcher.
    expect(recorded.map(([n]) => n)).toEqual(['reconcile', 'insights', 'daily', 'weekly']);
  });

  it('a step that would start after the invocation budget is recorded as skipped, not dropped', async () => {
    let t = 0;
    const now = () => t;
    const calls: string[] = [];
    const result = await runDispatch(
      [
        { name: 'a', run: async () => { calls.push('a'); t += 30_000; } },
        { name: 'b', run: async () => { calls.push('b'); t += 30_000; } },
        { name: 'c', run: async () => { calls.push('c'); } },
      ],
      { now, budgetMs: 50_000 },
    );
    expect(calls).toEqual(['a', 'b']);
    expect(result.steps.c).toMatchObject({ status: 'skipped' });
    expect((result.steps.c as { reason: string }).reason).toMatch(/time budget/);
    expect(result.ok).toBe(true);
  });

  it('a recorder that throws never breaks the chain', async () => {
    const result = await runDispatch([{ name: 'x', run: async () => 1 }, { name: 'y', run: async () => 2 }], {
      record: async () => {
        throw new Error('db down');
      },
    });
    expect(result.steps.x.status).toBe('succeeded');
    expect(result.steps.y.status).toBe('succeeded');
  });
});

// 2026-09-29: an empty stats {} on a skipped step is not observability — every dispatch row's stats carry a reason
describe('statsForOutcome — a skipped, stored or partial step says why', () => {
  it('a skipped step records its reason; failed and timed-out steps their error', () => {
    expect(statsForOutcome({ status: 'skipped', reason: 'waiting for the tracked phases of the GHL cycle — paused at pipeline 2/15 "Nurture", page 3 (phase mirrors)' })).toEqual({ reason: 'waiting for the tracked phases of the GHL cycle — paused at pipeline 2/15 "Nurture", page 3 (phase mirrors)' });
    expect(statsForOutcome({ status: 'failed', durationMs: 120, error: 'boom' })).toEqual({ durationMs: 120, reason: 'boom' });
    expect(statsForOutcome({ status: 'timed_out', durationMs: 25_000, error: 'no result after 25s' })).toEqual({ durationMs: 25_000, reason: 'no result after 25s' });
  });

  it('a step that "succeeded" by doing nothing says what it did not do', () => {
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { kind: 'daily_todo', status: 'stored' } })).toBe('stored, not sent — RESEND_API_KEY / RESEND_FROM_EMAIL not configured');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { status: 'skipped_empty' } })).toBe('skipped — the digest was empty');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: false, notConfigured: true } })).toBe('not configured — no credentials for this step');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, skipped: 'waiting for the tracked phases of the GHL cycle — the sync did not run' } })).toMatch(/^waiting for the tracked phases/);
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, partial: true, progress: 'paused at pipeline 3/15 "Alumni", page 2 (phase mirrors)' } })).toBe('partial — paused at pipeline 3/15 "Alumni", page 2 (phase mirrors)');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, cached: true } })).toBe('served from cache — inputs unchanged');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, stats: { charges: 3 } } })).toBeNull();
    expect(statsForOutcome({ status: 'succeeded', durationMs: 3, result: { status: 'sent' } })).toEqual({ durationMs: 3 });
  });
});
