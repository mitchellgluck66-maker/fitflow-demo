/**
 * Companion stage 2, item 4 — the logging flow: plan → confirm → (GHL re-read, stale-stage prompt) → steps in order
 * stage → appointment → note, each result written to the row as it completes → mirror update → retry of the missing
 * steps only → undo for 5 minutes. Every write goes through `ghlWrite`; every read of GHL through the read-only
 * client; the request id makes a resent request harmless. Injectable readers for tests; the real ones by default.
 */

import { getOpportunity } from '../ghl/client';
import { GhlAppointmentStatusSchema } from '../ghl/schemas';
import { formatTime } from '../day';
import type { CurrentUser } from '../auth/currentUser';
import type { CompanionAction, CompanionPosition, CompanionStepName, CompanionStepRecord, CompanionSteps } from '@/db';
import { callTypeOf, type CallType } from './calendars';
import { readDryRun } from './config';
import { addContactNote, hasWriteKey, methodOf, updateAppointmentStatus, updateOpportunity, type WriteResult } from './ghlWrite';
import { readOutcomeCatalogue, type OutcomeCatalogue } from './outcomeService';
import { MOVE_TO_KEY, resolveMoveTo, resolveOutcome, type AppointmentEffect, type ResolvedOutcome } from './outcomes';
import { applyMirror, readContactPosition, readMirrorAppointment, syncActionIncident, type ContactPosition } from './logDb';
import { STEP_ORDER, UNDO_WINDOW_MS, effectiveState, failedStepOf, getAction, insertOrFindAction, pendingStep, recordStep, setActionState, skippedStep, undoUntil } from './actions';

import { NOTE_MIN_CHARS } from './logText';
export { NOTE_MIN_CHARS };

export type OutcomeChoice = { key: string } | { move: { stageId: string; appointment: AppointmentEffect } };

/** The call context the client already holds (from the day API); the mirror fills in what is missing. */
export interface CallContext {
  eventId: string;
  ghlStatus: string | null;
  startIso: string | null;
  callType: CallType | null;
  calendarName: string | null;
}

export interface LogInput {
  ghlContactId: string;
  call: CallContext | null;
  outcome: OutcomeChoice;
  note: string;
  user: CurrentUser;
  timezone: string;
  now?: Date;
}

export interface LogDeps {
  position?: (ghlContactId: string) => Promise<ContactPosition>;
  mirrorAppointment?: typeof readMirrorAppointment;
  catalogue?: () => Promise<OutcomeCatalogue>;
  dryRun?: () => Promise<{ on: boolean }>;
  writeKey?: () => Promise<boolean>;
  liveOpportunity?: typeof getOpportunity;
}

export interface StepPlan {
  name: CompanionStepName;
  /** The exact request a live step sends (null when skipped). */
  request: CompanionStepRecord['request'];
  skipReason: string | null;
  summary: string;
}

export interface LogPlan {
  clientName: string;
  callType: CallType | 'none';
  outcome: ResolvedOutcome;
  opportunity: { id: string; pipelineName: string; from: { id: string | null; name: string | null }; to: { id: string | null; name: string | null }; status: { from: string; to: string } } | null;
  appointment: { eventId: string; from: string | null; to: AppointmentEffect; startIso: string | null; callType: CallType } | null;
  noteText: string;
  confirmation: string;
  /** The stage the sheet shows — what the server re-checks against GHL on confirm. */
  expectedStageId: string | null;
  dryRun: boolean;
  steps: StepPlan[];
  before: CompanionPosition;
  after: CompanionPosition;
  contactId: string | null;
  pipelineId: string | null;
  callStartAt: string | null;
}

export type PlanResult = { ok: true; plan: LogPlan } | { ok: false; status: 412 | 422; error: string };

// ---- pure text ------------------------------------------------------------------------------------------------

export function noteProblem(note: unknown): string | null {
  if (typeof note !== 'string') return 'A note is required.';
  const n = note.trim().length;
  if (n < NOTE_MIN_CHARS) return `The note needs at least ${NOTE_MIN_CHARS} characters (${n} / ${NOTE_MIN_CHARS}).`;
  if (note.length > 4000) return 'The note is too long (4,000 characters at most).';
  return null;
}

