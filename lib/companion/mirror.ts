/**
 * Companion stage 1 — the database side: the mirror's appointments for a user and a day (the fallback), the contact
 * lookup for enrichment, and the live-contact reader. The only file under lib/companion that touches the DB.
 */

import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { db, appointments, contacts, stages, pipelines, ghlOpportunities } from '@/db';
import { readMarker } from '../sync/markers';
import { getContact } from '../ghl/client';
import { callTypeOf, calendarLabel, inCalendarFilter } from './calendars';
import type { MirrorReader, MirrorResult } from './source';
import type { LiveContact, MirrorContact } from './enrich';
import type { BriefContact, SearchRow } from './brief';

/** The synced `appointments` rows assigned to the user inside the window (any origin — the demo tenant is a tenant). */
export const readMirrorDay: MirrorReader = async ({ ghlUserId, startMs, endMs, calendarFilter }): Promise<MirrorResult> => {
  const rows = await db
    .select({
      eventId: appointments.ghlEventId,
      calendarId: appointments.ghlCalendarId,
      calendarName: appointments.calendarName,
      title: appointments.title,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      ghlContactId: appointments.ghlContactId,
      ghlStatus: appointments.ghlStatus,
      syncedAt: appointments.syncedAt,
    })
    .from(appointments)
    .where(and(eq(appointments.assignedUserId, ghlUserId), gte(appointments.startTime, new Date(startMs)), lte(appointments.startTime, new Date(endMs))))
    .orderBy(asc(appointments.startTime));
  const kept = rows.filter((r) => inCalendarFilter(r.calendarId ?? '', calendarFilter));
  const marker = await readMarker('ghl.appointments');
  const newest = rows.reduce<Date | null>((m, r) => (!m || r.syncedAt > m ? r.syncedAt : m), null);
  return {
    rows: kept
      .filter((r) => r.ghlContactId)
      .map((r) => ({
        eventId: r.eventId,
        calendarId: r.calendarId ?? '',
        calendarName: calendarLabel(r.calendarName, r.calendarId ?? ''),
        callType: callTypeOf(r.calendarName, r.title),
        title: r.title,
        startIso: r.startTime.toISOString(),
        endIso: r.endTime?.toISOString() ?? null,
        ghlContactId: r.ghlContactId!,
        ghlStatus: r.ghlStatus,
      })),
    asOf: marker?.completedAt ?? newest?.toISOString() ?? null,
  };
};

/** Name, email, phone, stage and pipeline for a set of GHL contact ids — one query. */
export async function lookupMirrorContacts(ghlContactIds: string[]): Promise<Map<string, MirrorContact>> {
  if (ghlContactIds.length === 0) return new Map();
  const rows = await db
    .select({
      ghlContactId: contacts.ghlContactId,
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      stageName: stages.name,
      stageRole: stages.semanticRole,
      pipelineName: pipelines.name,
    })
    .from(contacts)
    .leftJoin(stages, eq(contacts.stageId, stages.id))
    .leftJoin(pipelines, eq(contacts.pipelineId, pipelines.id))
    .where(inArray(contacts.ghlContactId, ghlContactIds));
  const out = new Map<string, MirrorContact>();
  for (const r of rows) {
    const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
    out.set(r.ghlContactId, {
      contactId: r.contactId,
      name: name || (r.email ?? `Contact ${r.ghlContactId.slice(0, 6)}…`),
      email: r.email,
      phone: r.phone,
      stage: r.stageName ? { name: r.stageName, role: r.stageRole ?? null, pipeline: r.pipelineName ?? null } : null,
    });
  }
  return out;
}

/** A contact the mirror has not synced yet — one read-only GET; null when GHL cannot answer. */
export async function readLiveContact(ghlContactId: string): Promise<LiveContact | null> {
  const res = await getContact(ghlContactId);
  if (!res.ok || !res.data) return null;
  const c = res.data.contact;
  const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || (c.name ?? c.contactName ?? '').trim();
  return { name: name || `Contact ${ghlContactId.slice(0, 6)}…`, email: c.email ?? null, phone: c.phone ?? null };
}

