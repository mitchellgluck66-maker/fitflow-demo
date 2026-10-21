/**
 * Companion stage 3 — Jake's view of the onboarding calls: ONE pure numbers function shared by the /onboarding
 * page, its CSV and the daily / weekly / monthly emails. A call is stage 1's call (status by the clock, GHL's own
 * outcome) joined to its newest non-undone Companion log (stage 2), with the log's after-stage ROLE resolved by the
 * service. Nothing here touches the database or the clock.
 *
 * Rules (docs/plan-companion-stage3.md):
 *   logged          a live (not undone) log exists, whatever its state — a failed log still recorded the outcome;
 *                   its GoHighLevel failure is a needs-attention item. Dry runs count as logged.
 *   showed          the log's after-appointment is "showed", or — with no log — GHL already records showed.
 *   no-show         likewise with "noshow" (consult · roadmap by call type).
 *   roadmapsBooked  CONSULT calls whose log's after stage resolves to the role roadmap_booked (a roadmap is booked
 *                   on a consult; a roadmap call whose stage merely stays "roadmap booked" is not one).
 *   enrolled        after role enrolled, or the deal marked won.      notFit  the deal marked lost.
 *   needsAttention  stage 1 status needs_outcome (ended, no log, no GHL outcome) + logs partial / failed.
 *   unlogged        ended calls with no live log, GHL-cancelled ones excepted (the weekly's "unlogged").
 *   showedPct       showed ÷ logged (the canvas: "4 · of 7 logged · 57%"); null when nothing is logged.
 */

import type { CallStatus, GhlOutcome } from '../companion/day';
import type { CallType } from '../companion/calendars';

export type LogState = 'running' | 'ok' | 'partial' | 'failed' | 'dry_run';
export type StepState = 'ok' | 'failed' | 'skipped' | 'pending';
export type StepName = 'stage' | 'appointment' | 'note';

export interface OnboardingPosition {
  stageName: string | null;
  status: string | null;
  appointmentStatus: string | null;
}

export interface OnboardingLog {
  id: string;
  state: LogState;
  /** A `running` row nobody touched for 2 min — presented as failed (stage 2's rule). */
  stale: boolean;
  outcomeKey: string;
  label: string;
  note: string;
  userName: string;
  createdAt: string;
  dryRun: boolean;
  before: OnboardingPosition;
  after: OnboardingPosition & { role: string | null };
  steps: Record<StepName, StepState>;
  failedStep: StepName | null;
  error: string | null;
}

export interface UndoneLog {
  label: string;
  undoneBy: string | null;
  undoneAt: string | null;
}

export interface OnboardingCall {
  eventId: string;
  /** Business-local calendar day. */
  date: string;
  startIso: string;
  endIso: string | null;
  /** "4:30 pm" in the business timezone (formatted by the service — the numbers function only copies it). */
  timeLabel: string;
  callType: CallType;
  calendarName: string;
  ghlContactId: string;
  contactId: string | null;
  name: string;
  /** The technician whose call it is. */
  userName: string;
  status: CallStatus;
  outcomeInGhl: GhlOutcome | null;
  /** True once the call's end has passed (the service compares against `now`). */
  ended: boolean;
  log: OnboardingLog | null;
  /** When no live log exists but one was undone: the newest undone log. */
  undone: UndoneLog | null;
}

export interface OnboardingNumbers {
  calls: number;
  consults: number;
  roadmaps: number;
  other: number;
  logged: number;
  /** Ended calls with no live log (GHL-cancelled ones excepted). */
  unlogged: number;
  showed: number;
  /** showed ÷ logged, 0..1; null when logged = 0. */
  showedPct: number | null;
  roadmapsBooked: number;
  enrolled: number;
  notFit: number;
  noShows: number;
  consultNoShows: number;
  roadmapNoShows: number;
  needsOutcome: number;
  failedLogs: number;
  needsAttention: number;
}

export type AttentionKind = 'needs_outcome' | 'failed_log';
export interface AttentionItem {
  eventId: string;
  kind: AttentionKind;
  /** "4:30 pm consult with Ben Sato has no outcome logged." */
  text: string;
  /** The log to retry (failed_log only). */
  logId: string | null;
}

const appt = (c: OnboardingCall): 'showed' | 'noshow' | 'cancelled' | null => {
  if (c.log) {
    const a = (c.log.after.appointmentStatus ?? '').toLowerCase();
    if (a === 'showed') return 'showed';
    if (a === 'noshow' || a === 'no_show') return 'noshow';
    if (a === 'cancelled' || a === 'canceled') return 'cancelled';
    return null;
  }
  if (c.outcomeInGhl === 'showed') return 'showed';
  if (c.outcomeInGhl === 'no_show') return 'noshow';
  if (c.outcomeInGhl === 'cancelled') return 'cancelled';
  return null;
};