export const APPOINTMENT_WORDS: Record<AppointmentEffect, string> = { showed: 'showed', noshow: 'no-show', cancelled: 'cancelled', leave: 'left as is' };

/** "Onboarding call · Consult · Oct 16, 10:00 AM · Miranda\nOutcome: Showed, roadmap booked (Consult Booked → Pre-Roadmap Booked)\nNote: …" */
export function noteText(p: { callType: CallType | 'none'; startIso: string | null; timezone: string; userName: string; label: string; from: string | null; to: string | null; note: string }): string {
  const when = p.startIso ? `${new Date(p.startIso).toLocaleDateString('en-US', { timeZone: p.timezone, month: 'short', day: 'numeric' })}, ${formatTime(p.startIso, p.timezone)}` : 'no appointment';
  const move = p.to && p.to !== p.from ? ` (${p.from ?? 'no stage'} → ${p.to})` : p.from ? ` (${p.from}, unchanged)` : '';
  return [`Onboarding call · ${p.callType === 'none' ? 'no call' : p.callType} · ${when} · ${p.userName}`, `Outcome: ${p.label}${move}`, `Note: ${p.note.trim()}`].join('\n');
}

export function confirmationText(p: { clientName: string; from: string | null; to: string | null; statusFrom: string | null; statusTo: string | null; hasOpportunity: boolean; appointment: { startIso: string | null; callType: CallType; to: AppointmentEffect } | null; timezone: string; dryRun: boolean }): string {
  const parts: string[] = [];
  if (p.hasOpportunity && p.to && p.to !== p.from) parts.push(`Move ${p.clientName} from ${p.from ?? 'no stage'} to ${p.to}`);
  else if (p.hasOpportunity && p.statusTo && p.statusTo !== p.statusFrom) parts.push(`Mark ${p.clientName}'s opportunity ${p.statusTo}`);
  else parts.push(`Keep ${p.clientName} in ${p.from ?? 'their stage'}`);
  if (p.hasOpportunity && p.to && p.to !== p.from && p.statusTo && p.statusTo !== p.statusFrom) parts[0] += ` and mark the opportunity ${p.statusTo}`;
  if (p.appointment && p.appointment.to !== 'leave') parts.push(`mark the ${p.appointment.startIso ? formatTime(p.appointment.startIso, p.timezone) : ''} ${p.appointment.callType} ${APPOINTMENT_WORDS[p.appointment.to]}`.replace(/\s+/g, ' '));
  parts.push('add this note');
  const head = parts.length > 2 ? `${parts.slice(0, -1).join(', ')}, ${parts[parts.length - 1]}.` : parts.join(', ') + '.';
  return `${head} This may send GoHighLevel messages to the client.${p.dryRun ? ' Dry run — nothing will be sent.' : ''}`;
}

// ---- plan -----------------------------------------------------------------------------------------------------

