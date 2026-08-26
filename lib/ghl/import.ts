/**
 * Import real data from GoHighLevel into local tables.
 *
 * This is the read path. The sync engine (sync.ts) is the write path; together
 * they make the app a two-way mirror of the client's real account rather than a
 * standalone database with invented contents.
 *
 * Rate-limit strategy: GHL allows 100 requests per 10 seconds. A naive import
 * would fetch one contact and run one opportunity search per appointment, which
 * for 300 appointments is 600+ calls and an immediate 429. Instead we:
 *   - fetch calendar events per calendar (one call each)
 *   - page through ALL opportunities in the pipeline (3-4 calls total)
 *   - fetch each unique contact once, deduplicated across appointments
 * A month of appointments typically lands under 60 requests.
 */

import { db, leads, appointments, leadEvents } from '@/db';
import { eq, and, inArray } from 'drizzle-orm';
import {
  listAppointments,
  listAllOpportunities,
  getContact,
  listUsers,
} from './client';
import { getGhlConfig } from './config';
import { getSetting, SETTING_KEYS, getTimezone } from '../settings';
import { getDayBounds } from '../day';
import { inferAppointmentType } from './discover';
import type { GhlAppointment, GhlOpportunity } from './types';

export interface ImportOptions {
  /** Calendars to pull from. Empty means all discovered calendars. */
  calendarIds: string[];
  pipelineId?: string;
  /** YYYY-MM-DD inclusive. */
  startDate: string;
  endDate: string;
  /** Remove fabricated sample rows before importing. */
  clearDemoData?: boolean;
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  counts: {
    eventsFound: number;
    contactsFetched: number;
    opportunitiesIndexed: number;
    leadsCreated: number;
    leadsUpdated: number;
    appointmentsCreated: number;
    appointmentsUpdated: number;
    demoRowsRemoved: number;
    skipped: number;
  };
  warnings: string[];
  requestsUsed: number;
}

/**
 * Reverse-map a GHL appointment status onto our outcome vocabulary.
 *
 * This is genuinely lossy and the app should not pretend otherwise. GHL's
 * `showed` means "they turned up" - it cannot distinguish "booked the next
 * step" from "attended but is not continuing", because that distinction only
 * exists in this app. So we infer it from the opportunity's status, and only
 * when that status is unambiguous:
 *
 *   showed + opportunity lost/abandoned  -> not_continuing
 *   showed + opportunity won             -> booked
 *   showed + opportunity open            -> null (unknown; staff can mark it)
 *
 * Leaving it null is the honest answer. Guessing "booked" would inflate the
 * rebook rate with data GHL never actually contained.
 */
function deriveOutcome(
  status: string | undefined,
  opportunity: GhlOpportunity | undefined,
): { outcome: string | null; inferred: boolean } {
  if (status === 'noshow') return { outcome: 'no_show', inferred: false };

  if (status === 'showed') {
    const oppStatus = opportunity?.status;
    if (oppStatus === 'lost' || oppStatus === 'abandoned') {
      return { outcome: 'not_continuing', inferred: true };
    }
    if (oppStatus === 'won') return { outcome: 'booked', inferred: true };
    return { outcome: null, inferred: false };
  }

  return { outcome: null, inferred: false };
}

/** Map a GHL pipeline stage id back to our local stage name. */
function localStageFor(
  stageId: string | undefined,
  stageMap: Record<string, string>,
): string | null {
  if (!stageId) return null;
  for (const [localStage, id] of Object.entries(stageMap)) {
    if (id === stageId) return localStage;
  }
  return null;
}

