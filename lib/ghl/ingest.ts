/**
 * GoHighLevel → Postgres ingestion (READ-ONLY, idempotent) — Ingestion v2 (2026-09-30).
 *
 * F1 (2026-09-29 verification): the followed pipeline had not been read since Sep 18 while the banner said
 * fresh. The resumable cycle walked 15 pipelines before returning to it, and a legacy cursor skipped it outright
 * while the appointments block stamped it complete. v2, on EVERY run (`runGhlSync`):
 *
 *   ① TRACKED  pipelines + stages → EVERY page of the followed pipeline(s) (limit 100, startAfterId; the walk
 *              is complete only when it read GHL's meta.total) → contacts fetched only when new, when their
 *              opportunity changed (updatedAt), when we hold no ghl_opportunities row for it (so the first run
 *              after deploy re-reads everyone), or on a full/backfill run → positions + transitions
 *              (ON CONFLICT DO NOTHING) → ghl_opportunities → appointments (−14 d … +90 d).
 *              Markers `ghl.opportunities` / `ghl.appointments` are written HERE, after the fetch, with counts —
 *              nowhere else. A run out of budget writes no marker and re-reads from page 1 next time.
 *   ② MIRRORS  unfollowed pipelines, history only: one pass a week (settings.ghl_mirror_cursor), leftover budget
 *              only, never before ①. Marker `ghl.mirrors` when a pass completes.
 *
 * One run at a time (atomic lease, lib/syncLock.ts). Every upsert is keyed by the GHL id. Demo rows are never
 * touched. The pre-v2 cursor (settings.ghl_sync_cursor) is cleared by migration 0013 and never read.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  db,
  pipelines,
  stages,
  contacts,
  appointments,
  stageTransitions,
  syncRuns,
  syncIncidents,
  ghlOpportunities,
  type SemanticRole,
} from '@/db';
import { getDayBounds } from '../day';
import { getSetting, setSetting, getTimezone, SETTING_KEYS, BACKFILL_DEFAULTS } from '../settings';
import { getGhlConfig } from './config';
import {
  listPipelines,
  listOpportunitiesPage,
  listCalendars,
  listAppointments,
  getContact,
  listUsers,
} from './client';
import { suggestRole } from './roles';
import {
  deriveTransition,
  normalizeEmail,
  normalizePhone,
  outcomeFromGhlStatus,
  type DerivedTransition,
} from './transitions';
import type { GhlContact, GhlOpportunity } from './schemas';
import { captureException } from '../sentry';
import { sweepStaleRuns } from '../staleRuns';
import { acquireLock, releaseLock } from '../syncLock';
import { readMarker, writeMarker } from '../sync/markers';
import { runPaymentMatching } from '../stripe/matching';
import { classifyAttribution } from '../attribution/classify';
import { isDefaultFollowedPipeline } from './followed';
import { sweepIncidentNoise } from '../incidents/noise';

export type SyncMode = 'delta' | 'backfill';
export type SyncTrigger = 'cron' | 'manual' | 'cli';

export interface SyncStats {
  pipelines: number;
  stages: number;
  stagesUnmapped: number;
  opportunities: number;
  contactsFetched: number;
  contactsUpserted: number;
  transitions: number;
  calendars: number;
  appointmentsUpserted: number;
  rejectedRows: number;
  /** Stripe payments matched to contacts right after this sync (identity join). */
  paymentsMatched: number;
  /** Opportunity pages processed (resumable cycle bookkeeping). */
  pagesDone: number;
  /** Runs it took to complete the cycle (set on the run that finishes it). */
  cycleRuns: number;
  /** Which phase this run ended in (partial runs) — tracked | appointments | mirrors | done. */
  phase?: string;
  /** Why this run did not complete the cycle — "budget exhausted at pipeline X page Y" — or what it skipped. */
  reason?: string;
}

export type SyncPhase = 'tracked' | 'appointments' | 'mirrors';

export interface SyncResult {
  ok: boolean;
  /** True when the run stopped at its time budget; the cursor resumes next run. */
  partial: boolean;
  /** Human-readable progress ("paused at pipeline 3/15, page 2" / "completed …"). */
  progress: string | null;
  /** The followed pipeline(s) AND appointments were fully read in THIS run (their markers were written). */
  trackedComplete: boolean;
  /** Where the run ended: tracked | appointments (① incomplete) | mirrors (weekly pass continues) | done. */
  phase: SyncPhase | 'done';
  /** The weekly mirror pass cursor after this run (null when no pass is in progress). */
  cursor: MirrorCursor | null;
  runId: string;
  mode: SyncMode;
  since: Date | null;
  stats: SyncStats;
  warnings: string[];
  incidents: number;
  requestsUsed: number;
  error?: string;
  /** Set when the run did nothing because another GHL run is still in flight (runId = that run). */
  skipped?: string;
  durationMs: number;
}

const DELTA_LOOKBACK_DAYS = 14;
const LOOKAHEAD_DAYS = 90;

