/** Dispatch isolation: one step's failure, hang or ok=false never stops the others; every outcome is recorded. */
import { describe, it, expect } from 'vitest';
import {
  runDispatch, statsForOutcome, outcomeReason, orderSteps, nextDispatchState, assessDispatch, ghlFallbackGate, reconcileGate,
  STUCK_THRESHOLD, type StepOutcome, type DispatchState,
} from '@/lib/dispatch';

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
        { name: 'daily', skip: 'before 6am local', run: async () => { calls.push('daily'); } },
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
    expect(result.steps.insights).toEqual({ status: 'skipped', reason: 'not configured — no credentials for this step' }); // did nothing → skipped, never succeeded
    expect(result.steps.daily).toEqual({ status: 'skipped', reason: 'before 6am local' });
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
    expect(result.steps.c).toMatchObject({ status: 'deferred' });
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
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { status: 'already_recorded', error: 'already stored for this period' } })).toBe('already stored for this period — not re-archived');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { status: 'retries_exhausted', error: '3 failed attempts for this period — use Send now on /reports' } })).toMatch(/^gave up — 3 failed attempts/);
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, skipped: 'another GHL sync is already running (started …) — skipped' } })).toMatch(/already running/);
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: false, notConfigured: true } })).toBe('not configured — no credentials for this step');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, skipped: 'waiting for the tracked phases of the GHL cycle — the sync did not run' } })).toMatch(/^waiting for the tracked phases/);
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, partial: true, progress: 'paused at pipeline 3/15 "Alumni", page 2 (phase mirrors)' } })).toBe('partial — paused at pipeline 3/15 "Alumni", page 2 (phase mirrors)');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, cached: true } })).toBe('served from cache — inputs unchanged');
    expect(outcomeReason({ status: 'succeeded', durationMs: 3, result: { ok: true, stats: { charges: 3 } } })).toBeNull();
    expect(statsForOutcome({ status: 'succeeded', durationMs: 3, result: { status: 'sent' } })).toEqual({ durationMs: 3 });
  });
});

// ---------------------------------------------------------------------------
// 2026-09-30: fairness + honest status (production: reconcile / sweep / prune /
// insights / daily were budget-skipped on every run for days; the run was 500).
// ---------------------------------------------------------------------------

const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);
const step = (name: string, after?: string[]) => ({ name, after });
const T = (h: number) => new Date(Date.UTC(2026, 8, 30, h)).toISOString();

describe('orderSteps — fairness', () => {
  const declared = [step('stripe'), step('meta'), step('ghl'), step('reconcile', ['ghl']), step('sweep'), step('insights'), step('daily')];

  it('never-succeeded and starved steps first (most starved first), then least-recently-successful', () => {
    const state: DispatchState = {
      stripe: { lastSucceededAt: T(3), stuck: 0 },
      meta: { lastSucceededAt: T(3), stuck: 0 },
      ghl: { lastSucceededAt: T(1), stuck: 0 },
      reconcile: { lastSucceededAt: T(0), stuck: 2, lastStuck: 'deferred' },
      sweep: { lastSucceededAt: T(0), stuck: 1, lastStuck: 'deferred' },
      // insights: never succeeded
      daily: { lastSucceededAt: T(2), stuck: 0 },
    };
    // reconcile is the most starved; its dependency ghl is pulled forward to run just before it.
    expect(names(orderSteps(declared, state))).toEqual(['ghl', 'reconcile', 'sweep', 'insights', 'daily', 'stripe', 'meta']);
  });

  it('an empty history keeps the declared order', () => {
    expect(names(orderSteps(declared, {}))).toEqual(names(declared));
  });

  it('`after` pulls a dependency ahead of its dependent whatever the ranking', () => {
    const state: DispatchState = { weekly: { stuck: 3 }, narrative_weekly: { lastSucceededAt: T(5), stuck: 0 }, stripe: { lastSucceededAt: T(1), stuck: 0 } };
    const out = names(orderSteps([step('stripe'), step('narrative_weekly'), step('weekly', ['narrative_weekly'])], state));
    expect(out.indexOf('narrative_weekly')).toBeLessThan(out.indexOf('weekly'));
    // a dependency that is not in this run (filtered by ?only=) does not block
    expect(names(orderSteps([step('weekly', ['narrative_weekly']), step('stripe')], state))).toEqual(['weekly', 'stripe']);
  });

  it('a budget-deferred step reaches the front of the next dispatch and runs within a few heartbeats', async () => {
    // Simulate: each step costs 20 s, budget 50 s → 3 steps per run (the 3rd starts at 40 s). 7 steps.
    let state: DispatchState = {};
    const ran = new Map<string, number>();
    for (let run = 1; run <= 3; run += 1) {
      let t = 0;
      const result = await runDispatch(
        orderSteps(declared, state).map((s) => ({ ...s, run: async () => { ran.set(s.name, ran.get(s.name) ?? run); t += 20_000; } })),
        { now: () => t, budgetMs: 50_000 },
      );
      state = nextDispatchState(state, result.steps, T(run));
    }
    // Every step ran by the 3rd heartbeat — nothing starves.
    expect([...ran.keys()].sort()).toEqual(names(declared).sort());
    expect(Math.max(...ran.values())).toBeLessThanOrEqual(3);
  });
});