export const isLogged = (c: OnboardingCall): boolean => c.log !== null;
export const isShowed = (c: OnboardingCall): boolean => appt(c) === 'showed';
export const isNoShow = (c: OnboardingCall): boolean => appt(c) === 'noshow';
export const isRoadmapBooked = (c: OnboardingCall): boolean => c.callType === 'Consult' && c.log?.after.role === 'roadmap_booked';
export const isEnrolled = (c: OnboardingCall): boolean => Boolean(c.log && (c.log.after.role === 'enrolled' || (c.log.after.status ?? '').toLowerCase() === 'won'));
export const isNotFit = (c: OnboardingCall): boolean => Boolean(c.log && (c.log.after.status ?? '').toLowerCase() === 'lost');
export const isFailedLog = (c: OnboardingCall): boolean => Boolean(c.log && (c.log.state === 'partial' || c.log.state === 'failed'));
export const needsOutcome = (c: OnboardingCall): boolean => c.status === 'needs_outcome';
export const needsAttention = (c: OnboardingCall): boolean => needsOutcome(c) || isFailedLog(c);
export const isUnlogged = (c: OnboardingCall): boolean => c.ended && !c.log && c.outcomeInGhl !== 'cancelled';

export function onboardingNumbers(calls: ReadonlyArray<OnboardingCall>): OnboardingNumbers {
  const count = (f: (c: OnboardingCall) => boolean) => calls.filter(f).length;
  const logged = count(isLogged);
  const showed = count(isShowed);
  const consultNoShows = count((c) => isNoShow(c) && c.callType === 'Consult');
  const roadmapNoShows = count((c) => isNoShow(c) && c.callType === 'Roadmap');
  const needsOutcomeN = count(needsOutcome);
  const failedLogs = count(isFailedLog);
  return {
    calls: calls.length,
    consults: count((c) => c.callType === 'Consult'),
    roadmaps: count((c) => c.callType === 'Roadmap'),
    other: count((c) => c.callType === 'Other'),
    logged,
    unlogged: count(isUnlogged),
    showed,
    showedPct: logged > 0 ? showed / logged : null,
    roadmapsBooked: count(isRoadmapBooked),
    enrolled: count(isEnrolled),
    notFit: count(isNotFit),
    noShows: count(isNoShow),
    consultNoShows,
    roadmapNoShows,
    needsOutcome: needsOutcomeN,
    failedLogs,
    needsAttention: needsOutcomeN + failedLogs,
  };
}

const STEP_WORD: Record<StepName, string> = { stage: 'the stage move', appointment: 'the appointment status', note: 'the note' };

/** Needs attention, in call order: unlogged ended calls first, then failed logs. */
export function attentionItems(calls: ReadonlyArray<OnboardingCall>): AttentionItem[] {
  const type = (c: OnboardingCall) => (c.callType === 'Other' ? c.calendarName : c.callType.toLowerCase());
  const out: AttentionItem[] = [];
  for (const c of calls) {
    if (needsOutcome(c)) out.push({ eventId: c.eventId, kind: 'needs_outcome', text: `${c.timeLabel} ${type(c)} with ${c.name} has no outcome logged.`, logId: null });
  }
  for (const c of calls) {
    if (!c.log || !isFailedLog(c)) continue;
    const step = c.log.failedStep;
    const what = step ? `${STEP_WORD[step]} didn't reach GoHighLevel` : 'the log did not reach GoHighLevel';
    const applied = (['stage', 'appointment', 'note'] as StepName[]).filter((s) => c.log!.steps[s] === 'ok');
    const prefix = applied.length ? `${applied.map((s) => (s === 'stage' ? 'Stage' : s === 'appointment' ? 'Appointment' : 'Note')).join(' and ')} updated; ` : '';
    out.push({ eventId: c.eventId, kind: 'failed_log', text: `${c.timeLabel} ${type(c)} with ${c.name}: ${prefix}${what}${c.log.error ? ` (${c.log.error})` : ''}.`, logId: c.log.id });
  }
  return out;
}

export type GhlResultTone = 'ok' | 'warn' | 'bad' | 'neutral';
export interface GhlResult {
  label: string;
  sub: string | null;
  tone: GhlResultTone;
  canRetry: boolean;
}

const mark = (s: StepState) => (s === 'ok' ? '✓' : s === 'failed' ? '✗' : s === 'skipped' ? '–' : '…');