export async function planLog(input: LogInput, deps: LogDeps = {}): Promise<PlanResult> {
  const problem = noteProblem(input.note);
  if (problem) return { ok: false, status: 422, error: problem };
  const [position, cat, dry] = await Promise.all([(deps.position ?? readContactPosition)(input.ghlContactId), (deps.catalogue ?? readOutcomeCatalogue)(), (deps.dryRun ?? readDryRun)()]);
  if (!dry.on && !(await (deps.writeKey ?? hasWriteKey)())) return { ok: false, status: 412, error: 'No Companion write key — the owner adds it in Setup → Companion.' };

  // The call: the client's context, completed from the mirror.
  let call: CallContext | null = input.call;
  if (call && (!call.startIso || !call.callType || call.ghlStatus === null)) {
    const m = await (deps.mirrorAppointment ?? readMirrorAppointment)(call.eventId);
    if (m) call = { eventId: call.eventId, ghlStatus: call.ghlStatus ?? m.ghlStatus, startIso: call.startIso ?? m.startIso, callType: call.callType ?? callTypeOf(m.calendarName, m.title), calendarName: call.calendarName ?? m.calendarName };
  }
  const callType: CallType | 'none' = call ? (call.callType ?? 'Other') : 'none';

  // The outcome, resolved against the live stage map.
  let resolved: ResolvedOutcome;
  if ('move' in input.outcome) {
    const r = resolveMoveTo(input.outcome.move, cat.ctx);
    if (!r.ok) return { ok: false, status: 422, error: r.reason };
    resolved = r.outcome;
  } else {
    const key = input.outcome.key;
    const def = cat.defs.find((d) => d.key === key);
    if (!def) return { ok: false, status: 422, error: `"${key}" is not an outcome.` };
    if (callType !== def.callType) return { ok: false, status: 422, error: callType === 'none' ? `"${def.label}" needs a ${def.callType} call — use Move to… for a person without a call.` : `"${def.label}" is a ${def.callType} outcome; this is a ${callType} call.` };
    const r = resolveOutcome(def, cat.ctx);
    if (!r.ok) return { ok: false, status: 422, error: r.reason };
    resolved = r.outcome;
  }

  const opp = position.opportunity;
  const toStageId = resolved.toStage?.id ?? opp?.stageId ?? null;
  const toStageName = resolved.toStage?.name ?? opp?.stageName ?? null;
  const statusTo = resolved.opportunityStatus ?? opp?.status ?? null;
  const before: CompanionPosition = { stageId: opp?.stageId ?? null, stageName: opp?.stageName ?? null, status: opp?.status ?? null, appointmentStatus: call?.ghlStatus ?? null };
  const after: CompanionPosition = { stageId: toStageId, stageName: toStageName, status: statusTo, appointmentStatus: call && resolved.appointment !== 'leave' ? resolved.appointment : (call?.ghlStatus ?? null) };

  const steps: StepPlan[] = [];
  // 1. stage (+ status) — one PUT /opportunities/{id}
  if (!opp) {
    steps.push({ name: 'stage', request: null, skipReason: position.pipeline ? `no opportunity in ${position.pipeline.name}` : 'no followed pipeline', summary: 'Stage — skipped' });
  } else {
    const stageChange = resolved.toStage && resolved.toStage.id !== opp.stageId;
    const statusChange = resolved.opportunityStatus && resolved.opportunityStatus !== opp.status;
    if (!stageChange && !statusChange) steps.push({ name: 'stage', request: null, skipReason: resolved.toStage ? `already in ${opp.stageName ?? resolved.toStage.name}` : 'stage unchanged', summary: `Stage — ${opp.stageName ?? 'unchanged'}` });
    else
      steps.push({
        name: 'stage',
        request: { method: methodOf('update_opportunity'), path: `/opportunities/${opp.id}`, body: { pipelineId: position.pipeline!.id, ...(stageChange ? { pipelineStageId: resolved.toStage!.id } : {}), ...(statusChange ? { status: resolved.opportunityStatus } : {}) } },
        skipReason: null,
        summary: stageChange ? `Stage ${opp.stageName ?? 'no stage'} → ${resolved.toStage!.name}${statusChange ? ` · ${resolved.opportunityStatus}` : ''}` : `Opportunity ${opp.status} → ${resolved.opportunityStatus}`,
      });
  }
  // 2. appointment — PUT /calendars/events/appointments/{eventId}
  if (!call) steps.push({ name: 'appointment', request: null, skipReason: 'no appointment', summary: 'Appointment — none' });
  else if (resolved.appointment === 'leave') steps.push({ name: 'appointment', request: null, skipReason: 'left as is', summary: `Appointment — left ${call.ghlStatus ?? 'as is'}` });
  else steps.push({ name: 'appointment', request: { method: methodOf('update_appointment_status'), path: `/calendars/events/appointments/${call.eventId}`, body: { appointmentStatus: resolved.appointment } }, skipReason: null, summary: `Appointment ${call.ghlStatus ?? '?'} → ${resolved.appointment}` });
  // 3. note — POST /contacts/{id}/notes
  const text = noteText({ callType, startIso: call?.startIso ?? null, timezone: input.timezone, userName: input.user.name, label: resolved.label, from: before.stageName, to: after.stageName, note: input.note });
  steps.push({ name: 'note', request: { method: methodOf('add_contact_note'), path: `/contacts/${input.ghlContactId}/notes`, body: { body: text, ...(input.user.ghlUserId ? { userId: input.user.ghlUserId } : {}) } }, skipReason: null, summary: 'Note added to the contact' });

  const appointment = call ? { eventId: call.eventId, from: call.ghlStatus, to: resolved.appointment, startIso: call.startIso, callType: call.callType ?? 'Other' } : null;
  return {
    ok: true,
    plan: {
      clientName: position.name,
      callType,
      outcome: resolved,
      opportunity: opp && position.pipeline ? { id: opp.id, pipelineName: position.pipeline.name, from: { id: opp.stageId, name: opp.stageName }, to: { id: toStageId, name: toStageName }, status: { from: opp.status, to: statusTo ?? opp.status } } : null,
      appointment,
      noteText: text,
      confirmation: confirmationText({ clientName: position.name, from: before.stageName, to: after.stageName, statusFrom: before.status, statusTo: after.status, hasOpportunity: Boolean(opp), appointment: appointment ? { startIso: appointment.startIso, callType: appointment.callType, to: appointment.to } : null, timezone: input.timezone, dryRun: dry.on }),
      expectedStageId: opp?.stageId ?? null,
      dryRun: dry.on,
      steps,
      before,
      after,
      contactId: position.contactId,
      pipelineId: position.pipeline?.id ?? null,
      callStartAt: call?.startIso ?? null,
    },
  };
}