/** Distinct calendars the mirror has seen for this user (the settings page's fallback list). */
export async function mirrorCalendarsFor(ghlUserId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: appointments.ghlCalendarId, name: sql<string>`max(${appointments.calendarName})` })
    .from(appointments)
    .where(eq(appointments.assignedUserId, ghlUserId))
    .groupBy(appointments.ghlCalendarId);
  return rows.filter((r) => r.id).map((r) => ({ id: r.id!, name: calendarLabel(r.name, r.id!) }));
}

/** The brief's view of one mirrored contact: identity, stage, pipeline and the dates that anchor "days in pipeline". */
export async function readBriefContact(ghlContactId: string): Promise<BriefContact | null> {
  const rows = await db
    .select({
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      stageName: stages.name,
      stageRole: stages.semanticRole,
      pipelineName: pipelines.name,
      opportunityCreatedAt: contacts.opportunityCreatedAt,
      ghlCreatedAt: contacts.ghlCreatedAt,
    })
    .from(contacts)
    .leftJoin(stages, eq(contacts.stageId, stages.id))
    .leftJoin(pipelines, eq(contacts.pipelineId, pipelines.id))
    .where(eq(contacts.ghlContactId, ghlContactId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  // The earliest FOLLOWED-pipeline opportunity for this person — the application date (F14).
  const opp = await db
    .select({ createdAt: ghlOpportunities.ghlCreatedAt })
    .from(ghlOpportunities)
    .innerJoin(pipelines, eq(ghlOpportunities.pipelineId, pipelines.id))
    .where(and(eq(ghlOpportunities.ghlContactId, ghlContactId), eq(pipelines.isTracked, true)))
    .orderBy(asc(ghlOpportunities.ghlCreatedAt))
    .limit(1);
  const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
  return {
    ghlContactId,
    contactId: r.contactId,
    name: name || (r.email ?? `Contact ${ghlContactId.slice(0, 6)}…`),
    email: r.email,
    phone: r.phone,
    stage: r.stageName ? { name: r.stageName, role: r.stageRole ?? null, pipeline: r.pipelineName ?? null } : null,
    opportunityCreatedAt: opp[0]?.createdAt?.toISOString() ?? null,
    contactOpportunityCreatedAt: r.opportunityCreatedAt?.toISOString() ?? null,
    contactCreatedAt: r.ghlCreatedAt?.toISOString() ?? null,
  };
}

/** One synced appointment by GHL event id (the brief's call context when opened from a card). */
export async function readMirrorEvent(ghlEventId: string): Promise<{ eventId: string; calendarId: string; calendarName: string; title: string | null; startIso: string; endIso: string | null; ghlContactId: string | null } | null> {
  const rows = await db
    .select({ eventId: appointments.ghlEventId, calendarId: appointments.ghlCalendarId, calendarName: appointments.calendarName, title: appointments.title, startTime: appointments.startTime, endTime: appointments.endTime, ghlContactId: appointments.ghlContactId })
    .from(appointments)
    .where(eq(appointments.ghlEventId, ghlEventId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { eventId: r.eventId, calendarId: r.calendarId ?? '', calendarName: calendarLabel(r.calendarName, r.calendarId ?? ''), title: r.title, startIso: r.startTime.toISOString(), endIso: r.endTime?.toISOString() ?? null, ghlContactId: r.ghlContactId };
}

/** Name / email / phone search over the mirror (case-insensitive contains), newest first. */
export async function searchMirrorContacts(q: string, limit = 8): Promise<Array<Omit<SearchRow, 'source'>>> {
  const term = `%${q.trim().replace(/[%_]/g, '')}%`;
  if (term === '%%') return [];
  const rows = await db
    .select({ ghlContactId: contacts.ghlContactId, contactId: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone })
    .from(contacts)
    .where(or(ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, term), ilike(contacts.email, term), ilike(contacts.phone, term)))
    .orderBy(desc(contacts.ghlCreatedAt))
    .limit(limit);
  return rows.map((r) => ({ ghlContactId: r.ghlContactId, contactId: r.contactId, name: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || (r.email ?? r.ghlContactId), email: r.email, phone: r.phone }));
}
