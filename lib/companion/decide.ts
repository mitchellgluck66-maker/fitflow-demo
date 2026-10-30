/**
 * Companion stage 5, item 2 — the two write decisions, PURE, from GoHighLevel's LIVE state (never the mirror, never
 * the brief cache). `lib/companion/log.ts` reads the opportunity and the appointment live immediately before planning
 * and before writing, and asks here what to send.
 *
 *   stage       — skipped when the live stage AND status already equal the target ("already in X"); a mapped outcome
 *                 whose target sits EARLIER in the pipeline order than the live stage is skipped ("already past X (in
 *                 Y)") — only "Move to…" goes backward, and says so (`backward`). A same-stage re-save would re-fire
 *                 GHL's stage workflows (Bridget Voigt, 2026-10-30: the roadmap-booked congratulations).
 *   appointment — skipped when the live status already equals the target ("already showed"), when the outcome leaves
 *                 it alone ("left as is") or when there is no call ("no appointment").
 */

import type { AppointmentEffect, ResolvedOutcome, StageRef } from './outcomes';
import { MOVE_TO_KEY } from './outcomes';

export interface LiveOpportunityState {
  id: string;
  stageId: string | null;
  status: string;
}

export type StageRequestBody = { pipelineId: string; pipelineStageId?: string; status?: 'open' | 'won' | 'lost' };

export type StageDecision =
  | { send: true; body: StageRequestBody; stageChange: boolean; statusChange: boolean; backward: boolean; summary: string }
  | { send: false; reason: string; backward: false; summary: string };

export function stageNameOf(stages: readonly StageRef[], id: string | null): string | null {
  return id ? (stages.find((s) => s.id === id)?.name ?? null) : null;
}

function positionOf(stages: readonly StageRef[], id: string | null): number | null {
  const s = id ? stages.find((x) => x.id === id) : undefined;
  return typeof s?.position === 'number' ? s.position : null;
}

export function decideStage(p: { live: LiveOpportunityState | null; pipeline: { id: string; name: string } | null; resolved: ResolvedOutcome; stages: readonly StageRef[] }): StageDecision {
  const { live, resolved, stages } = p;
  if (!live) return { send: false, reason: p.pipeline ? `no opportunity in ${p.pipeline.name}` : 'no followed pipeline', backward: false, summary: 'Stage — skipped' };
  const currentName = stageNameOf(stages, live.stageId);
  const target = resolved.toStage;
  const stageChange = Boolean(target && target.id !== live.stageId);
  const statusChange = Boolean(resolved.opportunityStatus && resolved.opportunityStatus !== live.status);
  const isMoveTo = resolved.key === MOVE_TO_KEY;
  const from = positionOf(stages, live.stageId);
  const to = target ? positionOf(stages, target.id) : null;
  const goesBack = stageChange && from !== null && to !== null && to < from;
  if (stageChange && goesBack && !isMoveTo) {
    return { send: false, reason: `already past ${target!.name} (in ${currentName ?? live.stageId ?? 'an unknown stage'})`, backward: false, summary: `Stage — ${currentName ?? 'unchanged'}` };
  }
  if (!stageChange && !statusChange) {
    const reason = target ? `already in ${currentName ?? target.name}` : resolved.opportunityStatus && resolved.opportunityStatus !== 'open' ? `already ${live.status}` : 'stage unchanged';
    return { send: false, reason, backward: false, summary: `Stage — ${currentName ?? 'unchanged'}` };
  }
  const body: StageRequestBody = { pipelineId: p.pipeline!.id, ...(stageChange ? { pipelineStageId: target!.id } : {}), ...(statusChange ? { status: resolved.opportunityStatus! } : {}) };
  const summary = stageChange ? `Stage ${currentName ?? 'no stage'} → ${target!.name}${statusChange ? ` · ${resolved.opportunityStatus}` : ''}` : `Opportunity ${live.status} → ${resolved.opportunityStatus}`;
  return { send: true, body, stageChange, statusChange, backward: goesBack, summary };
}

export type AppointmentDecision = { send: true; status: Exclude<AppointmentEffect, 'leave'>; summary: string } | { send: false; reason: string; summary: string };

export function decideAppointment(p: { call: { liveStatus: string | null } | null; effect: AppointmentEffect }): AppointmentDecision {
  if (!p.call) return { send: false, reason: 'no appointment', summary: 'Appointment — none' };
  if (p.effect === 'leave') return { send: false, reason: 'left as is', summary: `Appointment — left ${p.call.liveStatus ?? 'as is'}` };
  if (p.call.liveStatus === p.effect) return { send: false, reason: `already ${p.effect}`, summary: `Appointment — already ${p.effect}` };
  return { send: true, status: p.effect, summary: `Appointment ${p.call.liveStatus ?? '?'} → ${p.effect}` };
}