/** The GoHighLevel column: ✓ Updated / ! Partly failed (per step) / Failed / Not logged / Dry run — not sent / Undone / the GHL-recorded outcome. */
export function ghlResultOf(c: OnboardingCall): GhlResult {
  const l = c.log;
  if (l) {
    const steps = `Stage ${mark(l.steps.stage)} · Appointment ${mark(l.steps.appointment)} · Note ${mark(l.steps.note)}`;
    if (l.state === 'ok') return { label: '✓ Updated', sub: 'Stage · appointment · note', tone: 'ok', canRetry: false };
    if (l.state === 'dry_run') return { label: 'Dry run — not sent', sub: 'Recorded in FitFlow only', tone: 'warn', canRetry: false };
    if (l.state === 'partial') return { label: '! Partly failed', sub: steps, tone: 'warn', canRetry: true };
    if (l.state === 'failed') return { label: '✗ Failed', sub: l.error ?? steps, tone: 'bad', canRetry: true };
    return { label: 'Logging…', sub: steps, tone: 'neutral', canRetry: false };
  }
  if (c.undone) return { label: 'Undone', sub: `${c.undone.label}${c.undone.undoneBy ? ` · by ${c.undone.undoneBy}` : ''}`, tone: 'neutral', canRetry: false };
  if (c.outcomeInGhl === 'showed') return { label: 'Showed in GHL', sub: 'No Companion log', tone: 'neutral', canRetry: false };
  if (c.outcomeInGhl === 'no_show') return { label: 'No-show in GHL', sub: 'No Companion log', tone: 'neutral', canRetry: false };
  if (c.outcomeInGhl === 'cancelled') return { label: 'Cancelled in GHL', sub: null, tone: 'neutral', canRetry: false };
  if (c.status === 'needs_outcome') return { label: 'Not logged', sub: `Call ended${c.endIso ? '' : ' (30 min default)'}`, tone: 'bad', canRetry: false };
  return { label: c.status === 'in_progress' ? 'In progress' : 'Up next', sub: null, tone: 'neutral', canRetry: false };
}

/** The outcome chip: the log's label, or what GHL / the clock says. */
export function outcomeLabelOf(c: OnboardingCall): { label: string; tone: 'good' | 'blue' | 'gray' | 'amber' | 'purple' | 'red' } {
  if (c.log) {
    if (isEnrolled(c)) return { label: c.log.label, tone: 'purple' };
    if (isNotFit(c)) return { label: c.log.label, tone: 'red' };
    if (isNoShow(c)) return { label: c.log.label, tone: 'amber' };
    if (isRoadmapBooked(c)) return { label: c.log.label, tone: 'good' };
    if (c.log.outcomeKey.includes('reschedule')) return { label: c.log.label, tone: 'blue' };
    return { label: c.log.label, tone: 'gray' };
  }
  if (c.undone) return { label: 'Undone', tone: 'gray' };
  if (c.outcomeInGhl === 'showed') return { label: 'Showed (GHL)', tone: 'gray' };
  if (c.outcomeInGhl === 'no_show') return { label: 'No-show (GHL)', tone: 'amber' };
  if (c.outcomeInGhl === 'cancelled') return { label: 'Cancelled (GHL)', tone: 'gray' };
  if (c.status === 'needs_outcome') return { label: 'Needs outcome', tone: 'red' };
  return { label: c.status === 'in_progress' ? 'In progress' : 'Up next', tone: 'blue' };
}

/** "Consult Booked → Pre-Roadmap Booked" / "Consult Booked · deal marked Lost" / "Consult Booked (unchanged)". */
export function stageMoveOf(c: OnboardingCall): string {
  const l = c.log;
  if (!l) return c.undone ? 'Restored by undo' : '—';
  const from = l.before.stageName ?? 'no stage';
  const to = l.after.stageName ?? from;
  const status = (l.after.status ?? '').toLowerCase();
  const deal = status === 'won' ? ' · deal Won' : status === 'lost' ? ' · deal marked Lost' : '';
  if (to === from || l.after.stageName === null) return `${from} (unchanged)${deal}`;
  return `${from} → ${to}${deal}`;
}

export type OnboardingFilter = 'all' | 'attention' | 'no_shows' | 'enrolled' | 'not_fit';
export const FILTERS: ReadonlyArray<{ key: OnboardingFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'no_shows', label: 'No-shows' },
  { key: 'enrolled', label: 'Enrolled' },
  { key: 'not_fit', label: 'Not a fit' },
];

export function matchesFilter(c: OnboardingCall, f: OnboardingFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'attention':
      return needsAttention(c);
    case 'no_shows':
      return isNoShow(c);
    case 'enrolled':
      return isEnrolled(c);
    case 'not_fit':
      return isNotFit(c);
  }
}

export function filterCounts(calls: ReadonlyArray<OnboardingCall>): Record<OnboardingFilter, number> {
  const out = { all: 0, attention: 0, no_shows: 0, enrolled: 0, not_fit: 0 };
  for (const c of calls) for (const f of FILTERS) if (matchesFilter(c, f.key)) out[f.key] += 1;
  return out;
}

/** The headline the emails open with: "8 calls today: 1 enrolled, 1 roadmap booked, 2 no-shows." */
export function onboardingHeadline(n: OnboardingNumbers, when: string): string {
  if (n.calls === 0) return `No onboarding calls ${when}.`;
  const parts: string[] = [];
  if (n.enrolled) parts.push(`${n.enrolled} enrolled`);
  if (n.roadmapsBooked) parts.push(`${n.roadmapsBooked} roadmap${n.roadmapsBooked === 1 ? '' : 's'} booked`);
  if (n.noShows) parts.push(`${n.noShows} no-show${n.noShows === 1 ? '' : 's'}`);
  if (n.needsAttention) parts.push(`${n.needsAttention} need${n.needsAttention === 1 ? 's' : ''} attention`);
  const tail = parts.length ? `: ${parts.join(', ')}` : `, ${n.logged} of ${n.calls} logged`;
  return `${n.calls} call${n.calls === 1 ? '' : 's'} ${when}${tail}.`;
}