// ---- execute --------------------------------------------------------------------------------------------------

export interface ExecuteInput extends LogInput {
  requestId: string;
  expectedStageId: string | null;
  acceptedStageId?: string | null;
}

export type ExecuteResult =
  | { ok: true; action: CompanionAction; created: boolean }
  | { ok: false; status: 409; error: string; staleStage: { stageId: string | null; stageName: string | null } }
  | { ok: false; status: 412 | 422 | 502; error: string };

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

function toRecord(r: WriteResult): CompanionStepRecord {
  return { status: r.status, request: r.request, httpStatus: r.httpStatus, body: r.body, error: r.error ?? null, reason: null, at: r.at };
}

async function sendStep(name: CompanionStepName, request: NonNullable<CompanionStepRecord['request']>, dryRun: boolean): Promise<WriteResult> {
  const opts = { dryRun };
  if (name === 'stage') {
    const b = request.body as { pipelineId: string; pipelineStageId?: string; status?: 'open' | 'won' | 'lost' };
    return updateOpportunity(request.path.slice('/opportunities/'.length), b, opts);
  }
  if (name === 'appointment') return updateAppointmentStatus(request.path.slice('/calendars/events/appointments/'.length), (request.body as { appointmentStatus: 'showed' }).appointmentStatus, opts);
  const nb = request.body as { body: string; userId?: string };
  return addContactNote(request.path.slice('/contacts/'.length, -'/notes'.length), nb.body, nb.userId ?? null, opts);
}

/** Run every step not yet ok / skipped, in order; stop at the first failure. Returns the row after the last write. */
async function runSteps(row: CompanionAction, now: Date): Promise<CompanionAction> {
  let current = row;
  for (const name of STEP_ORDER) {
    const step = current.steps[name];
    if (!step || step.status === 'ok' || step.status === 'skipped' || step.status === 'dry_run') continue;
    if (!step.request) {
      current = await recordStep(current.id, name, skippedStep(step.reason ?? 'nothing to send', now), { dryRun: current.dryRun });
      continue;
    }
    const result = await sendStep(name, step.request, current.dryRun);
    current = await recordStep(current.id, name, toRecord(result), { dryRun: current.dryRun });
    if (result.status === 'failed') break;
  }
  return current;
}

async function afterRun(row: CompanionAction, now: Date): Promise<CompanionAction> {
  const e = effectiveState(row, now);
  if (e.state === 'ok') {
    await applyMirror(row, 'apply', { stage: row.steps.stage?.status === 'ok', appointment: row.steps.appointment?.status === 'ok' }, now);
    await syncActionIncident(row, now, null, `completed at ${now.toISOString()}`);
    return setActionState(row.id, { error: null });
  }
  if (e.state === 'partial') {
    // What did land is mirrored now; the failed step is retried from the pop-out.
    await applyMirror(row, 'apply', { stage: row.steps.stage?.status === 'ok', appointment: row.steps.appointment?.status === 'ok' }, now);
  }
  if (e.state === 'partial' || e.state === 'failed') {
    const step = failedStepOf(row.steps);
    await syncActionIncident(row, now, { step: step ?? 'unknown', error: row.error ?? 'failed' });
  }
  return row;
}

