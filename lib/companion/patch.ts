/**
 * Companion stage 5, item 6 — "match a manual drag" (pure). A person dragging a card in GoHighLevel never re-saves the
 * stage the card is already in, so they never re-fire that stage's workflows. FitFlow's stage PUT must be the same:
 * the body carries ONLY what changes — `pipelineStageId` when the stage changes, `status` when the status changes,
 * `pipelineId` only when the opportunity's pipeline differs from the followed one. A body whose every field equals
 * the live value is empty, and an empty body is never sent (`ghlWrite#updateOpportunity` skips it as "no change").
 */

export interface OpportunityPatchTarget {
  pipelineId?: string;
  pipelineStageId?: string;
  status?: 'open' | 'won' | 'lost' | 'abandoned';
}

export interface OpportunityLiveState {
  /** null = unknown (a `pipelineId` in the target is then kept as given). */
  pipelineId: string | null;
  stageId: string | null;
  status: string | null;
}

/** The fields of `target` that differ from `live`; `{}` when nothing differs. */
export function minimalOpportunityPatch(target: OpportunityPatchTarget, live: OpportunityLiveState): OpportunityPatchTarget {
  const out: OpportunityPatchTarget = {};
  if (target.pipelineId !== undefined && (live.pipelineId === null || target.pipelineId !== live.pipelineId)) out.pipelineId = target.pipelineId;
  if (target.pipelineStageId !== undefined && target.pipelineStageId !== live.stageId) out.pipelineStageId = target.pipelineStageId;
  if (target.status !== undefined && target.status !== live.status) out.status = target.status;
  // A pipeline id alone changes nothing GHL would act on without a stage / status to move.
  if (out.pipelineStageId === undefined && out.status === undefined) return {};
  return out;
}

/** True when the patch would re-save what GHL already holds (the Bridget Voigt shape). */
export function isNoopOpportunityPatch(target: OpportunityPatchTarget, live: OpportunityLiveState): boolean {
  return Object.keys(minimalOpportunityPatch(target, live)).length === 0;
}