function emptyStats(): SyncStats {
  return {
    pipelines: 0,
    stages: 0,
    stagesUnmapped: 0,
    opportunities: 0,
    contactsFetched: 0,
    contactsUpserted: 0,
    transitions: 0,
    calendars: 0,
    appointmentsUpserted: 0,
    rejectedRows: 0,
    paymentsMatched: 0,
    pagesDone: 0,
    cycleRuns: 0,
  };
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferAppointmentType(calendarName: string, title: string): string {
  const s = `${calendarName} ${title}`.toLowerCase();
  if (s.includes('roadmap') || s.includes('strategy')) return 'Roadmap';
  if (s.includes('follow')) return 'Follow-Up';
  if (s.includes('check')) return 'Check-In';
  return 'Consult';
}

function splitName(contact: GhlContact | null, fallback: string): { first: string; last: string } {
  const first = contact?.firstName?.trim() ?? '';
  const last = contact?.lastName?.trim() ?? '';
  if (first || last) return { first, last };
  const combined = (contact?.name ?? contact?.contactName ?? fallback).trim();
  if (!combined) return { first: '', last: '' };
  const parts = combined.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// ---------------------------------------------------------------------------
// Pipelines & stages
// ---------------------------------------------------------------------------

export interface PipelineSyncOutcome {
  pipelines: number;
  stages: number;
  /** Unmapped stages in FOLLOWED pipelines only — the ones worth a human's attention. */
  unmapped: Array<{ stageId: string; stageName: string; pipelineId: string; pipelineName: string; suggested: SemanticRole; confidence: number }>;
  roleOf: Map<string, SemanticRole | null>;
  /** Followed (`is_tracked`) live GHL pipelines — the ones that drive metrics. */
  trackedPipelineIds: string[];
  warnings: string[];
  error?: string;
}

/**
 * Mirror pipelines + stages from GHL — ALL of them, followed or not (cheap,
 * keeps history). New stages get a role from the similarity mapper only when
 * it is confident; otherwise they are left `unmapped`. Only unmapped stages in
 * followed pipelines are returned for incidents — 107 stages of warnings for
 * pipelines nobody follows is noise. A role set by a human
 * (`role_source = 'manual'`) is never overwritten.
 */
export async function syncPipelines(options: { backfilled: boolean; now: Date }): Promise<PipelineSyncOutcome> {
  const out: PipelineSyncOutcome = {
    pipelines: 0,
    stages: 0,
    unmapped: [],
    roleOf: new Map(),
    trackedPipelineIds: [],
    warnings: [],
  };

  const res = await listPipelines();
  if (!res.ok || !res.data) {
    out.error = res.error ?? 'Could not read pipelines';
    return out;
  }

  const seenPipelineIds = new Set<string>();
  const seenStageIds = new Set<string>();

  for (const [pIndex, p] of res.data.pipelines.entries()) {
    seenPipelineIds.add(p.id);
    await db
      .insert(pipelines)
      .values({
        id: p.id,
        name: p.name || 'Untitled pipeline',
        locationId: p.locationId ?? null,
        position: pIndex,
        // Followed on first sight only for the hard-default funnel pipeline;
        // the conflict clause below never touches a stored (human) choice.
        isTracked: isDefaultFollowedPipeline(p.id),
        archivedAt: null,
        source: 'ghl',
        origin: 'ghl',
        syncedAt: options.now,
        backfilled: options.backfilled,
        updatedAt: options.now,
      })
      .onConflictDoUpdate({
        target: pipelines.id,
        set: {
          name: p.name || 'Untitled pipeline',
          locationId: p.locationId ?? null,
          position: pIndex,
          archivedAt: null,
          syncedAt: options.now,
          updatedAt: options.now,
        },
      });
    out.pipelines += 1;

    for (const [sIndex, s] of p.stages.entries()) {
      seenStageIds.add(s.id);
      const existing = await db
        .select({ roleSource: stages.roleSource, semanticRole: stages.semanticRole, name: stages.name })
        .from(stages)
        .where(eq(stages.id, s.id))
        .limit(1);

      const suggestion = suggestRole(s.name);
      const prior = existing[0];
      const keepManual = prior?.roleSource === 'manual';
      // Re-map automatically when the stage is new OR its name changed.
      const renamed = prior && prior.name !== s.name;
      const applyAuto = !keepManual && (!prior || renamed || prior.roleSource === 'unmapped');

      const semanticRole: SemanticRole | null = keepManual
        ? (prior.semanticRole ?? null)
        : applyAuto
          ? suggestion.confident
            ? suggestion.role
            : null
          : (prior?.semanticRole ?? null);
      const roleSource = keepManual
        ? 'manual'
        : semanticRole
          ? 'auto'
          : 'unmapped';

      await db
        .insert(stages)
        .values({
          id: s.id,
          pipelineId: p.id,
          name: s.name,
          position: s.position ?? sIndex,
          semanticRole,
          roleSource,
          roleConfidence: suggestion.confidence,
          suggestedRole: suggestion.role,
          archivedAt: null,
          source: 'ghl',
          origin: 'ghl',
          syncedAt: options.now,
          backfilled: options.backfilled,
          updatedAt: options.now,
        })
        .onConflictDoUpdate({
          target: stages.id,
          set: {
            pipelineId: p.id,
            name: s.name,
            position: s.position ?? sIndex,
            semanticRole,
            roleSource,
            roleConfidence: suggestion.confidence,
            suggestedRole: suggestion.role,
            archivedAt: null,
            syncedAt: options.now,
            updatedAt: options.now,
          },
        });

      out.stages += 1;
      out.roleOf.set(s.id, semanticRole);
      if (!semanticRole) {
        out.unmapped.push({
          stageId: s.id,
          stageName: s.name,
          pipelineId: p.id,
          pipelineName: p.name,
          suggested: suggestion.role,
          confidence: suggestion.confidence,
        });
      }
    }
  }

  // Anything we no longer see is archived, never deleted (history references it).
  const allGhlPipelines = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.origin, 'ghl'), isNull(pipelines.archivedAt)));
  for (const row of allGhlPipelines) {
    if (!seenPipelineIds.has(row.id)) {
      await db.update(pipelines).set({ archivedAt: options.now }).where(eq(pipelines.id, row.id));
      out.warnings.push(`Pipeline ${row.id} disappeared from GHL — archived locally.`);
    }
  }
  const allGhlStages = await db
    .select({ id: stages.id, name: stages.name })
    .from(stages)
    .where(and(eq(stages.origin, 'ghl'), isNull(stages.archivedAt)));
  for (const row of allGhlStages) {
    if (!seenStageIds.has(row.id)) {
      await db.update(stages).set({ archivedAt: options.now }).where(eq(stages.id, row.id));
      out.warnings.push(`Stage "${row.name}" disappeared from GHL — archived locally.`);
    }
  }

  const tracked = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.isTracked, true), eq(pipelines.origin, 'ghl'), isNull(pipelines.archivedAt)));
  out.trackedPipelineIds = tracked.map((t) => t.id);

  const followed = new Set(out.trackedPipelineIds);
  out.unmapped = out.unmapped.filter((u) => followed.has(u.pipelineId));

  return out;
}

// ---------------------------------------------------------------------------
// The sync — Ingestion v2 (2026-09-30): a TRACKED job every run, then a weekly MIRROR pass
// ---------------------------------------------------------------------------

/**
 * The weekly mirror pass's cursor (settings.ghl_mirror_cursor) — the only cursor v2 keeps. The followed pipeline
 * never needs one: it is walked completely on every run.
 */
export interface MirrorCursor {
  /** ISO — when this pass started. */
  passStartedAt: string;
  /** Unfollowed live pipeline ids, in position order. */
  order: string[];
  index: number;
  page: number;
  startAfterId: string | null;
  startAfter: number | null;
  /** Opportunities read so far in this pass. */
  fetched: number;
  runs: number;
}

