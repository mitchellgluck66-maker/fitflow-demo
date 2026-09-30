/**
 * Stage roles are resolved at READ time (F4, 2026-09-30) — the one source of truth is `stages.semantic_role`.
 *
 * The 2026-09-29 verification: 137 transitions in the followed pipeline still carried the role their stage had
 * when they were written (Previous Leads, Roadmap No Show, the reschedule stages were remapped on Sep 17 and
 * history never followed): "Previous leads" read 0, 23 re-engaged leads counted as applied, the roadmap no-show
 * to-do missed 36 people. Rewriting history on every remap would be a second writer that can fail or lag; reading
 * through `to_stage_id` / `from_stage_id` makes a remap in Setup correct everywhere at once (dashboard, emails,
 * Ask, insights — all through lib/metrics/load.ts). The stored role is only a fallback for a stage that no longer
 * exists; it stays in the table as "the role at observation".
 *
 * Usage: .from(stageTransitions).leftJoin(toStage, toStageJoin).leftJoin(fromStage, fromStageJoin)
 *        and select resolvedToRole / resolvedFromRole.
 */
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { stages, stageTransitions, type SemanticRole } from '@/db';

export const toStage = alias(stages, 'to_stage');
export const fromStage = alias(stages, 'from_stage');
export const toStageJoin = eq(toStage.id, stageTransitions.toStageId);
export const fromStageJoin = eq(fromStage.id, stageTransitions.fromStageId);

export const resolvedToRole = sql<SemanticRole | null>`case when ${toStage.id} is not null then ${toStage.semanticRole} else ${stageTransitions.toRole} end`;
export const resolvedFromRole = sql<SemanticRole | null>`case when ${fromStage.id} is not null then ${fromStage.semanticRole} else ${stageTransitions.fromRole} end`;
