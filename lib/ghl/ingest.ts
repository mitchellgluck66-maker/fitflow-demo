/**
 * GoHighLevel → Postgres ingestion (READ-ONLY, idempotent).
 *
 * One entry point, `runGhlSync`, in two modes:
 *   delta     hourly cron. Re-reads pipelines/stages, every opportunity in the
 *             tracked pipelines (bulk paged — a handful of requests), and the
 *             calendar events in a trailing/leading window. Contacts are only
 *             fetched individually when they are new or changed since the last
 *             run. Stage moves are derived by diffing against stored positions.
 *   backfill  one-off history import from `backfill_from` (June 16, 2026).
 *             Same code path; every row it touches is flagged backfilled=true.
 *
 * Every upsert is keyed by the GHL id, so re-running either mode is safe.
 * Demo rows (origin='demo') are never touched by a sync.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
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
import { getSetting, setSetting, getTimezone, SETTING_KEYS } from '../settings';
import { getGhlConfig } from './config';
import {
  listPipelines,
  listAllOpportunities,
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
}

export interface SyncResult {
  ok: boolean;
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
  unmapped: Array<{ stageId: string; stageName: string; pipelineName: string; suggested: SemanticRole; confidence: number }>;
  roleOf: Map<string, SemanticRole | null>;
  trackedPipelineIds: string[];
  warnings: string[];
  error?: string;
}

/**
 * Mirror pipelines + stages from GHL. New stages get a role from the
 * similarity mapper only when it is confident; otherwise they are left
 * `unmapped` and returned so the caller can raise an incident. A role set by a
 * human (`role_source = 'manual'`) is never overwritten.
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

  return out;
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

export async function runGhlSync(options: {
  mode: SyncMode;
  trigger: SyncTrigger;
  /** Override the delta lower bound / backfill start (ISO). */
  since?: string;
}): Promise<SyncResult> {
  const startedAt = new Date();
  const stats = emptyStats();
  const warnings: string[] = [];
  let incidents = 0;

  await sweepStaleRuns(startedAt);

  const [run] = await db
    .insert(syncRuns)
    .values({
      kind: options.mode === 'backfill' ? 'ghl_backfill' : 'ghl_delta',
      trigger: options.trigger,
      status: 'running',
      startedAt,
    })
    .returning({ id: syncRuns.id });
  const runId = run.id;

  const raise = async (
    kind: string,
    severity: 'info' | 'warning' | 'critical',
    message: string,
    details?: Record<string, unknown>,
  ) => {
    incidents += 1;
    await db.insert(syncIncidents).values({ syncRunId: runId, kind, severity, message, details });
  };

  const finish = async (ok: boolean, since: Date | null, error?: string): Promise<SyncResult> => {
    const finishedAt = new Date();
    await db
      .update(syncRuns)
      .set({
        status: ok ? 'succeeded' : 'failed',
        finishedAt,
        since,
        requestsUsed,
        stats: stats as unknown as Record<string, number>,
        warnings,
        error: error ?? null,
      })
      .where(eq(syncRuns.id, runId));
    return {
      ok,
      runId,
      mode: options.mode,
      since,
      stats,
      warnings,
      incidents,
      requestsUsed,
      error,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  };

  let requestsUsed = 0;
  const backfilled = options.mode === 'backfill';

  const config = await getGhlConfig();
  if (!config.configured) {
    await raise('error', 'warning', 'Sync skipped: no GoHighLevel credentials configured.');
    return finish(false, null, 'No GoHighLevel credentials configured.');
  }

  const timezone = await getTimezone();

  // ---- Window -----------------------------------------------------------
  let since: Date | null;
  if (options.since) {
    since = toDate(options.since);
  } else if (backfilled) {
    const from = (await getSetting(SETTING_KEYS.backfillFrom)) ?? '2026-06-16';
    since = new Date(getDayBounds(from, timezone).startMs);
  } else {
    since = toDate(await getSetting(SETTING_KEYS.ghlLastSyncAt));
  }

  try {
    // ---- 1. Pipelines & stages ----------------------------------------
    const pipelineSync = await syncPipelines({ backfilled, now: startedAt });
    requestsUsed += 1;
    if (pipelineSync.error) {
      await raise('error', 'critical', `Pipeline read failed: ${pipelineSync.error}`);
      return finish(false, since, pipelineSync.error);
    }
    stats.pipelines = pipelineSync.pipelines;
    stats.stages = pipelineSync.stages;
    stats.stagesUnmapped = pipelineSync.unmapped.length;
    warnings.push(...pipelineSync.warnings);

    for (const u of pipelineSync.unmapped) {
      // One open incident per unmapped stage, not one per hourly run.
      const open = await db
        .select({ id: syncIncidents.id })
        .from(syncIncidents)
        .where(and(eq(syncIncidents.kind, 'unmapped_stage'), isNull(syncIncidents.resolvedAt)));
      const already = open.length > 0 && (await hasIncidentForStage(u.stageId));
      if (!already) {
        await raise(
          'unmapped_stage',
          'warning',
          `Stage "${u.stageName}" in "${u.pipelineName}" has no semantic role. Suggested: ${u.suggested} (${Math.round(u.confidence * 100)}%). Confirm it in Setup.`,
          { stageId: u.stageId, stageName: u.stageName, suggested: u.suggested, confidence: u.confidence },
        );
      }
    }

    const roleOf = (stageId: string | null): SemanticRole | null =>
      stageId ? (pipelineSync.roleOf.get(stageId) ?? null) : null;

    // ---- 2. Users (id → name) -----------------------------------------
    const userNames = new Map<string, string>();
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

    // ---- 3. Opportunities (bulk per tracked pipeline) -----------------
    const opportunities: GhlOpportunity[] = [];
    for (const pipelineId of pipelineSync.trackedPipelineIds) {
      const page = await listAllOpportunities({ pipelineId });
      requestsUsed += page.requests;
      stats.rejectedRows += page.rejected;
      warnings.push(...page.warnings);
      if (page.error) {
        await raise('error', 'critical', `Opportunity read failed for pipeline ${pipelineId}: ${page.error}`);
        return finish(false, since, page.error);
      }
      opportunities.push(...page.opportunities);
    }
    stats.opportunities = opportunities.length;

    if (opportunities.length === 0 && pipelineSync.trackedPipelineIds.length > 0) {
      await raise('silence', 'warning', 'Sync returned zero opportunities across tracked pipelines.');
    }

    // One opportunity per contact for the contact's current position: prefer
    // the most recently updated one. Every opportunity still gets its
    // transition history recorded.
    const oppByContact = new Map<string, GhlOpportunity>();
    for (const opp of opportunities) {
      const prev = oppByContact.get(opp.contactId);
      if (!prev || (toDate(opp.updatedAt)?.getTime() ?? 0) > (toDate(prev.updatedAt)?.getTime() ?? 0)) {
        oppByContact.set(opp.contactId, opp);
      }
    }

    // ---- 4. Calendars & appointments -----------------------------------
    const calendarsRes = await listCalendars();
    requestsUsed += 1;
    const calendars = calendarsRes.ok && calendarsRes.data ? calendarsRes.data.calendars : [];
    if (!calendarsRes.ok) warnings.push(`Calendars: ${calendarsRes.error}`);
    stats.calendars = calendars.length;

    const followedRaw = await getSetting('ghl_followed_calendars');
    let followed: string[] = [];
    try {
      followed = followedRaw ? (JSON.parse(followedRaw) as string[]) : [];
    } catch {
      followed = [];
    }
    const activeCalendars = calendars.filter(
      (c) => c.isActive !== false && (followed.length === 0 || followed.includes(c.id)),
    );

    const windowStartMs = backfilled
      ? (since ?? startedAt).getTime()
      : Math.min(
          (since ?? startedAt).getTime(),
          startedAt.getTime() - DELTA_LOOKBACK_DAYS * 86_400_000,
        );
    const windowEndMs = startedAt.getTime() + LOOKAHEAD_DAYS * 86_400_000;

    const events: Array<{ event: import('./schemas').GhlAppointment; calendarName: string }> = [];
    for (const cal of activeCalendars) {
      const res = await listAppointments({
        startTimeMs: windowStartMs,
        endTimeMs: windowEndMs,
        calendarId: cal.id,
      });
      requestsUsed += 1;
      stats.rejectedRows += res.rejected;
      warnings.push(...res.warnings);
      if (res.error) {
        warnings.push(`Calendar "${cal.name}": ${res.error}`);
        continue;
      }
      for (const event of res.events) events.push({ event, calendarName: cal.name });
    }

    // ---- 5. Contacts -----------------------------------------------------
    // Which contacts need a full fetch? Backfill: all of them. Delta: new
    // contacts, contacts whose opportunity changed since `since`, and contacts
    // on appointments we have not seen before.
    const contactIds = new Set<string>();
    for (const opp of opportunities) contactIds.add(opp.contactId);
    for (const { event } of events) contactIds.add(event.contactId);

    const existingRows = contactIds.size
      ? await db
          .select({
            id: contacts.id,
            ghlContactId: contacts.ghlContactId,
            pipelineId: contacts.pipelineId,
            stageId: contacts.stageId,
            ghlUpdatedAt: contacts.ghlUpdatedAt,
          })
          .from(contacts)
          .where(inArray(contacts.ghlContactId, Array.from(contactIds)))
      : [];
    const existingByGhlId = new Map(existingRows.map((r) => [r.ghlContactId, r]));

    const toFetch = new Set<string>();
    for (const id of contactIds) {
      const existing = existingByGhlId.get(id);
      if (backfilled || !existing) {
        toFetch.add(id);
        continue;
      }
      const opp = oppByContact.get(id);
      const oppUpdated = toDate(opp?.updatedAt);
      if (oppUpdated && (!since || oppUpdated > since)) toFetch.add(id);
    }

    const fetched = new Map<string, GhlContact>();
    for (const id of toFetch) {
      const res = await getContact(id);
      requestsUsed += 1;
      if (res.ok && res.data) {
        fetched.set(id, res.data.contact);
      } else {
        warnings.push(`Contact ${id}: ${res.error}`);
      }
    }
    stats.contactsFetched = fetched.size;

    // ---- 6. Upsert contacts + derive transitions -----------------------
    const previousSyncAt = backfilled ? null : since;
    const transitions: DerivedTransition[] = [];
    const contactDbId = new Map<string, string>();

    for (const ghlContactId of contactIds) {
      const opp = oppByContact.get(ghlContactId);
      const full = fetched.get(ghlContactId) ?? null;
      const embedded = opp?.contact ?? null;
      const existing = existingByGhlId.get(ghlContactId);

      // Skip contacts we know nothing new about (delta, unchanged, no fetch).
      if (existing && !full && !opp) {
        contactDbId.set(ghlContactId, existing.id);
        continue;
      }

      const { first, last } = splitName(full, embedded?.name ?? opp?.name ?? '');
      const email = full?.email ?? embedded?.email ?? null;
      const phone = full?.phone ?? embedded?.phone ?? null;
      const firstTouch =
        full?.attributions?.find((a) => a.isFirst) ?? full?.attributions?.[0] ?? full?.attributionSource ?? null;

      const values = {
        ghlContactId,
        ghlOpportunityId: opp?.id ?? null,
        pipelineId: opp?.pipelineId ?? null,
        stageId: opp?.pipelineStageId ?? null,
        opportunityStatus: opp?.status ?? null,
        opportunityName: opp?.name ?? null,
        monetaryValueCents: opp?.monetaryValue != null ? Math.round(opp.monetaryValue * 100) : 0,
        lastStageChangeAt: toDate(opp?.lastStageChangeAt),
        firstName: first,
        lastName: last,
        email,
        phone,
        emailNormalized: normalizeEmail(email),
        phoneNormalized: normalizePhone(phone),
        attributionSource: full?.source ?? opp?.source ?? null,
        utmSource: firstTouch?.utmSource ?? null,
        utmMedium: firstTouch?.utmMedium ?? firstTouch?.medium ?? null,
        utmCampaign: firstTouch?.utmCampaign ?? null,
        utmContent: firstTouch?.utmContent ?? null,
        assignedUserId: opp?.assignedTo ?? full?.assignedTo ?? null,
        ownerName: (() => {
          const uid = opp?.assignedTo ?? full?.assignedTo ?? null;
          return uid ? (userNames.get(uid) ?? null) : null;
        })(),
        tags: full?.tags ?? embedded?.tags ?? [],
        ghlCreatedAt: toDate(full?.dateAdded ?? opp?.createdAt),
        ghlUpdatedAt: toDate(full?.dateUpdated ?? opp?.updatedAt),
        source: 'ghl',
        origin: 'ghl',
        syncedAt: startedAt,
        backfilled,
        updatedAt: startedAt,
      };

      // Existing rows keep their identity fields when we only have the
      // embedded (partial) contact this run.
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
            ghlCreatedAt: values.ghlCreatedAt ?? undefined,
          };

      const [row] = await db
        .insert(contacts)
        .values(values)
        .onConflictDoUpdate({
          target: contacts.ghlContactId,
          set: {
            ...partialSet,
            // Never regress a stored position to null just because this run's
            // opportunity list did not include the contact.
            pipelineId: opp ? values.pipelineId : undefined,
            stageId: opp ? values.stageId : undefined,
            opportunityStatus: opp ? values.opportunityStatus : undefined,
            ghlOpportunityId: opp ? values.ghlOpportunityId : undefined,
            // backfilled stays true only if it was set by a backfill; a delta
            // update on a backfilled row is still a live observation.
            backfilled,
          },
        })
        .returning({ id: contacts.id });
      contactDbId.set(ghlContactId, row.id);
      stats.contactsUpserted += 1;

      if (opp) {
        const t = deriveTransition(
          {
            ghlOpportunityId: opp.id,
            pipelineId: opp.pipelineId,
            stageId: opp.pipelineStageId,
            lastStageChangeAt: opp.lastStageChangeAt,
            createdAt: opp.createdAt,
          },
          existing ? { contactId: existing.id, pipelineId: existing.pipelineId, stageId: existing.stageId } : null,
          row.id,
          roleOf,
          startedAt,
          previousSyncAt,
          backfilled,
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
          syncRunId: runId,
          source: 'ghl',
          origin: 'ghl',
          syncedAt: startedAt,
          backfilled,
        })),
      );
    }
    stats.transitions = transitions.length;

    // ---- 7. Upsert appointments ----------------------------------------
    for (const { event, calendarName } of events) {
      const start = toDate(event.startTime);
      if (!start) {
        stats.rejectedRows += 1;
        continue;
      }
      const opp = oppByContact.get(event.contactId);
      const values = {
        ghlEventId: event.id,
        ghlCalendarId: event.calendarId,
        calendarName,
        ghlContactId: event.contactId,
        contactId: contactDbId.get(event.contactId) ?? null,
        ghlOpportunityId: opp?.id ?? null,
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
      await db
        .insert(appointments)
        .values(values)
        .onConflictDoUpdate({ target: appointments.ghlEventId, set: values });
      stats.appointmentsUpserted += 1;
    }

    if (events.length === 0 && activeCalendars.length > 0 && !backfilled) {
      await raise('silence', 'info', 'Sync window contained zero calendar events.');
    }

    // ---- 8. Re-match Stripe payments -----------------------------------
    // Contacts that just arrived may be the identities 'unmatched' Stripe
    // payments were waiting for (first real run: 0/324 matched because no
    // contacts existed yet). Re-match now instead of waiting for the next
    // Stripe reconcile. Manual matches are never overwritten.
    if (stats.contactsUpserted > 0) {
      try {
        const matching = await runPaymentMatching();
        stats.paymentsMatched = matching.matched;
      } catch (err) {
        warnings.push(`Payment re-match after sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ---- 9. Done ---------------------------------------------------------
    if (!backfilled) {
      await setSetting(SETTING_KEYS.ghlLastSyncAt, startedAt.toISOString());
    }
    return finish(true, since);
  } catch (err) {
    captureException(err, { source: 'ghl' });
    const message = err instanceof Error ? err.message : String(err);
    await raise('error', 'critical', `Sync crashed: ${message}`);
    return finish(false, since, message);
  }
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
