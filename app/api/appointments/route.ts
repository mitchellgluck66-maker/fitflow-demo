import { NextRequest, NextResponse } from 'next/server';
import { db, appointments, contacts, stages } from '@/db';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { getDayBounds, todayInTimezone } from '@/lib/day';
import { getTimezone } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * GET /api/appointments?date=YYYY-MM-DD
 * One business-local day's appointments joined to their contact. Read-only:
 * `outcome` mirrors GHL's appointmentStatus and is never set here.
 */
export async function GET(request: NextRequest) {
  try {
    const timezone = await getTimezone();
    const date = request.nextUrl.searchParams.get('date') ?? todayInTimezone(timezone);
    const { startMs, endMs } = getDayBounds(date, timezone);

    const rows = await db
      .select({
        id: appointments.id,
        leadId: appointments.contactId,
        type: appointments.type,
        title: appointments.title,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        assignedTo: appointments.assignedTo,
        outcome: appointments.outcome,
        ghlEventId: appointments.ghlEventId,
        ghlCalendarId: appointments.ghlCalendarId,
        ghlAppointmentStatus: appointments.ghlStatus,
        origin: appointments.origin,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        stage: stages.name,
        source: contacts.attributionSource,
        estimatedValue: contacts.monetaryValueCents,
        owner: contacts.ownerName,
      })
      .from(appointments)
      .leftJoin(contacts, eq(appointments.contactId, contacts.id))
      .leftJoin(stages, eq(contacts.stageId, stages.id))
      .where(and(gte(appointments.startTime, new Date(startMs)), lte(appointments.startTime, new Date(endMs))))
      .orderBy(asc(appointments.startTime));

    return NextResponse.json({
      date,
      timezone,
      readOnly: true,
      appointments: rows.map((r) => ({
        ...r,
        firstName: r.firstName ?? 'Unknown',
        lastName: r.lastName ?? '',
        email: r.email ?? '',
        startTime: r.startTime.toISOString(),
        endTime: r.endTime?.toISOString() ?? null,
        outcomeNotes: null,
        outcomeMarkedAt: null,
        outcomeMarkedBy: null,
        syncStatus: 'synced',
        syncedAt: null,
      })),
    });
  } catch (error) {
    console.error('Failed to fetch appointments:', error);
    return NextResponse.json({ error: 'Failed to fetch appointments', detail: String(error) }, { status: 500 });
  }
}
