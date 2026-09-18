/**
 * GoHighLevel → Postgres ingestion (READ-ONLY, idempotent, RESUMABLE).
 *
 * One entry point, `runGhlSync`, in two modes:
 *   delta     scheduled. Re-reads pipelines/stages, then every opportunity
 *             pipeline by pipeline (followed first), fetching contacts only
 *             when new or changed since the last completed cycle, then the
 *             calendar events. Stage moves are derived by diffing against
 *             stored positions.
 *   backfill  history import from `backfill_from`. Same code path; every row
 *             it touches is flagged backfilled=true.
 *
 * A sync is a CYCLE that may span several invocations: each run does what
 * fits in its time budget (Vercel Hobby kills a function at 60s; the daily
 * delta on 15 pipelines did not fit), persists a cursor
 * (settings.ghl_sync_cursor: pipeline index + page) after every processed
 * page, and exits cleanly as status 'partial'. The next invocation resumes at
 * the cursor; the run that finishes the cycle records 'succeeded' with the
 * cycle's totals and advances ghl_last_sync_at. No run is ever left 'running'.
 *
 * Every upsert is keyed by the GHL id, so re-running either mode is safe.
 * Demo rows (origin='demo') are never touched by a sync.
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
}

export interface SyncResult {
  ok: boolean;
  /** True when the run stopped at its time budget; the cursor resumes next run. */
  partial: boolean;
  /** Human-readable progress ("paused at pipeline 3/15, page 2" / "completed …"). */
  progress: string | null;
  cursor: SyncCursor | null;
  runId: string;
  mode: SyncMode;
  since: Date | null;
  stats: SyncStats;
  warnings: string[];
  incidents: number;
  requestsUsed: number;
  error?: string;
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
// The sync — chunked and resumable
// ---------------------------------------------------------------------------

/**
 * Where a sync CYCLE stopped. Persisted in settings.ghl_sync_cursor after
 * every processed opportunity page, cleared when the cycle completes. A cycle
 * is: phase 0 (pipelines/stages, users) → phase 1 (opportunities + contacts,
 * one pipeline at a time, followed pipelines first, untracked mirrors last)
 * → phase 2 (calendar events, payment re-match, bookkeeping).
 */
export interface SyncCursor {
  mode: SyncMode;
  /** ISO — becomes the next delta's `since` once the cycle completes. */
  cycleStartedAt: string;
  /** ISO lower bound used for "changed since" throughout the cycle (null = everything). */
  since: string | null;
  /** Pipeline ids in processing order: followed first, then the rest. */
  order: string[];
  index: number;
  page: number;
  startAfterId: string | null;
  startAfter: number | null;
  /** Stats accumulated across the cycle's runs so far. */
  stats: SyncStats;
  warnings: string[];
  runs: number;
  timezone: string;
}

/** Default time budget per invocation: Vercel Hobby kills at 60s; one page of contact fetches can add ~10s. */
export const DEFAULT_BUDGET_MS = 40_000;
/** Opportunities per page — small so a page (with its contact fetches) fits the budget. */
export const PAGE_LIMIT = 50;

export async function readSyncCursor(): Promise<SyncCursor | null> {
  const raw = await getSetting(SETTING_KEYS.ghlSyncCursor);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as SyncCursor;
    return c && Array.isArray(c.order) && typeof c.index === 'number' ? c : null;
  } catch {
    return null;
  }
}

async function writeSyncCursor(cursor: SyncCursor | null): Promise<void> {
  await setSetting(SETTING_KEYS.ghlSyncCursor, cursor ? JSON.stringify(cursor) : '');
}

function addStats(into: SyncStats, from: SyncStats): SyncStats {
  const out = { ...into };
  for (const k of Object.keys(from) as Array<keyof SyncStats>) out[k] = (out[k] ?? 0) + (from[k] ?? 0);
  return out;
}