function fullName(contact: Record<string, unknown>): {
  first: string;
  last: string;
} {
  const first = String(contact.firstName ?? '').trim();
  const last = String(contact.lastName ?? '').trim();

  if (first || last) return { first: first || '—', last };

  const combined = String(contact.name ?? contact.contactName ?? '').trim();
  if (combined) {
    const parts = combined.split(/\s+/);
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  return { first: 'Unknown', last: '' };
}

export async function importFromGhl(options: ImportOptions): Promise<ImportResult> {
  const config = await getGhlConfig();
  const timezone = await getTimezone();
  const now = new Date().toISOString();

  const result: ImportResult = {
    ok: false,
    dryRun: config.dryRun,
    counts: {
      eventsFound: 0,
      contactsFetched: 0,
      opportunitiesIndexed: 0,
      leadsCreated: 0,
      leadsUpdated: 0,
      appointmentsCreated: 0,
      appointmentsUpdated: 0,
      demoRowsRemoved: 0,
      skipped: 0,
    },
    warnings: [],
    requestsUsed: 0,
  };

  if (!config.configured) {
    result.error =
      'No GoHighLevel credentials. Add GHL_API_TOKEN and GHL_LOCATION_ID to .env.local.';
    return result;
  }

  if (config.dryRun) {
    result.error =
      'Import needs live API access. Set GHL_DRY_RUN=false in .env.local and restart. (Dry run only gates writes, but reading real data still requires it off, so you never import against a half-configured setup.)';
    return result;
  }

  // ---- 1. Calendar events -------------------------------------------------
  const { startMs } = getDayBounds(options.startDate, timezone);
  const { endMs } = getDayBounds(options.endDate, timezone);

  const calendarMapRaw = await getSetting(SETTING_KEYS.ghlCalendarMap);
  let calendarTypeMap: Record<string, string> = {};
  try {
    calendarTypeMap = calendarMapRaw ? JSON.parse(calendarMapRaw) : {};
  } catch {
    calendarTypeMap = {};
  }

  const events: GhlAppointment[] = [];

  for (const calendarId of options.calendarIds) {
    const res = await listAppointments({
      startTimeMs: startMs,
      endTimeMs: endMs,
      calendarId,
    });
    result.requestsUsed += 1;

    if (!res.ok) {
      result.warnings.push(`Calendar ${calendarId}: ${res.error}`);
      continue;
    }

    events.push(...(res.data?.events ?? []));
  }

  result.counts.eventsFound = events.length;

  if (events.length === 0) {
    result.ok = true;
    result.warnings.push(
      'No appointments found in that date range. Check the calendar selection and dates.',
    );
    return result;
  }

  // ---- 2. Opportunities (bulk, indexed by contact) -----------------------
  const stageMapRaw = await getSetting(SETTING_KEYS.ghlStageMap);
  let stageMap: Record<string, string> = {};
  try {
    stageMap = stageMapRaw ? JSON.parse(stageMapRaw) : {};
  } catch {
    stageMap = {};
  }

  const pipelineId = options.pipelineId ?? (await getSetting(SETTING_KEYS.ghlPipelineId)) ?? undefined;

  const oppResult = await listAllOpportunities(pipelineId);
  result.requestsUsed += Math.ceil(oppResult.opportunities.length / 100) || 1;

  if (oppResult.error) {
    result.warnings.push(`Opportunities: ${oppResult.error}`);
  }

  const oppByContact = new Map<string, GhlOpportunity>();
  for (const opp of oppResult.opportunities) {
    if (opp.contactId && !oppByContact.has(opp.contactId)) {
      oppByContact.set(opp.contactId, opp);
    }
  }
  result.counts.opportunitiesIndexed = oppByContact.size;

  // ---- 3. Users (for owner names) ----------------------------------------
  const usersRes = await listUsers();
  result.requestsUsed += 1;
  const userNames = new Map<string, string>();
  if (usersRes.ok) {
    for (const u of usersRes.data?.users ?? []) {
      userNames.set(u.id, u.name ?? u.email ?? u.id);
    }
  }

  // ---- 4. Contacts (deduplicated) ----------------------------------------
  const contactIds = Array.from(
    new Set(events.map((e) => e.contactId).filter(Boolean)),
  );

  const contacts = new Map<string, Record<string, unknown>>();
  for (const contactId of contactIds) {
    const res = await getContact(contactId);
    result.requestsUsed += 1;

    if (!res.ok) {
      result.warnings.push(`Contact ${contactId}: ${res.error}`);
      continue;
    }

    const contact = res.data?.contact ?? (res.data as Record<string, unknown>);
    if (contact) contacts.set(contactId, contact);
  }
  result.counts.contactsFetched = contacts.size;

  // ---- 5. Clear demo rows ------------------------------------------------
  if (options.clearDemoData) {
    const demoLeads = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.origin, 'demo'));

    if (demoLeads.length > 0) {
      const ids = demoLeads.map((l) => l.id);
      // Events and appointments cascade from leads, but delete explicitly so
      // the count reported back to the user is accurate.
      await db.delete(leadEvents).where(inArray(leadEvents.leadId, ids));
      await db.delete(appointments).where(inArray(appointments.leadId, ids));
      await db.delete(leads).where(eq(leads.origin, 'demo'));
    }

    await db.delete(appointments).where(eq(appointments.origin, 'demo'));
    result.counts.demoRowsRemoved = demoLeads.length;
  }

  // ---- 6. Upsert leads ---------------------------------------------------
  const leadIdByContact = new Map<string, string>();

  for (const [contactId, contact] of contacts) {
    const opp = oppByContact.get(contactId);
    const { first, last } = fullName(contact);
    const email = String(contact.email ?? '').trim() || `${contactId}@no-email.local`;

    const mappedStage = localStageFor(opp?.pipelineStageId, stageMap);
    const stage = mappedStage ?? 'Applied';

    if (!mappedStage && opp?.pipelineStageId) {
      result.warnings.push(
        `Stage ${opp.pipelineStageId} is not in your stage map — lead placed in "Applied". Re-run setup to map it.`,
      );
    }

    const existing = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.ghlContactId, contactId))
      .limit(1);

    const values = {
      firstName: first,
      lastName: last,
      email,
      phone: String(contact.phone ?? '') || null,
      stage,
      // GHL's own `source` field. Attribution proper is not exposed for reading
      // in a documented way, so we take what is available rather than guessing.
      source: String(contact.source ?? '') || null,
      ghlSource: String(contact.source ?? '') || null,
      estimatedValue: opp?.monetaryValue != null ? opp.monetaryValue * 100 : 0,
      owner: opp?.assignedTo ? (userNames.get(opp.assignedTo) ?? null) : null,
      origin: 'ghl' as const,
      ghlContactId: contactId,
      ghlOpportunityId: opp?.id ?? null,
      ghlPipelineId: opp?.pipelineId ?? null,
      ghlStageId: opp?.pipelineStageId ?? null,
      lastImportedAt: now,
      updatedAt: now,
    };

    if (existing.length > 0) {
      await db.update(leads).set(values).where(eq(leads.id, existing[0].id));
      leadIdByContact.set(contactId, existing[0].id);
      result.counts.leadsUpdated += 1;
    } else {
      const [created] = await db
        .insert(leads)
        .values({ ...values, createdAt: now })
        .returning({ id: leads.id });

      leadIdByContact.set(contactId, created.id);
      result.counts.leadsCreated += 1;
    }
  }

  // ---- 7. Upsert appointments -------------------------------------------
  let inferredOutcomes = 0;

  for (const event of events) {
    const leadId = leadIdByContact.get(event.contactId);
    if (!leadId) {
      result.counts.skipped += 1;
      continue;
    }

    const opp = oppByContact.get(event.contactId);
    const { outcome, inferred } = deriveOutcome(event.appointmentStatus, opp);
    if (inferred) inferredOutcomes += 1;

    const type =
      calendarTypeMap[event.calendarId] ??
      inferAppointmentType(event.title ?? '') ??
      'Consult';

    const existing = await db
      .select({ id: appointments.id, outcome: appointments.outcome })
      .from(appointments)
      .where(eq(appointments.ghlEventId, event.id))
      .limit(1);

    const values = {
      leadId,
      ghlEventId: event.id,
      ghlCalendarId: event.calendarId,
      ghlContactId: event.contactId,
      ghlOpportunityId: opp?.id ?? null,
      type,
      title: event.title ?? null,
      startTime: event.startTime,
      endTime: event.endTime ?? null,
      timezone,
      assignedTo: event.assignedUserId
        ? (userNames.get(event.assignedUserId) ?? null)
        : null,
      ghlAssignedUserId: event.assignedUserId ?? null,
      ghlAppointmentStatus: event.appointmentStatus ?? 'confirmed',
      origin: 'ghl' as const,
      lastImportedAt: now,
      updatedAt: now,
    };

    if (existing.length > 0) {
      // Never overwrite an outcome a human already recorded here - local marks
      // are the source of truth for this app's own vocabulary.
      const preserveOutcome = existing[0].outcome !== null;

      await db
        .update(appointments)
        .set(preserveOutcome ? values : { ...values, outcome })
        .where(eq(appointments.id, existing[0].id));

      result.counts.appointmentsUpdated += 1;
    } else {
      await db.insert(appointments).values({
        ...values,
        outcome,
        outcomeMarkedAt: outcome ? now : null,
        outcomeMarkedBy: outcome ? 'imported from GoHighLevel' : null,
        syncStatus: outcome ? 'synced' : 'pending',
        syncedAt: outcome ? now : null,
        createdAt: now,
      });

      result.counts.appointmentsCreated += 1;
    }
  }

  if (inferredOutcomes > 0) {
    result.warnings.push(
      `${inferredOutcomes} outcome${inferredOutcomes === 1 ? ' was' : 's were'} inferred from opportunity status. GoHighLevel records "showed" without saying whether the next step was booked, so these are a best guess — appointments where it was genuinely ambiguous were left unmarked.`,
    );
  }

  await setLastImport(now);

  result.ok = true;
  return result;
}

