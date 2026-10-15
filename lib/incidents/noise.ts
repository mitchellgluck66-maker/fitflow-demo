/**
 * Incident hygiene — the open-incident list must be something a human always
 * reads. Production audit (2026-09-18): 115 open incidents, mostly
 * unmapped-stage rows from 14 pipelines nobody follows, burying real alerts.
 *
 * "Noise" (auto-resolved, never raised again):
 *   - unmapped_stage whose stage now has a role, is archived, no longer
 *     exists, or belongs to an unfollowed / archived pipeline;
 *   - silence incidents older than 48h (a newer sync has run since);
 *   - repeated error incidents with the same message — all but the newest;
 *   - (2026-10-15) an incident raised by a run that FAILED / timed out, once a later run of the same step
 *     (same sync_runs.kind) has succeeded — resolved with details.resolvedBy naming that run. A failure is
 *     superseded by success; a condition raised inside a succeeded run (unmapped stage, drift, token expiry)
 *     keeps its own lifecycle and is never closed this way.
 * Runs at the start of every GHL sync, when a pipeline is unfollowed, from
 * the dispatch, from Setup ("Resolve all noise") and `npm run incidents:sweep`.
 */

import { and, asc, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { db, syncIncidents, syncRuns, stages, pipelines } from '@/db';

export interface NoiseSweepResult {
  /** Raised by a failed / timed-out run whose step has since succeeded (2026-10-15). */
  supersededResolved: number;
  unmappedResolved: number;
  silenceResolved: number;
  duplicateErrorsResolved: number;
  total: number;
  /** Open incidents left after the sweep — the number a human reads. */
  openAfter: number;
}

const SILENCE_TTL_MS = 48 * 60 * 60 * 1000;

export async function sweepIncidentNoise(now: Date = new Date()): Promise<NoiseSweepResult> {
  const out: NoiseSweepResult = { supersededResolved: 0, unmappedResolved: 0, silenceResolved: 0, duplicateErrorsResolved: 0, total: 0, openAfter: 0 };
  const resolve = async (ids: string[]) => {
    for (const id of ids) await db.update(syncIncidents).set({ resolvedAt: now }).where(and(eq(syncIncidents.id, id), isNull(syncIncidents.resolvedAt)));
    return ids.length;
  };

  // ---- superseded by a later successful run of the same step (2026-10-15) ------
  const openFromRuns = await db
    .select({ id: syncIncidents.id, details: syncIncidents.details, runKind: syncRuns.kind, runStatus: syncRuns.status, runStartedAt: syncRuns.startedAt })
    .from(syncIncidents)
    .innerJoin(syncRuns, eq(syncIncidents.syncRunId, syncRuns.id))
    .where(isNull(syncIncidents.resolvedAt));
  for (const i of openFromRuns) {
    if (i.runStatus !== 'failed' && i.runStatus !== 'timed_out') continue;
    const [later] = await db
      .select({ id: syncRuns.id, startedAt: syncRuns.startedAt, finishedAt: syncRuns.finishedAt })
      .from(syncRuns)
      .where(and(eq(syncRuns.kind, i.runKind), eq(syncRuns.status, 'succeeded'), gt(syncRuns.startedAt, i.runStartedAt)))
      .orderBy(asc(syncRuns.startedAt))
      .limit(1);
    if (!later) continue;
    const resolvedBy = `${i.runKind} run ${later.id} succeeded at ${(later.finishedAt ?? later.startedAt).toISOString()}`;
    await db
      .update(syncIncidents)
      .set({ resolvedAt: now, details: { ...(i.details ?? {}), resolvedBy } })
      .where(and(eq(syncIncidents.id, i.id), isNull(syncIncidents.resolvedAt)));
    out.supersededResolved += 1;
  }

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

  out.total = out.supersededResolved + out.unmappedResolved + out.silenceResolved + out.duplicateErrorsResolved;
  out.openAfter = (await db.select({ id: syncIncidents.id }).from(syncIncidents).where(isNull(syncIncidents.resolvedAt))).length;
  return out;
}
