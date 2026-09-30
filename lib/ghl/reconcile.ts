/**
 * Reconciliation v2 — does our mirror match GoHighLevel, opportunity for opportunity? (F7, 2026-09-30)
 *
 * The v1 probe asked only for OPEN opportunities per stage and compared them with CONTACTS — so Enrolled (all
 * "won") always probed 0, and a "" in meta.nextPage made 2 of 9 stages skip every night. v2, per followed pipeline:
 *   - one limit=1 `meta.total` probe per stage × status (open / won / lost / abandoned) plus the pipeline total,
 *   - compared EXACTLY with ghl_opportunities (opportunities vs opportunities);
 *   - any difference → a targeted re-fetch of that stage (every page, plus each mirror row GHL no longer lists
 *     there, by id) through the tracked job's own code path, then a re-probe;
 *   - still different → ONE open critical `reconcile_mismatch` incident per (stage, status) with both numbers;
 *   - a probe that returned no total → a critical `reconcile_skipped` incident and a FAILED run — never a silent skip.
 * Holds the GHL lease while it runs (a moving mirror is not worth comparing). Summary in settings for Setup.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, pipelines, stages, syncIncidents, syncRuns, ghlOpportunities } from '@/db';
import { countOpportunities, getOpportunity, listOpportunitiesPage, OPPORTUNITY_STATUSES } from './client';
import { getGhlConfig } from './config';
import { setSetting, getSetting } from '../settings';
import { acquireLock, releaseLock } from '../syncLock';
import { GHL_LOCK, GHL_LOCK_TTL_MS, refreshOpportunities, PAGE_LIMIT } from './ingest';
import type { GhlOpportunity } from './schemas';

export const RECONCILE_KEYS = {
  lastAt: 'ghl_last_reconciled_at',
  summary: 'ghl_reconcile_summary',
} as const;

export interface ReconcileCheck {
  pipelineId: string;
  pipelineName: string;
  /** null = the pipeline total (every stage, every status). */
  stageId: string | null;
  stageName: string;
  /** null = every status. */
  status: string | null;
  live: number;
  mirror: number;
}

export interface ReconcileSummary {
  at: string;
  ok: boolean;
  /** Stages probed (× statuses). */
  stagesChecked: number;
  checks: number;
  statuses: string[];
  mismatches: Array<{ stageId: string | null; stageName: string; pipelineName: string; status: string | null; live: number; mirror: number }>;
  skipped: string[];
  /** Stages re-fetched because a first probe differed. */
  refetchedStages: number;
  requests: number;
}

export interface ReconcileResult {
  ok: boolean;
  notConfigured?: boolean;
  skipped?: string;
  runId: string | null;
  summary: ReconcileSummary | null;
  error?: string;
}

