/**
 * Companion stage 3 — the Onboarding page's view of the Companion logs: the newest live (not undone) log per
 * event with its after-stage ROLE resolved through the stages table, else the newest undone one. The only file
 * under lib/onboarding that reads `companion_actions`.
 */

import { desc, inArray } from 'drizzle-orm';
import { db, companionActions, stages, type CompanionAction } from '@/db';
import { effectiveState, failedStepOf, STEP_ORDER, undoUntil } from '../companion/actions';
import type { CallAction } from '../companion/day';
import type { OnboardingLog, StepName, StepState, UndoneLog } from './numbers';

export interface EventLogs {
  log: OnboardingLog | null;
  undone: UndoneLog | null;
  /** Stage 1's chip shape for the same log (feeds `statusOf`). */
  callAction: CallAction | null;
}

function stepStates(row: CompanionAction): Record<StepName, StepState> {
  const out = { stage: 'pending', appointment: 'pending', note: 'pending' } as Record<StepName, StepState>;
  for (const n of STEP_ORDER) {
    const r = row.steps[n];
    out[n] = r ? (r.status as StepState) : 'pending';
  }
  return out;
}

/** Pure: one Companion row → the page's log shape (the role comes from the caller's stage lookup). */
export function toOnboardingLog(row: CompanionAction, now: Date, roleOf: (stageId: string | null) => string | null): OnboardingLog {
  const e = effectiveState(row, now);
  const state = e.state === 'undone' ? 'ok' : e.state; // never called with an undone row
  const failed = state === 'partial' || state === 'failed';
  return {
    id: row.id,
    state,
    stale: e.stale,
    outcomeKey: row.outcomeKey,
    label: row.label,
    note: row.note,
    userName: row.userName,
    createdAt: row.createdAt.toISOString(),
    dryRun: row.dryRun,
    before: { stageName: row.before.stageName, status: row.before.status, appointmentStatus: row.before.appointmentStatus },
    after: { stageName: row.after.stageName, status: row.after.status, appointmentStatus: row.after.appointmentStatus, role: roleOf(row.after.stageId) },
    steps: stepStates(row),
    failedStep: failed ? failedStepOf(row.steps) : null,
    error: e.stale ? 'the function stopped mid-way and nothing resumed it — retry' : row.error,
  };
}

export function toCallAction(log: OnboardingLog, row: CompanionAction): CallAction {
  return { id: log.id, state: log.state, label: log.label, outcomeKey: log.outcomeKey, createdAt: log.createdAt, undoUntil: undoUntil(row.createdAt).toISOString(), failedStep: log.failedStep, error: log.error };
}

export async function onboardingLogsForEvents(eventIds: string[], now: Date): Promise<Map<string, EventLogs>> {
  const out = new Map<string, EventLogs>();
  if (eventIds.length === 0) return out;
  const rows = await db.select().from(companionActions).where(inArray(companionActions.ghlEventId, eventIds)).orderBy(desc(companionActions.createdAt));
  const stageIds = Array.from(new Set(rows.map((r) => r.after.stageId).filter((s): s is string => Boolean(s))));
  const roles = new Map<string, string | null>();
  if (stageIds.length) {
    for (const s of await db.select({ id: stages.id, role: stages.semanticRole }).from(stages).where(inArray(stages.id, stageIds))) roles.set(s.id, s.role ?? null);
  }
  const roleOf = (id: string | null) => (id ? (roles.get(id) ?? null) : null);
  const live = new Map<string, CompanionAction>();
  const undone = new Map<string, CompanionAction>();
  for (const r of rows) {
    if (!r.ghlEventId) continue;
    if (r.state === 'undone') {
      if (!undone.has(r.ghlEventId)) undone.set(r.ghlEventId, r);
    } else if (!live.has(r.ghlEventId)) live.set(r.ghlEventId, r);
  }
  for (const id of eventIds) {
    const l = live.get(id);
    if (l) {
      const log = toOnboardingLog(l, now, roleOf);
      out.set(id, { log, undone: null, callAction: toCallAction(log, l) });
      continue;
    }
    const u = undone.get(id);
    out.set(id, { log: null, undone: u ? { label: u.label, undoneBy: u.undoneBy, undoneAt: u.undoneAt?.toISOString() ?? null } : null, callAction: null });
  }
  return out;
}