async function setLastImport(timestamp: string): Promise<void> {
  const { setSetting } = await import('../settings');
  await setSetting('last_import_at', timestamp);
}

/** Remove every fabricated row, leaving only real imported/manual data. */
export async function clearDemoData(): Promise<{
  leadsRemoved: number;
  appointmentsRemoved: number;
  eventsRemoved: number;
}> {
  const demoLeads = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.origin, 'demo'));

  const ids = demoLeads.map((l) => l.id);

  let eventsRemoved = 0;
  let appointmentsRemoved = 0;

  if (ids.length > 0) {
    const demoEvents = await db
      .select({ id: leadEvents.id })
      .from(leadEvents)
      .where(inArray(leadEvents.leadId, ids));
    eventsRemoved = demoEvents.length;

    const demoAppts = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(inArray(appointments.leadId, ids));
    appointmentsRemoved = demoAppts.length;

    await db.delete(leadEvents).where(inArray(leadEvents.leadId, ids));
    await db.delete(appointments).where(inArray(appointments.leadId, ids));
    await db.delete(leads).where(eq(leads.origin, 'demo'));
  }

  // Sweep any orphaned demo appointments not caught by the lead join.
  await db.delete(appointments).where(eq(appointments.origin, 'demo'));

  return {
    leadsRemoved: ids.length,
    appointmentsRemoved,
    eventsRemoved,
  };
}

/** How much of the local database is fabricated vs real. */
export async function getDataProvenance(): Promise<{
  demoLeads: number;
  ghlLeads: number;
  manualLeads: number;
  demoAppointments: number;
  ghlAppointments: number;
  hasDemoData: boolean;
  hasRealData: boolean;
  lastImportAt: string | null;
}> {
  const allLeads = await db.select({ origin: leads.origin }).from(leads);
  const allAppts = await db.select({ origin: appointments.origin }).from(appointments);

  const countLeads = (o: string) => allLeads.filter((l) => l.origin === o).length;
  const countAppts = (o: string) => allAppts.filter((a) => a.origin === o).length;

  const demoLeads = countLeads('demo');
  const ghlLeads = countLeads('ghl');
  const manualLeads = countLeads('manual');

  return {
    demoLeads,
    ghlLeads,
    manualLeads,
    demoAppointments: countAppts('demo'),
    ghlAppointments: countAppts('ghl'),
    hasDemoData: demoLeads > 0 || countAppts('demo') > 0,
    hasRealData: ghlLeads > 0 || manualLeads > 0,
    lastImportAt: await getSetting('last_import_at'),
  };
}
