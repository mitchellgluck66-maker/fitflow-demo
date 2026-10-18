/**
 * Companion stage 2, item 3 — the outcome map (pure).
 *
 * An outcome names a stage ROLE, never a stage name: the stage is resolved from the followed pipeline's stage map
 * (Setup → Pipelines) at log time, so a renamed stage keeps working and an unmapped role is refused with the reason.
 * The owner edits the map on Setup → Companion; overrides are stored as JSON and validated here. "Move to…" is the
 * escape hatch: any stage of the followed pipeline by id + an appointment status; the opportunity status is kept.
 */

import { SEMANTIC_ROLES, type SemanticRole } from '@/db/schema';
import type { CallType } from './calendars';
import type { RescheduleAppointment } from './config';

export type AppointmentAction = 'showed' | 'noshow' | 'cancelled' | 'leave' | 'reschedule_setting';
/** What actually happens to the event once the reschedule setting is applied. */
export type AppointmentEffect = 'showed' | 'noshow' | 'cancelled' | 'leave';
export type OutcomeOpportunityStatus = 'open' | 'won' | 'lost';
export type OutcomeCallType = Exclude<CallType, 'Other'>;

export const APPOINTMENT_ACTION_LABELS: Record<AppointmentAction, string> = {
  showed: 'showed',
  noshow: 'no-show',
  cancelled: 'cancelled',
  leave: 'leave as is',
  reschedule_setting: 'per the Reschedule rule',
};
export const OPPORTUNITY_STATUS_LABELS: Record<OutcomeOpportunityStatus, string> = { open: 'open', won: 'won', lost: 'lost' };
export const APPOINTMENT_EFFECTS: readonly AppointmentEffect[] = ['showed', 'noshow', 'cancelled', 'leave'];

export interface OutcomeDef {
  key: string;
  label: string;
  callType: OutcomeCallType;
  /** null = the stage is not changed. */
  stageRole: SemanticRole | null;
  appointment: AppointmentAction;
  /** null = the opportunity status is not changed. */
  opportunityStatus: OutcomeOpportunityStatus | null;
}

/** The defaults from the brief (2026-10-18). Keys are stable: overrides and stored actions reference them. */
export const DEFAULT_OUTCOMES: readonly OutcomeDef[] = [
  { key: 'consult_showed_booked', label: 'Showed, roadmap booked', callType: 'Consult', stageRole: 'roadmap_booked', appointment: 'showed', opportunityStatus: 'open' },
  { key: 'consult_noshow', label: 'No-show', callType: 'Consult', stageRole: 'consult_noshow', appointment: 'noshow', opportunityStatus: 'open' },
  { key: 'consult_reschedule', label: 'Reschedule', callType: 'Consult', stageRole: 'consult_rescheduled', appointment: 'reschedule_setting', opportunityStatus: 'open' },
  { key: 'consult_cancelled', label: 'Cancelled', callType: 'Consult', stageRole: null, appointment: 'cancelled', opportunityStatus: 'open' },
  { key: 'consult_not_fit', label: 'Not a fit', callType: 'Consult', stageRole: null, appointment: 'showed', opportunityStatus: 'lost' },
  { key: 'roadmap_enrolled', label: 'Enrolled', callType: 'Roadmap', stageRole: 'enrolled', appointment: 'showed', opportunityStatus: 'won' },
  { key: 'roadmap_showed_objection', label: 'Showed, objection', callType: 'Roadmap', stageRole: 'roadmap_showed', appointment: 'showed', opportunityStatus: 'open' },
  { key: 'roadmap_noshow', label: 'No-show', callType: 'Roadmap', stageRole: 'roadmap_noshow', appointment: 'noshow', opportunityStatus: 'open' },
  { key: 'roadmap_reschedule', label: 'Reschedule', callType: 'Roadmap', stageRole: 'roadmap_rescheduled', appointment: 'reschedule_setting', opportunityStatus: 'open' },
  { key: 'roadmap_not_fit', label: 'Not a fit', callType: 'Roadmap', stageRole: null, appointment: 'showed', opportunityStatus: 'lost' },
];

export const MOVE_TO_KEY = 'move_to';

export interface OutcomeOverride {
  stageRole: SemanticRole | null;
  appointment: AppointmentAction;
  opportunityStatus: OutcomeOpportunityStatus | null;
}

const ROLE_SET = new Set<string>(SEMANTIC_ROLES);
const ACTION_SET = new Set<string>(Object.keys(APPOINTMENT_ACTION_LABELS));
const STATUS_SET = new Set<string>(Object.keys(OPPORTUNITY_STATUS_LABELS));
const KEY_SET = new Set(DEFAULT_OUTCOMES.map((o) => o.key));

/** One override, strictly. Returns the problem as a sentence, else null. */
export function overrideProblem(key: string, value: unknown): string | null {
  if (!KEY_SET.has(key)) return `"${key}" is not an outcome`;
  if (!value || typeof value !== 'object') return `"${key}": expected an object`;
  const v = value as Record<string, unknown>;
  if (!(v.stageRole === null || (typeof v.stageRole === 'string' && ROLE_SET.has(v.stageRole) && v.stageRole !== 'other'))) return `"${key}": stageRole must be a stage role or null`;
  if (typeof v.appointment !== 'string' || !ACTION_SET.has(v.appointment)) return `"${key}": appointment must be one of ${Array.from(ACTION_SET).join(', ')}`;
  if (!(v.opportunityStatus === null || (typeof v.opportunityStatus === 'string' && STATUS_SET.has(v.opportunityStatus)))) return `"${key}": opportunityStatus must be open, won, lost or null`;
  return null;
}