/** Kept for callers of the v1 tolerance (the verify harness); v2 compares exactly after a re-fetch. */
export function mismatchThreshold(live: number, mirror: number): number {
  return Math.max(2, Math.ceil(0.1 * Math.max(live, mirror)));
}
export function isMismatch(live: number, mirror: number): boolean {
  return live !== mirror;
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

const label = (c: Pick<ReconcileCheck, 'stageName' | 'status'>) => `${c.stageName}${c.status ? ` · ${c.status}` : ''}`;
const checkKey = (c: Pick<ReconcileCheck, 'pipelineId' | 'stageId' | 'status'>) => `${c.pipelineId}|${c.stageId ?? '*'}|${c.status ?? '*'}`;

async function mirrorCount(pipelineId: string, stageId: string | null, status: string | null): Promise<number> {
  const conds = [eq(ghlOpportunities.pipelineId, pipelineId)];
  if (stageId) conds.push(eq(ghlOpportunities.stageId, stageId));
  if (status) conds.push(eq(ghlOpportunities.status, status));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(ghlOpportunities).where(and(...conds));
  return Number(n);
}

export async function runReconcile(options: { trigger: 'cron' | 'manual' | 'cli' }): Promise<ReconcileResult> {
  const startedAt = new Date();
  const config = await getGhlConfig();
  if (!config.configured) return { ok: false, notConfigured: true, runId: null, summary: null, error: 'GoHighLevel is not connected.' };

  const holder = `reconcile:${options.trigger}:${startedAt.toISOString()}`;
  const lock = await acquireLock(GHL_LOCK, holder, GHL_LOCK_TTL_MS, startedAt);
  if (!lock.ok) return { ok: true, runId: null, summary: null, skipped: `a GHL sync holds the lock until ${lock.until?.toISOString() ?? 'unknown'} — reconcile waits for a still mirror` };

  const [run] = await db.insert(syncRuns).values({ kind: 'ghl_reconcile', trigger: options.trigger, status: 'running', startedAt }).returning({ id: syncRuns.id });
  let requests = 0;
  try {
    const followed = await db
      .select({ id: pipelines.id, name: pipelines.name })
      .from(pipelines)
      .where(and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt), eq(pipelines.origin, 'ghl')));
    const skipped: string[] = [];
    const targets: Array<Omit<ReconcileCheck, 'live' | 'mirror'>> = [];
    let stagesChecked = 0;
    for (const p of followed) {
      targets.push({ pipelineId: p.id, pipelineName: p.name, stageId: null, stageName: 'Pipeline total', status: null });
      const stageRows = await db.select({ id: stages.id, name: stages.name }).from(stages).where(and(eq(stages.pipelineId, p.id), isNull(stages.archivedAt)));
      stagesChecked += stageRows.length;
      for (const st of stageRows) for (const status of OPPORTUNITY_STATUSES) targets.push({ pipelineId: p.id, pipelineName: p.name, stageId: st.id, stageName: st.name, status });
    }

    const probe = async (t: Omit<ReconcileCheck, 'live' | 'mirror'>): Promise<ReconcileCheck | null> => {
      const live = await countOpportunities({ pipelineId: t.pipelineId, stageId: t.stageId ?? undefined, status: (t.status ?? undefined) as (typeof OPPORTUNITY_STATUSES)[number] | undefined });
      requests += 1;
      if (live.total === null) {
        skipped.push(`${t.pipelineName} › ${label(t)}: ${live.error ?? 'GHL did not return a total'}`);
        return null;
      }
      return { ...t, live: live.total, mirror: await mirrorCount(t.pipelineId, t.stageId, t.status) };
    };

    const first: ReconcileCheck[] = [];
    for (const t of targets) {
      const c = await probe(t);
      if (c) first.push(c);
    }

    // Targeted re-fetch of every stage that differs (a total-only difference re-fetches the whole pipeline's stages).
    const drift = first.filter((c) => c.live !== c.mirror);
    const stagesToRefetch = new Map<string, { pipelineId: string; stageId: string }>();
    for (const d of drift) {
      if (d.stageId) stagesToRefetch.set(d.stageId, { pipelineId: d.pipelineId, stageId: d.stageId });
      else for (const t of targets) if (t.pipelineId === d.pipelineId && t.stageId) stagesToRefetch.set(t.stageId, { pipelineId: t.pipelineId, stageId: t.stageId });
    }
    for (const { pipelineId, stageId } of stagesToRefetch.values()) {
      const seen = new Map<string, GhlOpportunity>();
      let at = { page: 1, startAfterId: null as string | null, startAfter: null as number | null };
      for (let i = 0; i < 50; i += 1) {
        const page = await listOpportunitiesPage({ pipelineId, stageId, page: at.page, startAfterId: at.startAfterId, startAfter: at.startAfter, limit: PAGE_LIMIT });
        requests += 1;
        if (page.error) throw new Error(`re-fetch of stage ${stageId} failed: ${page.error}`);
        for (const o of page.opportunities) seen.set(o.id, o);
        if (page.done) break;
        at = page.next;
      }
      // Mirror rows GHL no longer lists in this stage: read each by id (moved, re-statused or deleted).
      const stale = await db.select({ id: ghlOpportunities.id }).from(ghlOpportunities).where(and(eq(ghlOpportunities.pipelineId, pipelineId), eq(ghlOpportunities.stageId, stageId)));
      const gone: string[] = [];
      for (const { id } of stale) {
        if (seen.has(id)) continue;
        const one = await getOpportunity(id);
        requests += 1;
        if (one.opportunity) seen.set(id, one.opportunity);
        else if (one.notFound) gone.push(id);
        else throw new Error(`re-read of opportunity ${id} failed: ${one.error}`);
      }
      if (gone.length) await db.delete(ghlOpportunities).where(inArray(ghlOpportunities.id, gone)); // deleted in GHL
      const r = await refreshOpportunities([...seen.values()], run.id);
      requests += r.requests;
    }

    // Re-probe what differed; what still differs is a real mismatch.
    const final = new Map(first.map((c) => [checkKey(c), c]));
    for (const d of drift) {
      const c = await probe(d);
      if (c) final.set(checkKey(c), c);
    }
    const mismatches = [...final.values()].filter((c) => c.live !== c.mirror);

    // Incidents: one open reconcile_mismatch per (stage, status); one reconcile_skipped per run while probes fail.
    const open = await db.select().from(syncIncidents).where(and(inArray(syncIncidents.kind, ['reconcile_mismatch', 'reconcile_skipped']), isNull(syncIncidents.resolvedAt)));
    const openMismatch = new Map(open.filter((i) => i.kind === 'reconcile_mismatch').map((i) => [String(i.details?.key ?? ''), i]));
    for (const m of mismatches) {
      const key = checkKey(m);
      const message = `Mirror differs from GoHighLevel after a re-fetch: "${label(m)}" (${m.pipelineName}) has ${m.live} in GHL but ${m.mirror} here.`;
      const details = { key, stageId: m.stageId, stageName: m.stageName, status: m.status, pipelineId: m.pipelineId, live: m.live, mirror: m.mirror };
      const existing = openMismatch.get(key);
      if (existing) await db.update(syncIncidents).set({ message, details, severity: 'critical' }).where(eq(syncIncidents.id, existing.id));
      else await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'reconcile_mismatch', severity: 'critical', message, details });
    }
    const stillOpen = new Set(mismatches.map(checkKey));
    for (const [key, inc] of openMismatch) if (!stillOpen.has(key)) await db.update(syncIncidents).set({ resolvedAt: startedAt }).where(eq(syncIncidents.id, inc.id));
    const openSkipped = open.find((i) => i.kind === 'reconcile_skipped');
    if (skipped.length) {
      const message = `Reconcile could not probe ${skipped.length} check(s): ${skipped.slice(0, 5).join('; ')}`;
      if (openSkipped) await db.update(syncIncidents).set({ message, details: { skipped } }).where(eq(syncIncidents.id, openSkipped.id));
      else await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'reconcile_skipped', severity: 'critical', message, details: { skipped } });
    } else if (openSkipped) {
      await db.update(syncIncidents).set({ resolvedAt: startedAt }).where(eq(syncIncidents.id, openSkipped.id));
    }

    const summary: ReconcileSummary = {
      at: startedAt.toISOString(),
      ok: mismatches.length === 0 && skipped.length === 0,
      stagesChecked,
      checks: final.size,
      statuses: [...OPPORTUNITY_STATUSES],
      mismatches: mismatches.map((m) => ({ stageId: m.stageId, stageName: m.stageName, pipelineName: m.pipelineName, status: m.status, live: m.live, mirror: m.mirror })),
      skipped,
      refetchedStages: stagesToRefetch.size,
      requests,
    };
    await setSetting(RECONCILE_KEYS.lastAt, summary.at);
    await setSetting(RECONCILE_KEYS.summary, JSON.stringify(summary));
    const reason = skipped.length
      ? `${skipped.length} probe(s) returned no total — see the reconcile_skipped incident`
      : mismatches.length
        ? `${mismatches.length} check(s) still differ after re-fetching ${stagesToRefetch.size} stage(s)`
        : `mirror matches GHL: ${final.size} checks (${stagesChecked} stages × ${OPPORTUNITY_STATUSES.length} statuses + totals)${stagesToRefetch.size ? `, ${stagesToRefetch.size} stage(s) re-fetched first` : ''}`;
    await db
      .update(syncRuns)
      .set({ status: skipped.length ? 'failed' : 'succeeded', finishedAt: new Date(), requestsUsed: requests, stats: { stagesChecked, checks: final.size, mismatches: mismatches.length, skipped: skipped.length, refetchedStages: stagesToRefetch.size, reason }, warnings: skipped, error: skipped.length ? reason : null })
      .where(eq(syncRuns.id, run.id));
    return { ok: skipped.length === 0, runId: run.id, summary, error: skipped.length ? reason : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(syncRuns).set({ status: 'failed', finishedAt: new Date(), requestsUsed: requests, error: message, stats: { reason: message } }).where(eq(syncRuns.id, run.id));
    await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Reconcile failed: ${message}` });
    return { ok: false, runId: run.id, summary: null, error: message };
  } finally {
    await releaseLock(GHL_LOCK, holder).catch(() => {});
  }
}