/** Confirm: re-read GHL, claim the request id, run the steps, mirror, incident. */
export async function executeLog(input: ExecuteInput, deps: LogDeps = {}): Promise<ExecuteResult> {
  const now = input.now ?? new Date();
  if (!REQUEST_ID_RE.test(input.requestId)) return { ok: false, status: 422, error: 'requestId must be 8–80 url-safe characters.' };
  const planned = await planLog(input, deps);
  if (!planned.ok) return planned;
  const plan = planned.plan;

  // The stale-stage check: GHL is the truth at the moment of confirming.
  if (plan.opportunity) {
    const live = await (deps.liveOpportunity ?? getOpportunity)(plan.opportunity.id);
    if (!live.opportunity) return { ok: false, status: 502, error: live.notFound ? `GoHighLevel no longer has opportunity ${plan.opportunity.id} — nothing was changed.` : `GoHighLevel could not be re-read before writing: ${live.error ?? 'unknown error'} — nothing was changed.` };
    const liveStage = live.opportunity.pipelineStageId;
    if (liveStage !== input.expectedStageId && liveStage !== (input.acceptedStageId ?? null)) {
      const cat = await (deps.catalogue ?? readOutcomeCatalogue)();
      const name = cat.ctx.stages.find((s) => s.id === liveStage)?.name ?? null;
      return { ok: false, status: 409, error: `Stage changed to ${name ?? `an unknown stage (${liveStage})`} since you opened this — continue?`, staleStage: { stageId: liveStage, stageName: name } };
    }
    // The live read is the `before` (the mirror may lag): a stage the user accepted replaces the planned "from".
    if (liveStage !== plan.before.stageId) {
      const cat = await (deps.catalogue ?? readOutcomeCatalogue)();
      plan.before = { ...plan.before, stageId: liveStage, stageName: cat.ctx.stages.find((s) => s.id === liveStage)?.name ?? null };
      if (!plan.outcome.toStage) plan.after = { ...plan.after, stageId: liveStage, stageName: plan.before.stageName };
    }
    if (live.opportunity.status !== plan.before.status) {
      plan.before = { ...plan.before, status: live.opportunity.status };
      if (!plan.outcome.opportunityStatus) plan.after = { ...plan.after, status: live.opportunity.status };
    }
  }

  const steps: CompanionSteps = {};
  for (const s of plan.steps) steps[s.name] = s.skipReason ? skippedStep(s.skipReason, now) : { ...pendingStep(), request: s.request };
  const { row, created } = await insertOrFindAction({
    requestId: input.requestId,
    userId: input.user.uid,
    userName: input.user.name,
    ghlUserId: input.user.ghlUserId,
    ghlEventId: plan.appointment?.eventId ?? null,
    ghlContactId: input.ghlContactId,
    contactId: plan.contactId,
    clientName: plan.clientName,
    ghlOpportunityId: plan.opportunity?.id ?? null,
    pipelineId: plan.pipelineId,
    callType: plan.callType,
    callStartAt: plan.callStartAt ? new Date(plan.callStartAt) : null,
    outcomeKey: plan.outcome.key,
    label: plan.outcome.label,
    note: input.note.trim(),
    before: plan.before,
    after: plan.after,
    dryRun: plan.dryRun,
    steps,
    state: 'running',
    createdAt: now,
    updatedAt: now,
  });
  // A resent request (double-click, a retried POST) finds the row and returns it as it stands — never a second run.
  if (!created) return { ok: true, action: row, created: false };
  const ran = await runSteps(row, now);
  return { ok: true, action: await afterRun(ran, now), created: true };
}

// ---- retry ----------------------------------------------------------------------------------------------------

export type RetryResult = { ok: true; action: CompanionAction } | { ok: false; status: 404 | 409; error: string };

