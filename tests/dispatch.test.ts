/** Dispatch isolation: one step's failure, hang or ok=false never stops the others; every outcome is recorded. */
import { describe, it, expect } from 'vitest';
import { runDispatch, type StepOutcome } from '@/lib/dispatch';

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
