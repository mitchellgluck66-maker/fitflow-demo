/** Stuck dispatch steps: one open incident per step, refreshed while stuck, resolved when it completes; state round-trips. */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, syncIncidents } from '@/db';
import { assessDispatch, nextDispatchState, type DispatchState, type StepOutcome } from '@/lib/dispatch';
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