/** Re-run ONLY the steps that are not ok / skipped, in order, on the same row. */
export async function retryLog(id: string, user: CurrentUser, now: Date = new Date()): Promise<RetryResult> {
  const row = await getAction(id);
  if (!row) return { ok: false, status: 404, error: 'No such log.' };
  if (user.role !== 'owner' && row.userId !== user.uid) return { ok: false, status: 404, error: 'No such log.' };
  const e = effectiveState(row, now);
  if (e.state !== 'partial' && e.state !== 'failed') return { ok: false, status: 409, error: `Nothing to retry — this log is ${e.state.replace('_', ' ')}.` };
  await setActionState(row.id, { state: 'running', error: null });
  const ran = await runSteps({ ...row, state: 'running' }, now);
  return { ok: true, action: await afterRun(ran, now) };
}

// ---- undo -----------------------------------------------------------------------------------------------------

export type UndoResult = { ok: true; action: CompanionAction } | { ok: false; status: 404 | 409 | 410; error: string };

/** Reverse the applied steps in reverse order inside the 5-minute window; add "Undone by <user>". */
export async function undoLog(id: string, user: CurrentUser, now: Date = new Date()): Promise<UndoResult> {
  const row = await getAction(id);
  if (!row) return { ok: false, status: 404, error: 'No such log.' };
  if (user.role !== 'owner' && row.userId !== user.uid) return { ok: false, status: 404, error: 'No such log.' };
  if (row.state === 'undone') return { ok: false, status: 409, error: 'Already undone.' };
  const e = effectiveState(row, now);
  if (e.state === 'running') return { ok: false, status: 409, error: 'Still logging — wait for it to finish.' };
  const until = undoUntil(row.createdAt);
  if (now.getTime() > until.getTime()) return { ok: false, status: 410, error: `Undo closed at ${until.toISOString()} (${UNDO_WINDOW_MS / 60_000} minutes after the log).` };

  const undo: CompanionSteps = row.undoSteps ?? {};
  const dryRun = row.dryRun;
  const record = async (name: CompanionStepName, r: CompanionStepRecord) => {
    undo[name] = r;
    await setActionState(row.id, { undoSteps: { ...undo } });
  };
  // note: nothing to delete (not in the allow-list) — the "Undone by" note is the reversal.
  // appointment
  if (row.steps.appointment?.status === 'ok' && undo.appointment?.status !== 'ok') {
    const prev = row.before.appointmentStatus;
    const parsed = GhlAppointmentStatusSchema.safeParse(prev);
    if (!row.ghlEventId || !parsed.success) await record('appointment', skippedStep(prev ? `previous status "${prev}" is not a GoHighLevel status` : 'previous status unknown', now));
    else {
      const r = await updateAppointmentStatus(row.ghlEventId, parsed.data, { dryRun });
      await record('appointment', toRecord(r));
      if (r.status === 'failed') return finishUndo(row, undo, now, user, false);
    }
  }
  // stage + status
  if (row.steps.stage?.status === 'ok' && undo.stage?.status !== 'ok') {
    const b = row.before;
    if (!row.ghlOpportunityId || !row.pipelineId) await record('stage', skippedStep('no opportunity', now));
    else {
      const status = b.status === 'open' || b.status === 'won' || b.status === 'lost' || b.status === 'abandoned' ? b.status : undefined;
      const patch: { pipelineId: string; pipelineStageId?: string; status?: 'open' | 'won' | 'lost' | 'abandoned' } = { pipelineId: row.pipelineId, ...(b.stageId ? { pipelineStageId: b.stageId } : {}), ...(status ? { status } : {}) };
      const r = await updateOpportunity(row.ghlOpportunityId, patch, { dryRun });
      await record('stage', toRecord(r));
      if (r.status === 'failed') return finishUndo(row, undo, now, user, false);
    }
  }
  // the "Undone by" note
  if (undo.note?.status !== 'ok') {
    const r = await addContactNote(row.ghlContactId, `Undone by ${user.name} — ${row.label} logged ${row.createdAt.toISOString()} was reversed.`, user.ghlUserId, { dryRun });
    await record('note', toRecord(r));
    if (r.status === 'failed') return finishUndo(row, undo, now, user, false);
  }
  return finishUndo(row, undo, now, user, true);
}

