/**
 * Companion stage 1 — the database side: the mirror's appointments for a user and a day (the fallback), the contact
 * lookup for enrichment, and the live-contact reader. The only file under lib/companion that touches the DB.
 */

import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db, appointments, contacts, stages, pipelines } from '@/db';
import { readMarker } from '../sync/markers';
import { getContact } from '../ghl/client';
import { callTypeOf, calendarLabel, inCalendarFilter } from './calendars';
import type { MirrorReader, MirrorResult } from './source';
import type { LiveContact, MirrorContact } from './enrich';

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
