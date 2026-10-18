/**
 * Companion stage 2 — the chip's view of a log (My day): the newest live log per event, reduced to what the card
 * shows. Kept apart from `log.ts` so the day service does not pull the GHL write module into its import graph.
 */

import { actionsForEvents, effectiveState, failedStepOf, undoUntil } from './actions';
import type { CallAction } from './day';

export async function callActionsForEvents(eventIds: string[], now: Date): Promise<Map<string, CallAction>> {
  const rows = await actionsForEvents(eventIds);
  const out = new Map<string, CallAction>();
  for (const [eventId, r] of rows) {
    const e = effectiveState(r, now);
    out.set(eventId, {
      id: r.id,
      state: e.state,
      label: r.label,
      outcomeKey: r.outcomeKey,
      createdAt: r.createdAt.toISOString(),
      undoUntil: undoUntil(r.createdAt).toISOString(),
      failedStep: e.state === 'partial' || e.state === 'failed' ? failedStepOf(r.steps) : null,
      error: e.stale ? 'the function stopped mid-way and nothing resumed it — retry' : r.error,
    });
  }
  return out;
}
