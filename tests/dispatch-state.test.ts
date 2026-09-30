/** Stuck dispatch steps: one open incident per step, refreshed while stuck, resolved when it completes; state round-trips. */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, syncIncidents } from '@/db';
import { assessDispatch, nextDispatchState, runDispatch, orderSteps, NOT_CONFIGURED_REASON, type DispatchState, type StepOutcome } from '@/lib/dispatch';
import { readDispatchState, writeDispatchState, syncStuckIncidents } from '@/lib/dispatchState';

beforeAll(async () => {
  await runMigrations();
});

const deferred: StepOutcome = { status: 'deferred', reason: 'time budget reached before this step' };

describe('dispatch state + stuck incidents', () => {
  it('persists the history', async () => {
    expect(await readDispatchState()).toEqual({});
    const s: DispatchState = { daily: { stuck: 2, lastStuck: 'deferred', lastSucceededAt: '2026-09-29T13:00:00.000Z' } };
    await writeDispatchState(s);
    expect(await readDispatchState()).toEqual(s);
  });

  it('opens ONE incident naming the stuck step, refreshes it, and resolves it when the step completes', async () => {
    let state: DispatchState = { daily: { stuck: 2 } };
    state = nextDispatchState(state, { daily: deferred }, '2026-09-30T10:00:00Z');
    await syncStuckIncidents(assessDispatch({ daily: deferred }, state), { daily: deferred });
    state = nextDispatchState(state, { daily: deferred }, '2026-09-30T11:00:00Z');
    await syncStuckIncidents(assessDispatch({ daily: deferred }, state), { daily: deferred });

    const open = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'dispatch_stuck'));
    expect(open).toHaveLength(1);
    expect(open[0].message).toBe('Dispatch step "daily" was deferred for the time budget 4 runs in a row — it is not completing.');
    expect(open[0]).toMatchObject({ severity: 'critical', resolvedAt: null });

    const ok: StepOutcome = { status: 'succeeded', durationMs: 4, result: { status: 'sent' } };
    state = nextDispatchState(state, { daily: ok }, '2026-09-30T12:00:00Z');
    await syncStuckIncidents(assessDispatch({ daily: ok }, state), { daily: ok });
    const [after] = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'dispatch_stuck'));
    expect(after.resolvedAt).not.toBeNull();
  });
});

// 2026-09-30 (Mitchell): a step skipped as "not configured" (Google, an unconnected Anthropic key) must never count
// toward the deferred/stuck rule, never open dispatch_stuck, and never make the dispatch return 500.
describe('not configured is a skip, never stuck', () => {
  it('Google + Anthropic unconfigured for 5 consecutive dispatches: skipped every time, stuck 0, no incident, HTTP 200', async () => {
    let state: DispatchState = {};
    const bodies: unknown[] = [];
    for (let run = 1; run <= 5; run += 1) {
      const steps = [
        { name: 'stripe', ownsRun: true, run: async () => ({ ok: true, mode: 'delta', stats: { charges: 0 } }) },
        { name: 'google', ownsRun: true, run: async () => ({ ok: false, notConfigured: true, error: 'Google Ads is not connected.' }) },
        { name: 'insights', run: async () => ({ ok: false, notConfigured: true, findings: [], error: 'Anthropic not configured' }) },
        { name: 'daily', skip: 'before 6am local', run: async () => ({}) },
      ];
      const result = await runDispatch(orderSteps(steps, state));
      state = nextDispatchState(state, result.steps, `2026-09-30T0${run}:00:00.000Z`);
      const a = assessDispatch(result.steps, state);
      await syncStuckIncidents(a, result.steps);
      expect(result.steps.google).toEqual({ status: 'skipped', reason: NOT_CONFIGURED_REASON });
      expect(result.steps.insights).toEqual({ status: 'skipped', reason: NOT_CONFIGURED_REASON });
      expect(a).toMatchObject({ httpStatus: 200, ok: true, partial: false, failed: [], stuck: [], deferred: [] });
      bodies.push({ ok: a.ok, partial: a.partial, failed: a.failed, stuck: a.stuck, deferred: a.deferred, order: result.order, steps: result.steps });
    }
    expect(state.google).toMatchObject({ stuck: 0 });
    expect(state.google.lastSucceededAt).toBeUndefined(); // a skip is not a success either
    expect(state.insights).toMatchObject({ stuck: 0 });
    expect(await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'dispatch_stuck'))).toHaveLength(1); // only the one from the earlier test (resolved)
    const open = (await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'dispatch_stuck'))).filter((i) => !i.resolvedAt);
    expect(open).toHaveLength(0);

    // The shape of a healthy dispatch response with Google unconfigured (documented in CLAUDE.md).
    expect(bodies[4]).toMatchObject({
      ok: true,
      partial: false,
      failed: [],
      stuck: [],
      deferred: [],
      steps: {
        stripe: { status: 'succeeded' },
        google: { status: 'skipped', reason: 'not configured — no credentials for this step' },
        insights: { status: 'skipped', reason: 'not configured — no credentials for this step' },
        daily: { status: 'skipped', reason: 'before 6am local' },
      },
    });
  });
});
