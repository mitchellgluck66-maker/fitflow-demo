/**
 * Nightly reconciliation — does our mirror still match GoHighLevel?
 *
 * For every followed pipeline, ask GHL (read-only, one cheap `limit=1`
 * search per stage) how many OPEN opportunities sit in each stage right now,
 * and compare with our mirror's in-stage-now count (contacts whose current
 * stage is that stage and whose opportunity is open). A stage that differs
 * by more than max(2, 10%) raises a `reconcile_mismatch` incident naming the
 * stage and both numbers; a stage that matches again resolves it. The
 * summary is stored in settings so Setup can say
 * "last reconciled <time> — mirror matches GHL: yes/no".
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db, contacts, pipelines, stages, syncIncidents, syncRuns } from '@/db';
import { countOpenOpportunities } from './client';
import { getGhlConfig } from './config';
import { setSetting, getSetting } from '../settings';

export const RECONCILE_KEYS = {
  lastAt: 'ghl_last_reconciled_at',
  summary: 'ghl_reconcile_summary',
} as const;

export interface StageDiff {
  stageId: string;
  stageName: string;
  pipelineId: string;
  pipelineName: string;
  live: number;
  mirror: number;
  threshold: number;
  mismatch: boolean;
}

export interface ReconcileSummary {
  at: string;
  ok: boolean;
  stagesChecked: number;
  mismatches: Array<Pick<StageDiff, 'stageId' | 'stageName' | 'pipelineName' | 'live' | 'mirror'>>;
  skipped: string[];
  requests: number;
}

export interface ReconcileResult {
  ok: boolean;
  notConfigured?: boolean;
  runId: string | null;
  summary: ReconcileSummary | null;
  error?: string;
}

/** max(2, 10% of the larger count) — pure. */
export function mismatchThreshold(live: number, mirror: number): number {
  return Math.max(2, Math.ceil(0.1 * Math.max(live, mirror)));
}

export function isMismatch(live: number, mirror: number): boolean {
  return Math.abs(live - mirror) > mismatchThreshold(live, mirror);
}

export async function readReconcileSummary(): Promise<ReconcileSummary | null> {
  const raw = await getSetting(RECONCILE_KEYS.summary);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReconcileSummary;
  } catch {
    return null;
  }
}

export async function runReconcile(options: { trigger: 'cron' | 'manual' | 'cli' }): Promise<ReconcileResult> {
  const startedAt = new Date();
  const config = await getGhlConfig();
  if (!config.configured) return { ok: false, notConfigured: true, runId: null, summary: null, error: 'GoHighLevel is not connected.' };

  const [run] = await db.insert(syncRuns).values({ kind: 'ghl_reconcile', trigger: options.trigger, status: 'running', startedAt }).returning({ id: syncRuns.id });

  try {
    const followed = await db
      .select({ id: pipelines.id, name: pipelines.name })
      .from(pipelines)
      .where(and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt), eq(pipelines.origin, 'ghl')));
    const diffs: StageDiff[] = [];
    const skipped: string[] = [];
    let requests = 0;

    for (const p of followed) {
      const stageRows = await db.select({ id: stages.id, name: stages.name }).from(stages).where(and(eq(stages.pipelineId, p.id), isNull(stages.archivedAt)));
      for (const st of stageRows) {
        const live = await countOpenOpportunities({ pipelineId: p.id, stageId: st.id });
        requests += 1;
        if (live.total === null) {
          skipped.push(`${p.name} › ${st.name}: ${live.error ?? 'GHL did not return a total'}`);
          continue;
        }
        const [{ mirror }] = await db
          .select({ mirror: sql<number>`count(*)::int` })
          .from(contacts)
          .where(and(eq(contacts.stageId, st.id), eq(contacts.pipelineId, p.id), or(eq(contacts.opportunityStatus, 'open'), isNull(contacts.opportunityStatus))));
        diffs.push({ stageId: st.id, stageName: st.name, pipelineId: p.id, pipelineName: p.name, live: live.total, mirror, threshold: mismatchThreshold(live.total, mirror), mismatch: isMismatch(live.total, mirror) });
      }
    }

    // One open reconcile_mismatch incident per stage, always describing the latest diff.
    const openMismatch = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'reconcile_mismatch'), isNull(syncIncidents.resolvedAt)));
    const byStage = new Map(openMismatch.map((i) => [String(i.details?.stageId ?? ''), i]));
    for (const d of diffs) {
      const existing = byStage.get(d.stageId);
      if (d.mismatch) {
        if (existing) await db.update(syncIncidents).set({ resolvedAt: startedAt }).where(eq(syncIncidents.id, existing.id));
        await db.insert(syncIncidents).values({
          syncRunId: run.id,
          kind: 'reconcile_mismatch',
          severity: 'warning',
          message: `Mirror differs from GoHighLevel: "${d.stageName}" (${d.pipelineName}) has ${d.live} open in GHL but ${d.mirror} here (allowed ±${d.threshold}). Run a sync; if it persists, check the stage mapping.`,
          details: { stageId: d.stageId, stageName: d.stageName, pipelineId: d.pipelineId, live: d.live, mirror: d.mirror, threshold: d.threshold },
        });
      } else if (existing) {
        await db.update(syncIncidents).set({ resolvedAt: startedAt }).where(eq(syncIncidents.id, existing.id));
      }
    }
    // Stages no longer checked (archived / unfollowed) lose their mismatch incident.
    const checked = new Set(diffs.map((d) => d.stageId));
    for (const [stageId, inc] of byStage) if (!checked.has(stageId)) await db.update(syncIncidents).set({ resolvedAt: startedAt }).where(eq(syncIncidents.id, inc.id));

    const mismatches = diffs.filter((d) => d.mismatch).map(({ stageId, stageName, pipelineName, live, mirror }) => ({ stageId, stageName, pipelineName, live, mirror }));
    const summary: ReconcileSummary = { at: startedAt.toISOString(), ok: mismatches.length === 0, stagesChecked: diffs.length, mismatches, skipped, requests };
    await setSetting(RECONCILE_KEYS.lastAt, summary.at);
    await setSetting(RECONCILE_KEYS.summary, JSON.stringify(summary));
    await db
      .update(syncRuns)
      .set({ status: 'succeeded', finishedAt: new Date(), requestsUsed: requests, stats: { stagesChecked: diffs.length, mismatches: mismatches.length, skipped: skipped.length }, warnings: skipped })
      .where(eq(syncRuns.id, run.id));
    return { ok: true, runId: run.id, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(syncRuns).set({ status: 'failed', finishedAt: new Date(), error: message }).where(eq(syncRuns.id, run.id));
    return { ok: false, runId: run.id, summary: null, error: message };
  }
}