/** Validate a whole map from the owner (PATCH): all or nothing. */
export function validateOverrides(input: unknown): { ok: true; overrides: Record<string, OutcomeOverride> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'outcomeMap must be an object keyed by outcome.' };
  const out: Record<string, OutcomeOverride> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const problem = overrideProblem(key, value);
    if (problem) return { ok: false, error: problem };
    const v = value as OutcomeOverride;
    const def = DEFAULT_OUTCOMES.find((o) => o.key === key)!;
    // An override equal to the default is not stored.
    if (v.stageRole === def.stageRole && v.appointment === def.appointment && v.opportunityStatus === def.opportunityStatus) continue;
    out[key] = { stageRole: v.stageRole, appointment: v.appointment, opportunityStatus: v.opportunityStatus };
  }
  return { ok: true, overrides: out };
}

/** Parse the stored JSON leniently: a bad entry is dropped and named; the rest apply. */
export function parseOverrides(raw: string | null | undefined): { overrides: Record<string, OutcomeOverride>; warnings: string[] } {
  if (!raw) return { overrides: {}, warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { overrides: {}, warnings: ['The stored outcome map is not valid JSON — defaults are in use.'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { overrides: {}, warnings: ['The stored outcome map is not an object — defaults are in use.'] };
  const overrides: Record<string, OutcomeOverride> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const problem = overrideProblem(key, value);
    if (problem) {
      warnings.push(`Ignored outcome override ${problem} — the default is in use.`);
      continue;
    }
    const v = value as OutcomeOverride;
    overrides[key] = { stageRole: v.stageRole, appointment: v.appointment, opportunityStatus: v.opportunityStatus };
  }
  return { overrides, warnings };
}

export function applyOverrides(overrides: Record<string, OutcomeOverride>, defaults: readonly OutcomeDef[] = DEFAULT_OUTCOMES): OutcomeDef[] {
  return defaults.map((d) => (overrides[d.key] ? { ...d, ...overrides[d.key] } : { ...d }));
}

/** The outcomes offered for a call type. 'Other' calls (and people with no call) get "Move to…" only. */
export function outcomesFor(callType: CallType, defs: readonly OutcomeDef[]): OutcomeDef[] {
  if (callType === 'Other') return [];
  return defs.filter((d) => d.callType === callType);
}

// ---- resolution against the followed pipeline ----------------------------------------------------------------

export interface StageRef {
  id: string;
  name: string;
  role: SemanticRole | null;
  position: number | null;
}

/** The stage mapped to a role — the lowest position when several carry it; null when none does. */
export function resolveStage(role: SemanticRole, stages: readonly StageRef[]): StageRef | null {
  const hits = stages.filter((s) => s.role === role).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.name.localeCompare(b.name));
  return hits[0] ?? null;
}

export function appointmentEffect(action: AppointmentAction, reschedule: RescheduleAppointment): AppointmentEffect {
  return action === 'reschedule_setting' ? reschedule : action;
}

export interface ResolvedOutcome {
  key: string;
  label: string;
  /** null = unchanged. */
  toStage: StageRef | null;
  stageRole: SemanticRole | null;
  appointment: AppointmentEffect;
  /** null = unchanged. */
  opportunityStatus: OutcomeOpportunityStatus | null;
}

export type Resolution = { ok: true; outcome: ResolvedOutcome } | { ok: false; reason: string };

export interface ResolveContext {
  pipelineName: string | null;
  stages: readonly StageRef[];
  reschedule: RescheduleAppointment;
}

export function noStageReason(role: SemanticRole, pipelineName: string | null): string {
  return `No stage in ${pipelineName ?? 'the followed pipeline'} is mapped to the role ${role} — map it in Setup → Pipelines.`;
}

/** A catalogue outcome against the live stage map. A role with no stage is a refusal, never a guess. */
export function resolveOutcome(def: OutcomeDef, ctx: ResolveContext): Resolution {
  let toStage: StageRef | null = null;
  if (def.stageRole) {
    toStage = resolveStage(def.stageRole, ctx.stages);
    if (!toStage) return { ok: false, reason: noStageReason(def.stageRole, ctx.pipelineName) };
  }
  return { ok: true, outcome: { key: def.key, label: def.label, toStage, stageRole: def.stageRole, appointment: appointmentEffect(def.appointment, ctx.reschedule), opportunityStatus: def.opportunityStatus } };
}

/** "Move to…": a stage of the followed pipeline by id + an appointment effect; the opportunity status is kept. */
export function resolveMoveTo(input: { stageId: string; appointment: AppointmentEffect }, ctx: ResolveContext): Resolution {
  const stage = ctx.stages.find((s) => s.id === input.stageId);
  if (!stage) return { ok: false, reason: `Stage ${input.stageId} is not in ${ctx.pipelineName ?? 'the followed pipeline'}.` };
  if (!APPOINTMENT_EFFECTS.includes(input.appointment)) return { ok: false, reason: `Appointment status must be one of ${APPOINTMENT_EFFECTS.join(', ')}.` };
  return { ok: true, outcome: { key: MOVE_TO_KEY, label: `Move to ${stage.name}`, toStage: stage, stageRole: stage.role, appointment: input.appointment, opportunityStatus: null } };
}
