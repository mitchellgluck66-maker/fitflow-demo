/**
 * Incident hygiene — the open-incident list must be something a human always
 * reads. Production audit (2026-09-18): 115 open incidents, mostly
 * unmapped-stage rows from 14 pipelines nobody follows, burying real alerts.
 *
 * "Noise" (auto-resolved, never raised again):
 *   - unmapped_stage whose stage now has a role, is archived, no longer
 *     exists, or belongs to an unfollowed / archived pipeline;
 *   - silence incidents older than 48h (a newer sync has run since);
 *   - repeated error incidents with the same message — all but the newest.
 * Runs at the start of every GHL sync, when a pipeline is unfollowed, from
 * the dispatch, from Setup ("Resolve all noise") and `npm run incidents:sweep`.
 */

import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { db, syncIncidents, stages, pipelines } from '@/db';

export interface NoiseSweepResult {
  unmappedResolved: number;
  silenceResolved: number;
  duplicateErrorsResolved: number;
  total: number;
  /** Open incidents left after the sweep — the number a human reads. */
  openAfter: number;
}

const SILENCE_TTL_MS = 48 * 60 * 60 * 1000;

export async function sweepIncidentNoise(now: Date = new Date()): Promise<NoiseSweepResult> {
  const out: NoiseSweepResult = { unmappedResolved: 0, silenceResolved: 0, duplicateErrorsResolved: 0, total: 0, openAfter: 0 };
  const resolve = async (ids: string[]) => {
    for (const id of ids) await db.update(syncIncidents).set({ resolvedAt: now }).where(and(eq(syncIncidents.id, id), isNull(syncIncidents.resolvedAt)));
    return ids.length;
  };

  // ---- unmapped_stage -------------------------------------------------------
  const openUnmapped = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'unmapped_stage'), isNull(syncIncidents.resolvedAt)));
  if (openUnmapped.length) {
    const stageRows = await db
      .select({ id: stages.id, role: stages.semanticRole, archivedAt: stages.archivedAt, pipelineTracked: pipelines.isTracked, pipelineArchived: pipelines.archivedAt })
      .from(stages)
      .leftJoin(pipelines, eq(stages.pipelineId, pipelines.id));
    const byId = new Map(stageRows.map((s) => [s.id, s]));
    const noise = openUnmapped.filter((i) => {
      const stageId = typeof i.details?.stageId === 'string' ? i.details.stageId : null;
      const st = stageId ? byId.get(stageId) : undefined;
      if (!st) return true; // stage gone (or incident without a stage) — nothing to map
      return st.role !== null || st.archivedAt !== null || !st.pipelineTracked || st.pipelineArchived !== null;
    });
    out.unmappedResolved = await resolve(noise.map((i) => i.id));
  }

  // ---- stale silence notices ----------------------------------------------
  const oldSilence = await db
    .select({ id: syncIncidents.id })
    .from(syncIncidents)
    .where(and(eq(syncIncidents.kind, 'silence'), isNull(syncIncidents.resolvedAt), lt(syncIncidents.createdAt, new Date(now.getTime() - SILENCE_TTL_MS))));
  out.silenceResolved = await resolve(oldSilence.map((r) => r.id));

  // ---- duplicate errors: keep the newest per message -----------------------
  const openErrors = await db
    .select({ id: syncIncidents.id, message: syncIncidents.message })
    .from(syncIncidents)
    .where(and(eq(syncIncidents.kind, 'error'), isNull(syncIncidents.resolvedAt)))
    .orderBy(desc(syncIncidents.createdAt));
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const e of openErrors) {
    if (seen.has(e.message)) dupes.push(e.id);
    else seen.add(e.message);
  }
  out.duplicateErrorsResolved = await resolve(dupes);

  out.total = out.unmappedResolved + out.silenceResolved + out.duplicateErrorsResolved;
  out.openAfter = (await db.select({ id: syncIncidents.id }).from(syncIncidents).where(isNull(syncIncidents.resolvedAt))).length;
  return out;
}
