/**
 * Companion stage 1 — the day's calls, their status by the clock, the counter and the auto-selection (pure).
 *
 * Status (one chip per card):
 *   ghl_outcome    GHL already holds an outcome (showed / no-show / cancelled) — shown as "Showed in GHL" etc.;
 *                  a cancelled call is never "up next" and is skipped by the auto-selection
 *   up_next        starts later
 *   in_progress    now is between start and end (end defaults to start + 30 min)
 *   needs_outcome  ended, no outcome anywhere
 *   logged         logged in the Companion (stage 2): the newest live log for the event is ok (or still running)
 *   dry_run        logged while dry run was on — recorded in FitFlow, nothing sent to GHL
 *   failed         the newest log is partial / failed — stays red until retried or undone
 */

import type { CallType } from './calendars';

export type CallStatus = 'up_next' | 'in_progress' | 'needs_outcome' | 'logged' | 'dry_run' | 'failed' | 'ghl_outcome';
export type GhlOutcome = 'showed' | 'no_show' | 'cancelled';

export const DEFAULT_CALL_MINUTES = 30;
/** "Current" = a call whose start is within this many minutes of now, either side. */
export const CURRENT_WINDOW_MINUTES = 10;

export interface CompanionCall {
  eventId: string;
  calendarId: string;
  calendarName: string;
  callType: CallType;
  title: string | null;
  startIso: string;
  endIso: string | null;
  ghlContactId: string;
  /** FitFlow's contact id when the person is in the mirror (links the brief to the profile data). */
  contactId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  stage: { name: string; role: string | null; pipeline: string | null } | null;
  /** GHL's own appointmentStatus, verbatim. */
  ghlStatus: string | null;
  outcomeInGhl: GhlOutcome | null;
  status: CallStatus;
  /** True when a live (not undone) Companion log exists for the event. */
  logged: boolean;
  /** The newest live log for the event (stage 2), for the chip and the pop-out. */
  action: CallAction | null;
}

/** What My day knows about a log (the full view is GET /api/companion/actions/{id}). */
export interface CallAction {
  id: string;
  state: 'running' | 'ok' | 'partial' | 'failed' | 'dry_run' | 'undone';
  label: string;
  outcomeKey: string;
  createdAt: string;
  undoUntil: string;
  failedStep: string | null;
  error: string | null;
}

export interface DayCounts {
  calls: number;
  logged: number;
  needOutcome: number;
  failed: number;
}

/** GHL's appointmentStatus → the outcome it already records (null while nothing is recorded). */
export function outcomeInGhlOf(status: string | null | undefined): GhlOutcome | null {
  switch ((status ?? '').toLowerCase()) {
    case 'showed':
      return 'showed';
    case 'noshow':
    case 'no_show':
      return 'no_show';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return null;
  }
}

export function endOf(call: { startIso: string; endIso: string | null }): number {
  const start = Date.parse(call.startIso);
  const end = call.endIso ? Date.parse(call.endIso) : NaN;
  return Number.isFinite(end) && end > start ? end : start + DEFAULT_CALL_MINUTES * 60_000;
}

export function statusOf(call: { startIso: string; endIso: string | null; outcomeInGhl: GhlOutcome | null; logged?: boolean; action?: Pick<CallAction, 'state'> | null }, now: Date): CallStatus {
  const a = call.action ?? null;
  if (a) {
    if (a.state === 'partial' || a.state === 'failed') return 'failed';
    if (a.state === 'dry_run') return 'dry_run';
    if (a.state !== 'undone') return 'logged';
  } else if (call.logged) return 'logged';
  if (call.outcomeInGhl) return 'ghl_outcome';
  const t = now.getTime();
  const start = Date.parse(call.startIso);
  if (t < start) return 'up_next';
  if (t < endOf(call)) return 'in_progress';
  return 'needs_outcome';
}

/** The header counter: "N calls · N logged · N need an outcome" (+ "N failed" when any). Dry runs count as logged. */
export function summarize(calls: ReadonlyArray<{ status: CallStatus }>): DayCounts {
  return {
    calls: calls.length,
    logged: calls.filter((c) => c.status === 'logged' || c.status === 'dry_run').length,
    needOutcome: calls.filter((c) => c.status === 'needs_outcome').length,
    failed: calls.filter((c) => c.status === 'failed').length,
  };
}

/**
 * Which call the pop-out opens on: the one starting within ±10 min of now (closest wins); else the one in progress;
 * else the next upcoming; else the last of the day. Cancelled calls are skipped. −1 when there is nothing.
 */
export function selectCurrent(calls: ReadonlyArray<{ startIso: string; endIso: string | null; outcomeInGhl: GhlOutcome | null }>, now: Date): number {
  const t = now.getTime();
  const live = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.outcomeInGhl !== 'cancelled');
  if (live.length === 0) return -1;
  const window = CURRENT_WINDOW_MINUTES * 60_000;
  let best: { i: number; d: number } | null = null;
  for (const { c, i } of live) {
    const d = Math.abs(Date.parse(c.startIso) - t);
    if (d <= window && (!best || d < best.d)) best = { i, d };
  }
  if (best) return best.i;
  const inProgress = live.find(({ c }) => Date.parse(c.startIso) <= t && t < endOf(c));
  if (inProgress) return inProgress.i;
  const upcoming = live.filter(({ c }) => Date.parse(c.startIso) > t).sort((a, b) => Date.parse(a.c.startIso) - Date.parse(b.c.startIso));
  if (upcoming.length) return upcoming[0].i;
  return live[live.length - 1].i;
}
