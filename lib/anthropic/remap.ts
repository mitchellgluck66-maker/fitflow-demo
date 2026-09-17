/**
 * Claude-suggested semantic role for an unmapped stage. SUGGESTION ONLY:
 * nothing is stored or applied here — a human clicks Apply in Setup.
 */

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, stages } from '@/db';
import { SEMANTIC_ROLES, ROLE_LABELS, isSemanticRole, type SemanticRole } from '../ghl/roles';
import { askClaude } from './client';
import { getAnthropicConfig } from './config';
import { REMAP_SYSTEM, REMAP_TOOL_SCHEMA } from './prompts';

const ROLE_DESCRIPTIONS: Record<SemanticRole, string> = {
  applied: 'Submitted an application / new lead at the top of the funnel',
  consult_booked: 'Has a consult (discovery/intro call) booked',
  consult_noshow: 'Missed the consult',
  consult_rescheduled: 'Consult was rescheduled / needs to be rebooked — followed up daily until it is',
  roadmap_booked: 'Has the roadmap / strategy session booked',
  roadmap_showed: 'Attended the roadmap session (including objection/undecided outcomes)',
  roadmap_rescheduled: 'Roadmap session was rescheduled / needs to be rebooked — followed up daily until it is',
  enrolled: 'Became a paying client',
  previous_lead: 'Parked older lead being re-engaged; counted on its own row, excluded from conversion math',
  other: 'Not part of the funnel (archive, nurture, lost, etc.)',
};

const RemapSchema = z.object({ role: z.string(), confidence: z.number().min(0).max(1), rationale: z.string().max(400) });

export interface RemapSuggestion {
  ok: boolean;
  notConfigured?: boolean;
  stageId: string;
  stageName: string | null;
  role: SemanticRole | null;
  confidence: number | null;
  rationale: string | null;
  model: string | null;
  error?: string;
}

export async function suggestRoleForStage(stageId: string): Promise<RemapSuggestion> {
  const [stage] = await db.select().from(stages).where(eq(stages.id, stageId)).limit(1);
  if (!stage) return { ok: false, stageId, stageName: null, role: null, confidence: null, rationale: null, model: null, error: 'Stage not found' };
  const siblings = await db
    .select({ id: stages.id, name: stages.name, role: stages.semanticRole })
    .from(stages)
    .where(eq(stages.pipelineId, stage.pipelineId))
    .orderBy(asc(stages.position));

  const config = await getAnthropicConfig();
  if (!config.configured) {
    return { ok: false, notConfigured: true, stageId, stageName: stage.name, role: null, confidence: null, rationale: null, model: null, error: 'Anthropic not configured' };
  }

  const answer = await askClaude({
    system: REMAP_SYSTEM,
    user: JSON.stringify({
      stage: stage.name,
      pipelineStages: siblings.map((s) => ({ name: s.name, currentRole: s.role, isTarget: s.id === stageId })),
      allowedRoles: SEMANTIC_ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r] })),
    }),
    inputSchema: { ...REMAP_TOOL_SCHEMA, properties: { ...REMAP_TOOL_SCHEMA.properties, role: { type: 'string', enum: [...SEMANTIC_ROLES] } } } as unknown as Record<string, unknown>,
    schema: RemapSchema,
    toolName: 'submit_role',
    maxTokens: 300,
  });
  if (!answer.ok || !answer.data) {
    return { ok: false, notConfigured: answer.notConfigured, stageId, stageName: stage.name, role: null, confidence: null, rationale: null, model: answer.model, error: answer.error };
  }
  const role = isSemanticRole(answer.data.role) ? answer.data.role : 'other';
  return { ok: true, stageId, stageName: stage.name, role, confidence: Math.round(answer.data.confidence * 100) / 100, rationale: answer.data.rationale, model: answer.model };
}