describe('assessDispatch — the status contract', () => {
  const ok: StepOutcome = { status: 'succeeded', durationMs: 5, result: {} };
  const deferred: StepOutcome = { status: 'deferred', reason: 'time budget reached' };
  const timedOut: StepOutcome = { status: 'timed_out', durationMs: 25_000, error: 'no result after 25s' };

  it('deferrals and a single timeout are 200 ok + partial', () => {
    const outcomes = { stripe: timedOut, daily: deferred, meta: ok };
    const a = assessDispatch(outcomes, nextDispatchState({}, outcomes, T(1)));
    expect(a).toMatchObject({ httpStatus: 200, ok: true, partial: true, failed: [], stuck: [] });
    expect(a.deferred.sort()).toEqual(['daily', 'stripe']);
  });

  it('a failed step is 500', () => {
    const outcomes = { meta: { status: 'failed', durationMs: 3, error: 'Meta 500' } as StepOutcome, stripe: ok };
    const a = assessDispatch(outcomes, nextDispatchState({}, outcomes, T(1)));
    expect(a).toMatchObject({ httpStatus: 500, ok: false, failed: [{ name: 'meta', error: 'Meta 500' }] });
  });

  it(`the same step deferred or timed out ${STUCK_THRESHOLD} consecutive runs is stuck (500); any completion resets it`, () => {
    let state: DispatchState = {};
    const statuses: number[] = [];
    for (const o of [deferred, timedOut, deferred]) {
      state = nextDispatchState(state, { daily: o }, T(1));
      statuses.push(assessDispatch({ daily: o }, state).httpStatus);
    }
    expect(statuses).toEqual([200, 200, 500]);
    expect(assessDispatch({ daily: deferred }, state).stuck).toEqual([{ name: 'daily', count: 3, as: 'deferred' }]);

    state = nextDispatchState(state, { daily: ok }, T(2));
    expect(state.daily).toMatchObject({ stuck: 0, lastSucceededAt: T(2) });
    // A gate skip ("not Monday") is not starvation either.
    const skipped: StepOutcome = { status: 'skipped', reason: 'not Monday' };
    state = nextDispatchState({ weekly: { stuck: 2 } }, { weekly: skipped }, T(3));
    expect(state.weekly.stuck).toBe(0);
    expect(state.weekly.lastSucceededAt).toBeUndefined();
  });

  it('different steps each deferred once are not stuck', () => {
    let state: DispatchState = {};
    for (const name of ['a', 'b', 'c']) state = nextDispatchState(state, { [name]: deferred }, T(1));
    expect(assessDispatch({ c: deferred }, state).httpStatus).toBe(200);
  });
});

describe('gates', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  it('ghl runs inside the dispatch only when no GHL run finished OK for 2 h', () => {
    expect(ghlFallbackGate(new Date(now.getTime() - 5 * 60_000), now)).toMatch(/5 min ago.*fallback after 2 h/);
    expect(ghlFallbackGate(new Date(now.getTime() - 2 * 3_600_000), now)).toBeNull();
    expect(ghlFallbackGate(null, now)).toBeNull();
  });

  it('reconcile waits for a complete read of the followed pipeline (its marker) and for no GHL run holding the lease', () => {
    expect(reconcileGate({ trackedCompletedAt: '2026-09-30T10:00:00Z', ghlRunLive: false })).toBeNull();
    expect(reconcileGate({ trackedCompletedAt: null, ghlRunLive: false })).toMatch(/no ghl.opportunities marker yet/);
    expect(reconcileGate({ trackedCompletedAt: '2026-09-30T10:00:00Z', ghlRunLive: true })).toMatch(/GHL sync is running/);
  });
});

describe('insight step reasons', () => {
  it('says how many findings were generated, or that the cache served them', () => {
    expect(outcomeReason({ status: 'succeeded', durationMs: 900, result: { ok: true, cached: false, findings: [{}, {}, {}] } })).toBe('generated 3 findings');
    expect(outcomeReason({ status: 'succeeded', durationMs: 900, result: { ok: true, cached: false, findings: [{}] } })).toBe('generated 1 finding');
    expect(outcomeReason({ status: 'succeeded', durationMs: 5, result: { ok: true, cached: true, findings: [{}] } })).toBe('served from cache — inputs unchanged');
  });
});