/** Per-run time budget. Pro: every syncing route has maxDuration 300 s; a full followed-pipeline refresh
 *  (≈5 pages + up to ~400 contact GETs at GHL's 100 req / 10 s) takes ~45–60 s, so it always fits. */
export const DEFAULT_BUDGET_MS = 200_000;
/** Opportunities per page (GHL's maximum). */
export const PAGE_LIMIT = 100;
/** The mirrors (history only; nothing on screen reads them) are walked once a week, in slices. */
export const MIRROR_PASS_EVERY_MS = 7 * 86_400_000;
/** Do not start mirror pages with less than this left in the run's budget. */
export const MIN_MIRROR_SLICE_MS = 15_000;

export async function readMirrorCursor(): Promise<MirrorCursor | null> {
  const raw = await getSetting(SETTING_KEYS.ghlMirrorCursor);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as MirrorCursor;
    return c && Array.isArray(c.order) && typeof c.index === 'number' ? c : null;
  } catch {
    return null;
  }
}

async function writeMirrorCursor(cursor: MirrorCursor | null): Promise<void> {
  await setSetting(SETTING_KEYS.ghlMirrorCursor, cursor ? JSON.stringify(cursor) : '');
}

export async function runGhlSync(options: {
  mode: SyncMode;
  trigger: SyncTrigger;
  /** Backfill / manual: lower bound of the appointment window (ISO). */
  since?: string;
  /** Stop starting new pages after this much wall time (default DEFAULT_BUDGET_MS). */
  budgetMs?: number;
  /** Test hook: at most this many opportunity pages in one run. */
  maxPages?: number;
  /** Re-fetch every followed contact (backfill does too). */
  full?: boolean;
  /** Mirror pass: 'auto' (weekly, leftover budget), 'skip' ("Sync now"), 'force' (start/continue one now). */
  mirrors?: 'auto' | 'skip' | 'force';
}): Promise<SyncResult> {
  const startedAt = new Date();
  await sweepStaleRuns(startedAt);

  // ---- One GHL run at a time (F5, 2026-09-30: an ATOMIC lease, lib/syncLock.ts) -------------------------------
  // The Vercel crons, the GitHub fallback and "Sync now" can land together; two runs would walk the same pages and
  // diff the same contacts. The lease outlives the function's maxDuration, so a crashed holder frees it.
  const holder = `ghl:${options.trigger}:${startedAt.toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
  const lock = await acquireLock(GHL_LOCK, holder, GHL_LOCK_TTL_MS, startedAt);
  if (!lock.ok) {
    const skipped = `another GHL sync holds the lock until ${lock.until?.toISOString() ?? 'unknown'} — skipped`;
    return {
      ok: true, partial: false, progress: skipped, trackedComplete: false, phase: 'done', cursor: null,
      runId: '', mode: options.mode, since: null, stats: emptyStats(), warnings: [], incidents: 0,
      requestsUsed: 0, skipped, durationMs: Date.now() - startedAt.getTime(),
    };
  }
  try {
    return await runGhlSyncLocked(options, startedAt);
  } finally {
    await releaseLock(GHL_LOCK, holder).catch(() => {});
  }
}

/** The GHL lease name and its lifetime (> the 300 s maxDuration of every route that syncs). */
export const GHL_LOCK = 'ghl_sync';
export const GHL_LOCK_TTL_MS = 330_000;

async function runGhlSyncLocked(options: Parameters<typeof runGhlSync>[0], startedAt: Date): Promise<SyncResult> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const elapsed = () => Date.now() - startedAt.getTime();
  const stats = emptyStats();
  const warnings: string[] = [];
  let incidents = 0;
  let requestsUsed = 0;
  let pagesThisRun = 0;
  const outOfTime = () => elapsed() >= budgetMs;
  // maxPages (test hook) limits OPPORTUNITY pages only; appointments are stopped by the time budget alone.
  const outOfRoom = () => outOfTime() || (options.maxPages !== undefined && pagesThisRun >= options.maxPages);

  const mode: SyncMode = options.mode;
  const backfilled = mode === 'backfill';
  const full = backfilled || Boolean(options.full);
  const mirrorsMode = options.mirrors ?? (backfilled ? 'force' : 'auto');

  const [run] = await db
    .insert(syncRuns)
    .values({ kind: backfilled ? 'ghl_backfill' : 'ghl_delta', trigger: options.trigger, status: 'running', startedAt })
    .returning({ id: syncRuns.id });
  const runId = run.id;

  const raise = async (kind: string, severity: 'info' | 'warning' | 'critical', message: string, details?: Record<string, unknown>) => {
    incidents += 1;
    await db.insert(syncIncidents).values({ syncRunId: runId, kind, severity, message, details });
  };

  let trackedComplete = false;
  let mirrorCursor: MirrorCursor | null = null;
  const finish = async (status: 'succeeded' | 'partial' | 'failed', extra: { error?: string; progress: string; phase: SyncPhase | 'done' }): Promise<SyncResult> => {
    const finishedAt = new Date();
    const reported: SyncStats = { ...stats, phase: extra.phase };
    // Every row says what the run did or why it stopped — never an empty "partial".
    reported.reason = extra.error ? `failed: ${extra.error}` : extra.progress;
    await db
      .update(syncRuns)
      .set({ status, finishedAt, since: options.since ? toDate(options.since) : null, requestsUsed, stats: reported as unknown as Record<string, number>, warnings, error: extra.error ?? null })
      .where(eq(syncRuns.id, runId));
    return {
      ok: status !== 'failed',
      partial: status === 'partial',
      progress: extra.progress,
      trackedComplete,
      phase: extra.phase,
      cursor: mirrorCursor,
      runId,
      mode,
      since: options.since ? toDate(options.since) : null,
      stats: reported,
      warnings,
      incidents,
      requestsUsed,
      error: extra.error,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  };

  const config = await getGhlConfig();
  if (!config.configured) {
    await raise('error', 'warning', 'Sync skipped: no GoHighLevel credentials configured.');
    return finish('failed', { error: 'No GoHighLevel credentials configured.', progress: 'not started', phase: 'tracked' });
  }

  try {
    const timezone = await getTimezone(); // F8: throws when not configured → this run fails with the reason
    const userNames = new Map<string, string>();

    // ---- Users (id → name); cheap, every run ---------------------------------------------------------------------
    const usersRes = await listUsers();
    requestsUsed += 1;
    if (usersRes.ok && usersRes.data) {
      for (const u of usersRes.data.users) {
        const name = u.name ?? [u.firstName, u.lastName].filter(Boolean).join(' ') ?? u.email ?? u.id;
        userNames.set(u.id, name || u.id);
      }
    } else if (usersRes.error) {
      warnings.push(`Users: ${usersRes.error}`);
    }

    // ---- Pipelines & stages; every run (one request) --------------------------------------------------------------
    const pipelineSync = await syncPipelines({ backfilled, now: startedAt });
    requestsUsed += 1;
    if (pipelineSync.error) {
      await raise('error', 'critical', `Pipeline read failed: ${pipelineSync.error}`);
      return finish('failed', { error: pipelineSync.error, progress: 'at pipelines', phase: 'tracked' });
    }
    stats.pipelines = pipelineSync.pipelines;
    stats.stages = pipelineSync.stages;
    stats.stagesUnmapped = pipelineSync.unmapped.length;
    warnings.push(...pipelineSync.warnings);
    for (const u of pipelineSync.unmapped) {
      if (!(await hasIncidentForStage(u.stageId))) {
        await raise(
          'unmapped_stage',
          'warning',
          `Stage "${u.stageName}" in "${u.pipelineName}" has no semantic role. Suggested: ${u.suggested} (${Math.round(u.confidence * 100)}%). Confirm it in Setup.`,
          { stageId: u.stageId, stageName: u.stageName, suggested: u.suggested, confidence: u.confidence },
        );
      }
    }
    const roleOf = (stageId: string | null) => (stageId ? (pipelineSync.roleOf.get(stageId) ?? null) : null);
    const trackedPipelineIds = new Set(pipelineSync.trackedPipelineIds);
    try {
      await sweepIncidentNoise(startedAt);
    } catch (err) {
      warnings.push(`Incident sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const live = await db
      .select({ id: pipelines.id, name: pipelines.name, isTracked: pipelines.isTracked, position: pipelines.position })
      .from(pipelines)
      .where(and(eq(pipelines.origin, 'ghl'), isNull(pipelines.archivedAt)));
    const byPosition = [...live].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const followed = byPosition.filter((p) => trackedPipelineIds.has(p.id));
    const unfollowed = byPosition.filter((p) => !trackedPipelineIds.has(p.id));
    const nameOf = new Map(live.map((p) => [p.id, p.name]));

    const fetchedContacts = new Set<string>();
    // One page of one pipeline: read, process (contacts, positions, transitions, ghl_opportunities).
    const readPage = async (pipelineId: string, at: { page: number; startAfterId: string | null; startAfter: number | null }, tracked: boolean, previousSyncAt: Date | null) => {
      const pageRes = await listOpportunitiesPage({ pipelineId, page: at.page, startAfterId: at.startAfterId, startAfter: at.startAfter, limit: PAGE_LIMIT });
      requestsUsed += 1;
      pagesThisRun += 1;
      stats.rejectedRows += pageRes.rejected;
      warnings.push(...pageRes.warnings);
      if (pageRes.error) return { error: pageRes.error, pageRes };
      const processed = await processOpportunityPage({
        opportunities: pageRes.opportunities,
        pipelineTracked: tracked,
        trackedPipelineIds,
        previousSyncAt: backfilled ? null : previousSyncAt,
        backfilled,
        full,
        fetchedContacts,
        startedAt,
        runId,
        roleOf,
        userNames,
      });
      requestsUsed += processed.requests;
      stats.opportunities += pageRes.opportunities.length;
      stats.contactsFetched += processed.contactsFetched;
      stats.contactsUpserted += processed.contactsUpserted;
      stats.transitions += processed.transitions;
      stats.pagesDone += 1;
      warnings.push(...processed.warnings);
      return { error: null as string | null, pageRes };
    };

    // ================================================================================================================
    // ① TRACKED — the followed pipeline(s), completely, on EVERY run. What the dashboard shows is refreshed here.
    // ================================================================================================================
    const previousTracked = await readMarker('ghl.opportunities');
    const trackedPrevAt = previousTracked ? new Date(previousTracked.completedAt) : null;
    let trackedFetched = 0;
    let trackedLiveTotal: number | null = 0;
    for (const p of followed) {
      let at = { page: 1, startAfterId: null as string | null, startAfter: null as number | null };
      let pipelineFetched = 0;
      let pipelineTotal: number | null = null;
      for (;;) {
        if (outOfRoom()) {
          // No marker: the followed pipeline was NOT fully read this run. The next run walks it again from page 1.
          return finish('partial', { progress: `time budget reached in the followed pipeline "${p.name}" after ${pipelineFetched} opportunities — no freshness marker written; the next run re-reads it`, phase: 'tracked' });
        }
        const r = await readPage(p.id, at, true, trackedPrevAt);
        if (r.error) {
          await raise('error', 'critical', `Opportunity read failed (followed pipeline "${p.name}", page ${at.page}): ${r.error}`);
          return finish('failed', { error: r.error, progress: `at followed pipeline "${p.name}" page ${at.page}`, phase: 'tracked' });
        }
        if (pipelineTotal === null) pipelineTotal = r.pageRes.total;
        pipelineFetched += r.pageRes.opportunities.length + r.pageRes.rejected;
        if (r.pageRes.done || !r.pageRes.next.startAfterId && r.pageRes.opportunities.length === 0) break;
        at = { page: r.pageRes.next.page, startAfterId: r.pageRes.next.startAfterId, startAfter: r.pageRes.next.startAfter };
      }
      // A walk is complete only if it read what GHL says exists — otherwise the "fresh" marker would lie (F1).
      if (pipelineTotal !== null && pipelineFetched < pipelineTotal) {
        const msg = `Followed pipeline "${p.name}": read ${pipelineFetched} of ${pipelineTotal} opportunities GHL reports — pagination stopped early`;
        await raise('error', 'critical', msg, { pipelineId: p.id, fetched: pipelineFetched, liveTotal: pipelineTotal });
        return finish('failed', { error: msg, progress: msg, phase: 'tracked' });
      }
      trackedFetched += pipelineFetched;
      trackedLiveTotal = pipelineTotal === null || trackedLiveTotal === null ? null : trackedLiveTotal + pipelineTotal;
    }
    await writeMarker({
      family: 'ghl.opportunities',
      runId,
      fetched: trackedFetched,
      liveTotal: trackedLiveTotal,
      detail: `${followed.length} followed pipeline${followed.length === 1 ? '' : 's'} · ${trackedFetched} opportunities`,
    });
    if (!backfilled) await setSetting(SETTING_KEYS.ghlLastSyncAt, startedAt.toISOString());
    if (followed.length > 0 && trackedFetched === 0) {
      await raise('silence', 'warning', 'The followed pipeline returned zero opportunities.');
    }

    // ---- Appointments (every run) ----------------------------------------------------------------------------------
    if (outOfTime()) {
      return finish('partial', { progress: `followed pipeline refreshed (${trackedFetched} opportunities); time budget reached before appointments — no appointments marker written`, phase: 'appointments' });
    }
    const previousAppts = await readMarker('ghl.appointments');
    const appt = await syncAppointments(previousAppts ? new Date(previousAppts.completedAt) : null);
    if (appt.error) {
      await raise('error', 'critical', `Appointments read failed: ${appt.error}`);
      return finish('failed', { error: appt.error, progress: 'at appointments', phase: 'appointments' });
    }
    await writeMarker({ family: 'ghl.appointments', runId, fetched: appt.fetched, detail: `${appt.calendars} calendar${appt.calendars === 1 ? '' : 's'} · ${appt.fetched} events` });
    trackedComplete = true;

    // Contacts that arrived may be the identities unmatched Stripe payments were waiting for (manual matches kept).
    try {
      const matching = await runPaymentMatching();
      stats.paymentsMatched += matching.matched;
    } catch (err) {
      warnings.push(`Payment re-match after sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const trackedLine = `followed pipeline: ${trackedFetched} opportunities refreshed at ${new Date().toISOString()}; appointments: ${appt.fetched} events`;

    // ================================================================================================================
    // ② MIRRORS — unfollowed pipelines, history only: one pass a week, leftover budget only, never before ①.
    // ================================================================================================================
    mirrorCursor = await readMirrorCursor();
    const lastPass = await readMarker('ghl.mirrors');
    const passDue = !lastPass || Date.now() - Date.parse(lastPass.completedAt) >= MIRROR_PASS_EVERY_MS;
    if (mirrorsMode === 'skip' || unfollowed.length === 0) {
      return finish('succeeded', { progress: `${trackedLine}; mirrors: ${mirrorsMode === 'skip' ? 'skipped for this run' : 'none to mirror'}`, phase: 'done' });
    }
    if (!mirrorCursor && !(mirrorsMode === 'force' || passDue)) {
      return finish('succeeded', { progress: `${trackedLine}; mirrors: weekly pass not due (last completed ${lastPass?.completedAt})`, phase: 'done' });
    }
    if (!mirrorCursor) {
      mirrorCursor = { passStartedAt: startedAt.toISOString(), order: unfollowed.map((p) => p.id), index: 0, page: 1, startAfterId: null, startAfter: null, fetched: 0, runs: 0 };
    }
    mirrorCursor.runs += 1;
    const mirrorPrevAt = lastPass ? new Date(lastPass.completedAt) : null;
    const leftover = () => budgetMs - elapsed() >= MIN_MIRROR_SLICE_MS || options.maxPages !== undefined;
    while (mirrorCursor.index < mirrorCursor.order.length) {
      if (outOfRoom() || !leftover()) {
        await writeMirrorCursor(mirrorCursor);
        const where = `pipeline ${mirrorCursor.index + 1}/${mirrorCursor.order.length} "${nameOf.get(mirrorCursor.order[mirrorCursor.index]) ?? mirrorCursor.order[mirrorCursor.index]}", page ${mirrorCursor.page}`;
        return finish('succeeded', { progress: `${trackedLine}; mirrors: weekly pass paused at ${where} — continues next run`, phase: 'mirrors' });
      }
      const pid = mirrorCursor.order[mirrorCursor.index];
      if (trackedPipelineIds.has(pid)) {
        mirrorCursor.index += 1; // followed since the pass began — ① covers it
        continue;
      }
      const r = await readPage(pid, mirrorCursor, false, mirrorPrevAt);
      if (r.error) {
        await writeMirrorCursor(mirrorCursor); // retry this page next run
        warnings.push(`Mirror pipeline ${pid} page ${mirrorCursor.page}: ${r.error}`);
        return finish('succeeded', { progress: `${trackedLine}; mirrors: read failed at pipeline ${mirrorCursor.index + 1}/${mirrorCursor.order.length} — retried next run (${r.error})`, phase: 'mirrors' });
      }
      mirrorCursor.fetched += r.pageRes.opportunities.length;
      if (r.pageRes.done) {
        mirrorCursor = { ...mirrorCursor, index: mirrorCursor.index + 1, page: 1, startAfterId: null, startAfter: null };
      } else {
        mirrorCursor = { ...mirrorCursor, page: r.pageRes.next.page, startAfterId: r.pageRes.next.startAfterId, startAfter: r.pageRes.next.startAfter };
      }
      await writeMirrorCursor(mirrorCursor);
    }
    await writeMarker({ family: 'ghl.mirrors', runId, fetched: mirrorCursor.fetched, detail: `${mirrorCursor.order.length} unfollowed pipelines · ${mirrorCursor.fetched} opportunities in ${mirrorCursor.runs} run${mirrorCursor.runs === 1 ? '' : 's'}` });
    const passRuns = mirrorCursor.runs;
    await writeMirrorCursor(null);
    mirrorCursor = null;
    return finish('succeeded', { progress: `${trackedLine}; mirrors: weekly pass complete (${passRuns} run${passRuns === 1 ? '' : 's'})`, phase: 'done' });

    // The calendar events — one request per active calendar. Window: from the last completed appointments fetch
    // (never less than 14 days back; backfill / explicit since go further back) to 90 days ahead.
    async function syncAppointments(previousAt: Date | null): Promise<{ error?: string; fetched: number; calendars: number }> {
      const calendarsRes = await listCalendars();
      requestsUsed += 1;
      if (!calendarsRes.ok) return { error: `Calendars: ${calendarsRes.error}`, fetched: 0, calendars: 0 };
      const calendars = calendarsRes.data ? calendarsRes.data.calendars : [];
      stats.calendars = calendars.length;

      const followedRaw = await getSetting('ghl_followed_calendars');
      let followedCalendars: string[] = [];
      try {
        followedCalendars = followedRaw ? (JSON.parse(followedRaw) as string[]) : [];
      } catch {
        followedCalendars = [];
      }
      const activeCalendars = calendars.filter((c) => c.isActive !== false && (followedCalendars.length === 0 || followedCalendars.includes(c.id)));
      const lookback = startedAt.getTime() - DELTA_LOOKBACK_DAYS * 86_400_000;
      const explicit = options.since ? toDate(options.since) : null;
      const backfillFrom = backfilled ? new Date(getDayBounds((await getSetting(SETTING_KEYS.backfillFrom)) ?? BACKFILL_DEFAULTS.ghl, timezone).startMs) : null;
      const windowStartMs = Math.min(lookback, previousAt?.getTime() ?? lookback, explicit?.getTime() ?? lookback, backfillFrom?.getTime() ?? lookback);
      const windowEndMs = startedAt.getTime() + LOOKAHEAD_DAYS * 86_400_000;

      const events: Array<{ event: import('./schemas').GhlAppointment; calendarName: string }> = [];
      for (const cal of activeCalendars) {
        const res = await listAppointments({ startTimeMs: windowStartMs, endTimeMs: windowEndMs, calendarId: cal.id });
        requestsUsed += 1;
        stats.rejectedRows += res.rejected;
        warnings.push(...res.warnings);
        if (res.error) return { error: `Calendar "${cal.name}": ${res.error}`, fetched: 0, calendars: activeCalendars.length };
        for (const event of res.events) events.push({ event, calendarName: cal.name });
      }

      const eventContactIds = Array.from(new Set(events.map((e) => e.event.contactId)));
      const contactRows = eventContactIds.length
        ? await db.select({ id: contacts.id, ghlContactId: contacts.ghlContactId, ghlOpportunityId: contacts.ghlOpportunityId }).from(contacts).where(inArray(contacts.ghlContactId, eventContactIds))
        : [];
      const byGhl = new Map(contactRows.map((r) => [r.ghlContactId, r]));

      for (const { event, calendarName } of events) {
        const start = toDate(event.startTime);
        if (!start) {
          stats.rejectedRows += 1;
          continue;
        }
        const c = byGhl.get(event.contactId);
        const values = {
          ghlEventId: event.id,
          ghlCalendarId: event.calendarId,
          calendarName,
          ghlContactId: event.contactId,
          contactId: c?.id ?? null,
          ghlOpportunityId: c?.ghlOpportunityId ?? null,
          type: inferAppointmentType(calendarName, event.title ?? ''),
          title: event.title ?? null,
          startTime: start,
          endTime: toDate(event.endTime),
          timezone,
          assignedUserId: event.assignedUserId ?? null,
          assignedTo: event.assignedUserId ? (userNames.get(event.assignedUserId) ?? null) : null,
          ghlStatus: event.appointmentStatus ?? 'confirmed',
          outcome: outcomeFromGhlStatus(event.appointmentStatus),
          ghlCreatedAt: toDate(event.dateAdded),
          ghlUpdatedAt: toDate(event.dateUpdated),
          source: 'ghl',
          origin: 'ghl',
          syncedAt: startedAt,
          backfilled,
          updatedAt: startedAt,
        };
        await db.insert(appointments).values(values).onConflictDoUpdate({ target: appointments.ghlEventId, set: values });
        stats.appointmentsUpserted += 1;
      }
      if (events.length === 0 && activeCalendars.length > 0 && !backfilled) {
        await raise('silence', 'info', 'Sync window contained zero calendar events.');
      }
      return { fetched: events.length, calendars: activeCalendars.length };
    }
  } catch (err) {
    captureException(err, { source: 'ghl' });
    const message = err instanceof Error ? err.message : String(err);
    await raise('error', 'critical', `Sync crashed: ${message}`);
    return finish('failed', { error: message, progress: 'crashed', phase: trackedComplete ? 'mirrors' : 'tracked' });
  }
}

/**
 * One page of opportunities from ONE pipeline: fetch the contacts that are
 * new or changed since the cycle's lower bound, upsert them, derive stage
 * transitions. Position rules: an opportunity in a followed pipeline always
 * takes the contact's position; one in an unfollowed pipeline only when the
 * stored position is empty or itself unfollowed. Transitions are derived only
 * when the position is taken (the same one-opportunity-per-contact rule the
 * location-wide search used).
 */
async function processOpportunityPage(p: {
  opportunities: GhlOpportunity[];
  pipelineTracked: boolean;
  trackedPipelineIds: Set<string>;
  previousSyncAt: Date | null;
  backfilled: boolean;
  /** Re-fetch every contact on this page (backfill / --full). */
  full: boolean;
  /** Contacts already fetched in this run (a contact with several opportunities is fetched once). */
  fetchedContacts: Set<string>;
  startedAt: Date;
  runId: string;
  roleOf: (stageId: string | null) => SemanticRole | null;
  userNames: Map<string, string>;
}): Promise<{ requests: number; contactsFetched: number; contactsUpserted: number; transitions: number; warnings: string[] }> {
  const out = { requests: 0, contactsFetched: 0, contactsUpserted: 0, transitions: 0, warnings: [] as string[] };
  if (p.opportunities.length === 0) return out;

  // One opportunity per contact within the page (newest wins).
  const oppByContact = new Map<string, GhlOpportunity>();
  for (const opp of p.opportunities) {
    const prev = oppByContact.get(opp.contactId);
    if (!prev || (toDate(opp.updatedAt)?.getTime() ?? 0) > (toDate(prev.updatedAt)?.getTime() ?? 0)) oppByContact.set(opp.contactId, opp);
  }
  const ids = Array.from(oppByContact.keys());
  const existingRows = await db
    .select({ id: contacts.id, ghlContactId: contacts.ghlContactId, pipelineId: contacts.pipelineId, stageId: contacts.stageId, ghlUpdatedAt: contacts.ghlUpdatedAt })
    .from(contacts)
    .where(inArray(contacts.ghlContactId, ids));
  const existingByGhlId = new Map(existingRows.map((r) => [r.ghlContactId, r]));
  // What we stored for these opportunities last time: an opportunity we never stored, or one GHL updated since,
  // is what makes a contact worth re-fetching (v2 — replaces "changed since the last completed cycle").
  const storedOpps = await db
    .select({ id: ghlOpportunities.id, ghlUpdatedAt: ghlOpportunities.ghlUpdatedAt })
    .from(ghlOpportunities)
    .where(inArray(ghlOpportunities.id, p.opportunities.map((o) => o.id)));
  const storedOppById = new Map(storedOpps.map((o) => [o.id, o]));

  const transitions: DerivedTransition[] = [];
  for (const [ghlContactId, opp] of oppByContact) {
    const existing = existingByGhlId.get(ghlContactId);
    const oppUpdated = toDate(opp.updatedAt);
    const stored = storedOppById.get(opp.id);
    const changed = !stored || (oppUpdated !== null && (!stored.ghlUpdatedAt || oppUpdated > stored.ghlUpdatedAt));
    const needsFetch = !p.fetchedContacts.has(ghlContactId) && (p.full || !existing || changed);

    // Does this opportunity own the contact's position?
    const existingTracked = existing?.pipelineId ? p.trackedPipelineIds.has(existing.pipelineId) : false;
    const takesPosition = p.pipelineTracked ? true : !existing?.pipelineId || !existingTracked;
    if (!needsFetch && !takesPosition) continue;
    if (!needsFetch && existing && existing.pipelineId === opp.pipelineId && existing.stageId === opp.pipelineStageId) continue;

    let full: GhlContact | null = null;
    if (needsFetch) {
      const res = await getContact(ghlContactId);
      out.requests += 1;
      p.fetchedContacts.add(ghlContactId);
      if (res.ok && res.data) {
        full = res.data.contact;
        out.contactsFetched += 1;
      } else {
        out.warnings.push(`Contact ${ghlContactId}: ${res.error}`);
      }
    }

    const embedded = opp.contact ?? null;
    const { first, last } = splitName(full, embedded?.name ?? opp.name ?? '');
    const email = full?.email ?? embedded?.email ?? null;
    const phone = full?.phone ?? embedded?.phone ?? null;
    const firstTouch = full?.attributions?.find((a) => a.isFirst) ?? full?.attributions?.[0] ?? full?.attributionSource ?? null;
    const attribution = classifyAttribution({
      fbclid: firstTouch?.fbclid ?? null,
      gclid: firstTouch?.gclid ?? null,
      url: firstTouch?.url ?? null,
      utmSource: firstTouch?.utmSource ?? null,
      utmMedium: firstTouch?.utmMedium ?? firstTouch?.medium ?? null,
      source: full?.source ?? opp.source ?? null,
      sessionSource: firstTouch?.sessionSource ?? null,
    });
    const uid = opp.assignedTo ?? full?.assignedTo ?? null;

    const values = {
      ghlContactId,
      ghlOpportunityId: opp.id,
      pipelineId: opp.pipelineId,
      stageId: opp.pipelineStageId,
      opportunityStatus: opp.status,
      opportunityName: opp.name,
      monetaryValueCents: opp.monetaryValue != null ? Math.round(opp.monetaryValue * 100) : 0,
      lastStageChangeAt: toDate(opp.lastStageChangeAt),
      // When THIS application was made — only for a followed-pipeline position (F14 groundwork).
      opportunityCreatedAt: p.pipelineTracked ? toDate(opp.createdAt) : null,
      firstName: first,
      lastName: last,
      email,
      phone,
      emailNormalized: normalizeEmail(email),
      phoneNormalized: normalizePhone(phone),
      attributionSource: full?.source ?? opp.source ?? null,
      utmSource: firstTouch?.utmSource ?? null,
      utmMedium: firstTouch?.utmMedium ?? firstTouch?.medium ?? null,
      utmCampaign: firstTouch?.utmCampaign ?? null,
      utmContent: firstTouch?.utmContent ?? null,
      fbclid: firstTouch?.fbclid ?? null,
      gclid: firstTouch?.gclid ?? null,
      sessionSource: firstTouch?.sessionSource ?? null,
      attributionUrl: firstTouch?.url ?? null,
      attributionClass: attribution.attributionClass,
      attributionReason: attribution.reason,
      assignedUserId: uid,
      ownerName: uid ? (p.userNames.get(uid) ?? null) : null,
      tags: full?.tags ?? embedded?.tags ?? [],
      ghlCreatedAt: toDate(full?.dateAdded ?? opp.createdAt),
      ghlUpdatedAt: toDate(full?.dateUpdated ?? opp.updatedAt),
      source: 'ghl',
      origin: 'ghl',
      syncedAt: p.startedAt,
      backfilled: p.backfilled,
      updatedAt: p.startedAt,
    };

    // Without the full contact we have no new identity/attribution evidence.
    const partialSet = full
      ? values
      : {
          ...values,
          firstName: existing && !first ? undefined : values.firstName,
          lastName: existing && !last ? undefined : values.lastName,
          email: email ?? undefined,
          phone: phone ?? undefined,
          emailNormalized: values.emailNormalized ?? undefined,
          phoneNormalized: values.phoneNormalized ?? undefined,
          utmSource: undefined,
          utmMedium: undefined,
          utmCampaign: undefined,
          utmContent: undefined,
          fbclid: undefined,
          gclid: undefined,
          sessionSource: undefined,
          attributionUrl: undefined,
          attributionClass: undefined,
          attributionReason: undefined,
          ghlCreatedAt: values.ghlCreatedAt ?? undefined,
        };

    const positionSet = takesPosition
      ? { pipelineId: values.pipelineId, stageId: values.stageId, opportunityStatus: values.opportunityStatus, ghlOpportunityId: values.ghlOpportunityId, opportunityName: values.opportunityName, monetaryValueCents: values.monetaryValueCents, lastStageChangeAt: values.lastStageChangeAt, opportunityCreatedAt: values.opportunityCreatedAt }
      : { pipelineId: undefined, stageId: undefined, opportunityStatus: undefined, ghlOpportunityId: undefined, opportunityName: undefined, monetaryValueCents: undefined, lastStageChangeAt: undefined, opportunityCreatedAt: undefined };

    const [row] = await db
      .insert(contacts)
      .values(values)
      .onConflictDoUpdate({
        target: contacts.ghlContactId,
        set: {
          ...partialSet,
          ...positionSet,
          backfilled: p.backfilled,
          // A manual paid/organic override is never overwritten by sync.
          ...(full
            ? {
                attributionClass: sql`case when ${contacts.attributionClassSource} = 'manual' then ${contacts.attributionClass} else ${attribution.attributionClass} end`,
                attributionReason: sql`case when ${contacts.attributionClassSource} = 'manual' then ${contacts.attributionReason} else ${attribution.reason} end`,
              }
            : {}),
        },
      })
      .returning({ id: contacts.id });
    out.contactsUpserted += 1;

    if (takesPosition) {
      const t = deriveTransition(
        { ghlOpportunityId: opp.id, pipelineId: opp.pipelineId, stageId: opp.pipelineStageId, lastStageChangeAt: opp.lastStageChangeAt, createdAt: opp.createdAt },
        existing ? { contactId: existing.id, pipelineId: existing.pipelineId, stageId: existing.stageId } : null,
        row.id,
        p.roleOf,
        p.startedAt,
        p.previousSyncAt,
        p.backfilled,
      );
      if (t) transitions.push(t);
    }
  }

  // Every opportunity on the page, as GHL has it (not only the one that holds a position).
  const pageContactIds = Array.from(new Set(p.opportunities.map((o) => o.contactId)));
  const contactIdRows = pageContactIds.length
    ? await db.select({ id: contacts.id, ghlContactId: contacts.ghlContactId }).from(contacts).where(inArray(contacts.ghlContactId, pageContactIds))
    : [];
  const contactIdByGhl = new Map(contactIdRows.map((r) => [r.ghlContactId, r.id]));
  const oppRows = Array.from(new Map(p.opportunities.map((o) => [o.id, o])).values()).map((o) => ({
    id: o.id,
    ghlContactId: o.contactId,
    contactId: contactIdByGhl.get(o.contactId) ?? null,
    pipelineId: o.pipelineId,
    stageId: o.pipelineStageId,
    status: o.status,
    name: o.name,
    monetaryValueCents: o.monetaryValue != null ? Math.round(o.monetaryValue * 100) : 0,
    ghlCreatedAt: toDate(o.createdAt),
    ghlUpdatedAt: toDate(o.updatedAt),
    lastStageChangeAt: toDate(o.lastStageChangeAt),
    lastStatusChangeAt: toDate(o.lastStatusChangeAt),
    source: 'ghl',
    origin: 'ghl',
    syncedAt: p.startedAt,
    backfilled: p.backfilled,
    updatedAt: p.startedAt,
  }));
  if (oppRows.length > 0) {
    await db.insert(ghlOpportunities).values(oppRows).onConflictDoUpdate({
      target: ghlOpportunities.id,
      set: Object.fromEntries(
        (Object.keys(oppRows[0]) as Array<keyof (typeof oppRows)[number]>).filter((k) => k !== 'id').map((k) => [k, sql.raw(`excluded."${(ghlOpportunities as unknown as Record<string, { name: string }>)[k].name}"`)]),
      ),
    });
  }

  if (transitions.length > 0) {
    // F5: the natural-key unique index makes a re-observed move a no-op, never a duplicate row.
    const inserted = await db.insert(stageTransitions).values(
      transitions.map((t) => ({
        contactId: t.contactId,
        ghlOpportunityId: t.ghlOpportunityId,
        pipelineId: t.pipelineId,
        fromStageId: t.fromStageId,
        toStageId: t.toStageId,
        fromRole: t.fromRole,
        toRole: t.toRole,
        observedAt: t.observedAt,
        previousObservedAt: t.previousObservedAt,
        kind: t.kind,
        syncRunId: p.runId,
        source: 'ghl',
        origin: 'ghl',
        syncedAt: p.startedAt,
        backfilled: p.backfilled,
      })),
    ).onConflictDoNothing().returning({ id: stageTransitions.id });
    out.transitions = inserted.length;
  }
  return out;
}

/**
 * Re-process specific opportunities through the SAME path as the tracked job (contacts, positions, transitions,
 * ghl_opportunities) — the reconciler's targeted re-fetch (F7, 2026-09-30). The caller holds the GHL lease.
 */
export async function refreshOpportunities(opps: GhlOpportunity[], runId: string): Promise<{ contactsFetched: number; transitions: number; requests: number; warnings: string[] }> {
  const out = { contactsFetched: 0, transitions: 0, requests: 0, warnings: [] as string[] };
  if (opps.length === 0) return out;
  const startedAt = new Date();
  const stageRows = await db.select({ id: stages.id, role: stages.semanticRole }).from(stages);
  const roleMap = new Map(stageRows.map((r) => [r.id, r.role ?? null]));
  const roleOf = (id: string | null) => (id ? (roleMap.get(id) ?? null) : null);
  const tracked = await db.select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt)));
  const trackedPipelineIds = new Set(tracked.map((t) => t.id));
  const userNames = new Map<string, string>();
  const usersRes = await listUsers();
  out.requests += 1;
  if (usersRes.ok && usersRes.data) for (const u of usersRes.data.users) userNames.set(u.id, u.name ?? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.id));
  const previous = await readMarker('ghl.opportunities');
  const fetchedContacts = new Set<string>();
  for (const isTracked of [true, false]) {
    const group = opps.filter((o) => trackedPipelineIds.has(o.pipelineId) === isTracked);
    if (group.length === 0) continue;
    const r = await processOpportunityPage({
      opportunities: group,
      pipelineTracked: isTracked,
      trackedPipelineIds,
      previousSyncAt: previous ? new Date(previous.completedAt) : null,
      backfilled: false,
      full: false,
      fetchedContacts,
      startedAt,
      runId,
      roleOf,
      userNames,
    });
    out.contactsFetched += r.contactsFetched;
    out.transitions += r.transitions;
    out.requests += r.requests;
    out.warnings.push(...r.warnings);
  }
  return out;
}

async function hasIncidentForStage(stageId: string): Promise<boolean> {
  const rows = await db
    .select({ id: syncIncidents.id, details: syncIncidents.details })
    .from(syncIncidents)
    .where(and(eq(syncIncidents.kind, 'unmapped_stage'), isNull(syncIncidents.resolvedAt)));
  return rows.some((r) => r.details?.stageId === stageId);
}

/** Resolve open unmapped-stage incidents once a stage has a role. */
export async function resolveStageIncidents(stageId: string): Promise<void> {
  const rows = await db
    .select({ id: syncIncidents.id, details: syncIncidents.details })
    .from(syncIncidents)
    .where(and(eq(syncIncidents.kind, 'unmapped_stage'), isNull(syncIncidents.resolvedAt)));
  for (const r of rows) {
    if (r.details?.stageId === stageId) {
      await db.update(syncIncidents).set({ resolvedAt: new Date() }).where(eq(syncIncidents.id, r.id));
    }
  }
}
