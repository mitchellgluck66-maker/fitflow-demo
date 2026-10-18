/**
 * Companion stage 2, item 3 — the outcome catalogue against the database: the followed pipeline's stage map, the
 * owner's overrides and the reschedule rule, resolved per outcome. One reader for Setup, the pop-out and the log.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, pipelines, stages } from '@/db';
import { getSetting } from '../settings';
import { isDefaultFollowedPipeline } from '../ghl/followed';
import { COMPANION_SETTING_KEYS, readDryRun, readRescheduleAppointment, type DryRunState, type RescheduleAppointment } from './config';
import type { CallType } from './calendars';
import {
  DEFAULT_OUTCOMES,
  applyOverrides,
  outcomesFor,
  parseOverrides,
  resolveOutcome,
  resolveStage,
  type AppointmentEffect,
  type OutcomeDef,
  type OutcomeOverride,
  type ResolveContext,
  type StageRef,
} from './outcomes';

export interface FollowedPipeline {
  id: string;
  name: string;
  stages: StageRef[];
}

/**
 * The funnel pipeline: the hard-default followed pipeline when it is followed, else the first followed pipeline by
 * name. Archived stages are excluded. Null when nothing is followed.
 */
export async function readFollowedPipeline(): Promise<FollowedPipeline | null> {
  const rows = await db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).where(and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt))).orderBy(asc(pipelines.name));
  if (rows.length === 0) return null;
  const p = rows.find((r) => isDefaultFollowedPipeline(r.id)) ?? rows[0];
  const s = await db
    .select({ id: stages.id, name: stages.name, role: stages.semanticRole, position: stages.position })
    .from(stages)
    .where(and(eq(stages.pipelineId, p.id), isNull(stages.archivedAt)))
    .orderBy(asc(stages.position), asc(stages.name));
  return { id: p.id, name: p.name, stages: s.map((x) => ({ id: x.id, name: x.name, role: x.role ?? null, position: x.position ?? null })) };
}

export interface OutcomeCatalogue {
  defs: OutcomeDef[];
  overrides: Record<string, OutcomeOverride>;
  warnings: string[];
  reschedule: RescheduleAppointment;
  pipeline: FollowedPipeline | null;
  ctx: ResolveContext;
}

export async function readOutcomeCatalogue(): Promise<OutcomeCatalogue> {
  const [raw, reschedule, pipeline] = await Promise.all([getSetting(COMPANION_SETTING_KEYS.outcomeMap), readRescheduleAppointment(), readFollowedPipeline()]);
  const { overrides, warnings } = parseOverrides(raw);
  const defs = applyOverrides(overrides, DEFAULT_OUTCOMES);
  return { defs, overrides, warnings, reschedule, pipeline, ctx: { pipelineName: pipeline?.name ?? null, stages: pipeline?.stages ?? [], reschedule } };
}

export interface OutcomeOption {
  key: string;
  label: string;
  stageRole: string | null;
  toStage: { id: string; name: string } | null;
  appointment: AppointmentEffect;
  opportunityStatus: 'open' | 'won' | 'lost' | null;
  /** Set when the outcome cannot be logged (a role with no stage); the button is disabled with this title. */
  unavailable: string | null;
}

export interface OutcomesForCall {
  dryRun: DryRunState;
  callType: CallType;
  outcomes: OutcomeOption[];
  moveTo: { pipeline: { id: string; name: string } | null; stages: Array<{ id: string; name: string; role: string | null }>; appointments: readonly AppointmentEffect[] };
}

/** What the pop-out offers for a call type (GET /api/companion/outcomes). */
export async function getOutcomesForCall(callType: CallType): Promise<OutcomesForCall> {
  const [dryRun, cat] = await Promise.all([readDryRun(), readOutcomeCatalogue()]);
  const outcomes = outcomesFor(callType, cat.defs).map<OutcomeOption>((d) => {
    const r = resolveOutcome(d, cat.ctx);
    if (!r.ok) return { key: d.key, label: d.label, stageRole: d.stageRole, toStage: null, appointment: d.appointment === 'reschedule_setting' ? cat.reschedule : d.appointment, opportunityStatus: d.opportunityStatus, unavailable: cat.pipeline ? r.reason : 'Follow a pipeline in Setup first.' };
    return { key: d.key, label: d.label, stageRole: d.stageRole, toStage: r.outcome.toStage ? { id: r.outcome.toStage.id, name: r.outcome.toStage.name } : null, appointment: r.outcome.appointment, opportunityStatus: r.outcome.opportunityStatus, unavailable: null };
  });
  return {
    dryRun,
    callType,
    outcomes,
    moveTo: { pipeline: cat.pipeline ? { id: cat.pipeline.id, name: cat.pipeline.name } : null, stages: (cat.pipeline?.stages ?? []).map((s) => ({ id: s.id, name: s.name, role: s.role })), appointments: ['showed', 'noshow', 'cancelled', 'leave'] },
  };
}

/** Setup's table: every default with its effective values and the stage it resolves to today. */
export function catalogueRows(cat: OutcomeCatalogue): Array<OutcomeDef & { resolvedStage: { id: string; name: string } | null }> {
  return cat.defs.map((d) => {
    const s = d.stageRole ? resolveStage(d.stageRole, cat.ctx.stages) : null;
    return { ...d, resolvedStage: s ? { id: s.id, name: s.name } : null };
  });
}