async function finishUndo(row: CompanionAction, undo: CompanionSteps, now: Date, user: CurrentUser, complete: boolean): Promise<UndoResult> {
  if (!complete) {
    const failed = (['appointment', 'stage', 'note'] as const).find((n) => undo[n]?.status === 'failed');
    const action = await setActionState(row.id, { undoSteps: undo, error: `Undo failed at the ${failed ?? 'unknown'} step: ${failed ? undo[failed]?.error : ''}` });
    return { ok: true, action };
  }
  if (!row.dryRun) await applyMirror(row, 'revert', { stage: undo.stage?.status === 'ok', appointment: undo.appointment?.status === 'ok' }, now);
  await syncActionIncident(row, now, null, `undone by ${user.name} at ${now.toISOString()}`);
  const action = await setActionState(row.id, { state: 'undone', undoSteps: undo, undoneAt: now, undoneBy: user.name, error: null });
  return { ok: true, action };
}

// ---- what the client sees -------------------------------------------------------------------------------------

export interface ActionView {
  id: string;
  state: CompanionAction['state'];
  stale: boolean;
  label: string;
  outcomeKey: string;
  clientName: string;
  userName: string;
  dryRun: boolean;
  createdAt: string;
  undoUntil: string;
  canUndo: boolean;
  canRetry: boolean;
  error: string | null;
  failedStep: CompanionStepName | null;
  before: CompanionPosition;
  after: CompanionPosition;
  steps: Array<{ name: CompanionStepName; status: CompanionStepRecord['status']; summary: string; detail: string | null; httpStatus: number | null; request: CompanionStepRecord['request'] }>;
  undoSteps: CompanionSteps | null;
  undoneAt: string | null;
  undoneBy: string | null;
}

export function stepSummary(name: CompanionStepName, row: Pick<CompanionAction, 'before' | 'after'>, record: CompanionStepRecord | undefined): string {
  if (name === 'stage') {
    const stageMove = row.after.stageId !== row.before.stageId;
    const statusMove = row.after.status !== row.before.status;
    if (record?.status === 'skipped') return `Stage — ${record.reason ?? 'unchanged'}`;
    const parts = [stageMove ? `${row.before.stageName ?? 'no stage'} → ${row.after.stageName ?? '?'}` : null, statusMove ? `${row.before.status ?? '?'} → ${row.after.status}` : null].filter(Boolean);
    return `Stage ${parts.join(' · ') || 'unchanged'}`;
  }
  if (name === 'appointment') {
    if (record?.status === 'skipped') return `Appointment — ${record.reason ?? 'skipped'}`;
    return `Appointment ${row.before.appointmentStatus ?? '?'} → ${row.after.appointmentStatus ?? '?'}`;
  }
  return 'Note on the contact';
}

export function actionView(row: CompanionAction, now: Date, viewer?: Pick<CurrentUser, 'uid' | 'role'>): ActionView {
  const e = effectiveState(row, now);
  const until = undoUntil(row.createdAt);
  const mine = !viewer || viewer.role === 'owner' || row.userId === viewer.uid;
  const windowOpen = now.getTime() <= until.getTime();
  return {
    id: row.id,
    state: e.state,
    stale: e.stale,
    label: row.label,
    outcomeKey: row.outcomeKey,
    clientName: row.clientName,
    userName: row.userName,
    dryRun: row.dryRun,
    createdAt: row.createdAt.toISOString(),
    undoUntil: until.toISOString(),
    canUndo: mine && windowOpen && (e.state === 'ok' || e.state === 'partial' || e.state === 'dry_run' || e.state === 'failed'),
    canRetry: mine && (e.state === 'partial' || e.state === 'failed'),
    error: e.stale ? 'the function stopped mid-way and nothing resumed it — retry' : row.error,
    failedStep: e.state === 'partial' || e.state === 'failed' ? failedStepOf(row.steps) : null,
    before: row.before,
    after: row.after,
    steps: STEP_ORDER.map((name) => {
      const r = row.steps[name];
      return { name, status: r?.status ?? 'pending', summary: stepSummary(name, row, r), detail: r?.status === 'failed' ? r.error : r?.status === 'skipped' ? r.reason : null, httpStatus: r?.httpStatus ?? null, request: r?.request ?? null };
    }),
    undoSteps: row.undoSteps ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    undoneBy: row.undoneBy,
  };
}

export { MOVE_TO_KEY };
