/**
 * Dispatch history + stuck incidents (DB side of lib/dispatch.ts's fairness
 * and status contract, 2026-09-30).
 *
 * settings.dispatch_state holds each step's last success and its consecutive
 * timed-out / deferred count. A step at STUCK_THRESHOLD gets ONE open
 * `dispatch_stuck` incident naming it (refreshed while stuck); the incident
 * resolves itself the first time the step completes again.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, syncIncidents } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from './settings';
import { parseDispatchState, type DispatchAssessment, type DispatchState, type StepOutcome } from './dispatch';

export async function readDispatchState(): Promise<DispatchState> {
  return parseDispatchState(await getSetting(SETTING_KEYS.dispatchState));
}

export async function writeDispatchState(state: DispatchState): Promise<void> {
  await setSetting(SETTING_KEYS.dispatchState, JSON.stringify(state));
}

const STUCK_KIND = 'dispatch_stuck';

/** Open / refresh an incident per stuck step; resolve the ones whose step completed (anything but timed_out / deferred). */
export async function syncStuckIncidents(assessment: DispatchAssessment, outcomes: Record<string, StepOutcome>): Promise<void> {
  const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, STUCK_KIND), isNull(syncIncidents.resolvedAt)));
  const openByStep = new Map(open.map((i) => [String((i.details as { step?: string } | null)?.step ?? ''), i]));
  const now = new Date();

  for (const s of assessment.stuck) {
    const what = s.as === 'timed_out' ? 'timed out' : 'was deferred for the time budget';
    const message = `Dispatch step "${s.name}" ${what} ${s.count} runs in a row — it is not completing.`;
    const details = { step: s.name, count: s.count, as: s.as, reason: 'reason' in outcomes[s.name] ? (outcomes[s.name] as { reason: string }).reason : (outcomes[s.name] as { error?: string }).error ?? null };
    const existing = openByStep.get(s.name);
    if (existing) {
      await db.update(syncIncidents).set({ message, details }).where(eq(syncIncidents.id, existing.id));
    } else {
      await db.insert(syncIncidents).values({ kind: STUCK_KIND, severity: 'critical', message, details });
    }
  }

  for (const [step, incident] of openByStep) {
    const o = outcomes[step];
    if (o && o.status !== 'timed_out' && o.status !== 'deferred') {
      await db
        .update(syncIncidents)
        .set({ resolvedAt: now, details: sql`coalesce(${syncIncidents.details}, '{}'::jsonb) || ${JSON.stringify({ resolvedBy: `step ${o.status}` })}::jsonb` })
        .where(eq(syncIncidents.id, incident.id));
    }
  }
}