export async function runGhlSync(options: {
  mode: SyncMode;
  trigger: SyncTrigger;
  /** Override the delta lower bound / backfill start (ISO). Starts a fresh cycle. */
  since?: string;
  /** Stop starting new pages after this much wall time; the cursor resumes next run. */
  budgetMs?: number;
  /** Test hook: at most this many opportunity pages in one run. */
  maxPages?: number;
}): Promise<SyncResult> {
  const startedAt = new Date();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const overBudget = () => Date.now() - startedAt.getTime() >= budgetMs;
  const stats = emptyStats();
  const warnings: string[] = [];
  let incidents = 0;
  let requestsUsed = 0;

  await sweepStaleRuns(startedAt);

  const config = await getGhlConfig();

  // ---- Resume or start a cycle ------------------------------------------
  const existing = options.since ? null : await readSyncCursor();
  const resuming = Boolean(existing);
  const mode: SyncMode = existing?.mode ?? options.mode;
  const backfilled = mode === 'backfill';

  const [run] = await db
    .insert(syncRuns)
    .values({ kind: backfilled ? 'ghl_backfill' : 'ghl_delta', trigger: options.trigger, status: 'running', startedAt })
    .returning({ id: syncRuns.id });
  const runId = run.id;

  const raise = async (kind: string, severity: 'info' | 'warning' | 'critical', message: string, details?: Record<string, unknown>) => {
    incidents += 1;
    await db.insert(syncIncidents).values({ syncRunId: runId, kind, severity, message, details });
  };

  const finish = async (status: 'succeeded' | 'partial' | 'failed', since: Date | null, extra: { error?: string; cycleStats?: SyncStats; progress?: string; cursor?: SyncCursor | null } = {}): Promise<SyncResult> => {
    const finishedAt = new Date();
    const reported = extra.cycleStats ?? stats;
    await db
      .update(syncRuns)
      .set({ status, finishedAt, since, requestsUsed, stats: reported as unknown as Record<string, number>, warnings, error: extra.error ?? null })
      .where(eq(syncRuns.id, runId));
    return {
      ok: status !== 'failed',
      partial: status === 'partial',
      progress: extra.progress ?? null,
      cursor: extra.cursor ?? null,
      runId,
      mode,
      since,
      stats: reported,
      warnings,
      incidents,
      requestsUsed,
      error: extra.error,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  };

  if (!config.configured) {
    await raise('error', 'warning', 'Sync skipped: no GoHighLevel credentials configured.');
    return finish('failed', null, { error: 'No GoHighLevel credentials configured.' });
  }

  const timezone = existing?.timezone ?? (await getTimezone());
  let cursor: SyncCursor;
  let roleOf: (stageId: string | null) => SemanticRole | null;
  let trackedPipelineIds: Set<string>;
  const userNames = new Map<string, string>();

  try {
    // ---- Users (id → name); cheap, every run -------------------------
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

    if (existing) {
      cursor = existing;
      warnings.push(`Resuming ${mode} cycle started ${cursor.cycleStartedAt}: pipeline ${cursor.index + 1}/${cursor.order.length}, page ${cursor.page}.`);
      // Roles / followed set from the DB (phase 0 already ran this cycle).
      const stageRows = await db.select({ id: stages.id, role: stages.semanticRole }).from(stages);
      const roleMap = new Map(stageRows.map((r) => [r.id, r.role ?? null]));
      roleOf = (id) => (id ? (roleMap.get(id) ?? null) : null);
      const tracked = await db.select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt)));
      trackedPipelineIds = new Set(tracked.map((t) => t.id));
    } else {
      // ---- Phase 0: pipelines & stages, window, order -------------------
      let since: Date | null;
      if (options.since) since = toDate(options.since);
      else if (backfilled) since = new Date(getDayBounds((await getSetting(SETTING_KEYS.backfillFrom)) ?? BACKFILL_DEFAULTS.ghl, timezone).startMs);
      else since = toDate(await getSetting(SETTING_KEYS.ghlLastSyncAt));

      const pipelineSync = await syncPipelines({ backfilled, now: startedAt });
      requestsUsed += 1;
      if (pipelineSync.error) {
        await raise('error', 'critical', `Pipeline read failed: ${pipelineSync.error}`);
        return finish('failed', since, { error: pipelineSync.error });
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
      roleOf = (stageId) => (stageId ? (pipelineSync.roleOf.get(stageId) ?? null) : null);
      trackedPipelineIds = new Set(pipelineSync.trackedPipelineIds);
      // Stages mapped / unfollowed since last time no longer deserve an open incident.
      try {
        await sweepIncidentNoise(startedAt);
      } catch (err) {
        warnings.push(`Incident sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Followed pipelines first (they drive dashboards), untracked mirrors last.
      const live = await db
        .select({ id: pipelines.id, isTracked: pipelines.isTracked, position: pipelines.position })
        .from(pipelines)
        .where(and(eq(pipelines.origin, 'ghl'), isNull(pipelines.archivedAt)));
      const order = [...live]
        .sort((a, b) => Number(b.isTracked) - Number(a.isTracked) || (a.position ?? 0) - (b.position ?? 0))
        .map((p) => p.id);

      cursor = {
        mode,
        cycleStartedAt: startedAt.toISOString(),
        since: since?.toISOString() ?? null,
        order,
        index: 0,
        page: 1,
        startAfterId: null,
        startAfter: null,
        stats: emptyStats(),
        warnings: [],
        runs: 0,
        timezone,
      };
      await writeSyncCursor(cursor);
    }

    const since = cursor.since ? new Date(cursor.since) : null;
    const previousSyncAt = backfilled ? null : since;
    cursor.runs += 1;
    let pagesThisRun = 0;

    // ---- Phase 1: opportunities + contacts, one page at a time ----------
    while (cursor.index < cursor.order.length) {
      if (overBudget() || (options.maxPages !== undefined && pagesThisRun >= options.maxPages)) {
        const merged = addStats(cursor.stats, stats);
        cursor.stats = merged;
        cursor.warnings = [...cursor.warnings, ...warnings].slice(-50);
        await writeSyncCursor(cursor);
        const progress = `paused at pipeline ${cursor.index + 1}/${cursor.order.length}, page ${cursor.page}`;
        warnings.push(`Time budget reached — ${progress}. The next run continues from here.`);
        return finish('partial', since, { progress, cursor });
      }

      const pipelineId = cursor.order[cursor.index];
      const pageRes = await listOpportunitiesPage({ pipelineId, page: cursor.page, startAfterId: cursor.startAfterId, startAfter: cursor.startAfter, limit: PAGE_LIMIT });
      requestsUsed += 1;
      pagesThisRun += 1;
      stats.rejectedRows += pageRes.rejected;
      warnings.push(...pageRes.warnings);
      if (pageRes.error) {
        await raise('error', 'critical', `Opportunity read failed (pipeline ${pipelineId}, page ${cursor.page}): ${pageRes.error}`);
        cursor.stats = addStats(cursor.stats, stats);
        await writeSyncCursor(cursor); // resume at the same page next time
        return finish('failed', since, { error: pageRes.error, cursor });
      }

      const processed = await processOpportunityPage({
        opportunities: pageRes.opportunities,
        pipelineTracked: trackedPipelineIds.has(pipelineId),
        trackedPipelineIds,
        since,
        previousSyncAt,
        backfilled,
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

      // Advance the cursor and persist it — this page is done for good.
      if (pageRes.done) {
        cursor.index += 1;
        cursor.page = 1;
        cursor.startAfterId = null;
        cursor.startAfter = null;
      } else {
        cursor.page = pageRes.next.page;
        cursor.startAfterId = pageRes.next.startAfterId;
        cursor.startAfter = pageRes.next.startAfter;
      }
      await writeSyncCursor(cursor);
    }

    // ---- Phase 2: calendar events, re-match, bookkeeping ----------------
    const cycleStats = addStats(cursor.stats, stats);

    const calendarsRes = await listCalendars();
    requestsUsed += 1;
    const calendars = calendarsRes.ok && calendarsRes.data ? calendarsRes.data.calendars : [];
    if (!calendarsRes.ok) warnings.push(`Calendars: ${calendarsRes.error}`);
    cycleStats.calendars = calendars.length;

    const followedRaw = await getSetting('ghl_followed_calendars');
    let followedCalendars: string[] = [];
    try {
      followedCalendars = followedRaw ? (JSON.parse(followedRaw) as string[]) : [];
    } catch {
      followedCalendars = [];
    }
    const activeCalendars = calendars.filter((c) => c.isActive !== false && (followedCalendars.length === 0 || followedCalendars.includes(c.id)));
    const cycleStart = new Date(cursor.cycleStartedAt);
    const windowStartMs = backfilled ? (since ?? cycleStart).getTime() : Math.min((since ?? cycleStart).getTime(), cycleStart.getTime() - DELTA_LOOKBACK_DAYS * 86_400_000);
    const windowEndMs = cycleStart.getTime() + LOOKAHEAD_DAYS * 86_400_000;

    const events: Array<{ event: import('./schemas').GhlAppointment; calendarName: string }> = [];
    for (const cal of activeCalendars) {
      const res = await listAppointments({ startTimeMs: windowStartMs, endTimeMs: windowEndMs, calendarId: cal.id });
      requestsUsed += 1;
      cycleStats.rejectedRows += res.rejected;
      warnings.push(...res.warnings);
      if (res.error) {
        warnings.push(`Calendar "${cal.name}": ${res.error}`);
        continue;
      }
      for (const event of res.events) events.push({ event, calendarName: cal.name });
    }

    // Contact ids for the events' people, whatever run of the cycle imported them.
    const eventContactIds = Array.from(new Set(events.map((e) => e.event.contactId)));
    const contactRows = eventContactIds.length
      ? await db.select({ id: contacts.id, ghlContactId: contacts.ghlContactId, ghlOpportunityId: contacts.ghlOpportunityId }).from(contacts).where(inArray(contacts.ghlContactId, eventContactIds))
      : [];
    const byGhl = new Map(contactRows.map((r) => [r.ghlContactId, r]));

    for (const { event, calendarName } of events) {
      const start = toDate(event.startTime);
      if (!start) {
        cycleStats.rejectedRows += 1;
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
      cycleStats.appointmentsUpserted += 1;
    }
    if (events.length === 0 && activeCalendars.length > 0 && !backfilled) {
      await raise('silence', 'info', 'Sync window contained zero calendar events.');
    }
    if (cycleStats.opportunities === 0 && cycleStats.pipelines > 0) {
      await raise('silence', 'warning', 'Sync cycle returned zero opportunities across all pipelines.');
    }

    // Contacts that arrived this cycle may be the identities unmatched Stripe
    // payments were waiting for (and a Stripe reconcile may have landed
    // payments since the last cycle). Cheap and idempotent, so every completed
    // cycle re-matches; manual matches are never overwritten.
    try {
      const matching = await runPaymentMatching();
      cycleStats.paymentsMatched = matching.matched;
    } catch (err) {
      warnings.push(`Payment re-match after sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    cycleStats.cycleRuns = cursor.runs;
    if (!backfilled) await setSetting(SETTING_KEYS.ghlLastSyncAt, cursor.cycleStartedAt);
    await writeSyncCursor(null);
    warnings.unshift(...cursor.warnings);
    return finish('succeeded', since, { cycleStats, progress: `completed ${cursor.order.length} pipelines in ${cursor.runs} run${cursor.runs === 1 ? '' : 's'}` });
  } catch (err) {
    captureException(err, { source: 'ghl' });
    const message = err instanceof Error ? err.message : String(err);
    await raise('error', 'critical', `Sync crashed: ${message}`);
    // The cursor (last completed page) stays put, so the next run resumes.
    return finish('failed', null, { error: message });
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
  since: Date | null;
  previousSyncAt: Date | null;
  backfilled: boolean;
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

  const transitions: DerivedTransition[] = [];
  for (const [ghlContactId, opp] of oppByContact) {
    const existing = existingByGhlId.get(ghlContactId);
    const oppUpdated = toDate(opp.updatedAt);
    const needsFetch = p.backfilled || !existing || !p.since || (oppUpdated !== null && oppUpdated > p.since);

    // Does this opportunity own the contact's position?
    const existingTracked = existing?.pipelineId ? p.trackedPipelineIds.has(existing.pipelineId) : false;
    const takesPosition = p.pipelineTracked ? true : !existing?.pipelineId || !existingTracked;
    if (!needsFetch && !takesPosition) continue;
    if (!needsFetch && existing && existing.pipelineId === opp.pipelineId && existing.stageId === opp.pipelineStageId) continue;

    let full: GhlContact | null = null;
    if (needsFetch) {
      const res = await getContact(ghlContactId);
      out.requests += 1;
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
      ? { pipelineId: values.pipelineId, stageId: values.stageId, opportunityStatus: values.opportunityStatus, ghlOpportunityId: values.ghlOpportunityId, opportunityName: values.opportunityName, monetaryValueCents: values.monetaryValueCents, lastStageChangeAt: values.lastStageChangeAt }
      : { pipelineId: undefined, stageId: undefined, opportunityStatus: undefined, ghlOpportunityId: undefined, opportunityName: undefined, monetaryValueCents: undefined, lastStageChangeAt: undefined };

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

  if (transitions.length > 0) {
    await db.insert(stageTransitions).values(
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
    );
  }
  out.transitions = transitions.length;
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
