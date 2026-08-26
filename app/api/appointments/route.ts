import { NextRequest, NextResponse } from 'next/server';
import { db, appointments, leads } from '@/db';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { getDayBounds, todayInTimezone } from '@/lib/day';
import { getTimezone, getSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/appointments?date=YYYY-MM-DD
 *
 * Returns one local calendar day's appointments joined to their lead, ordered by
 * start time. The day window is computed in the business timezone rather than
 * UTC, so a late-evening appointment stays on the correct sheet.
 */
export async function GET(request: NextRequest) {
  try {
    const timezone = await getTimezone();
    const date =
      request.nextUrl.searchParams.get('date') ?? todayInTimezone(timezone);

    const { startIso, endIso } = getDayBounds(date, timezone);

    // Restrict to the calendars selected in Setup. An empty selection means
    // "not configured yet", so we show everything rather than an empty screen -
    // filtering to nothing would look like a bug rather than a setting.
    const followedRaw = await getSetting(CREDENTIAL_KEYS.followedCalendars);
    let followed: string[] = [];
    try {
      followed = followedRaw ? JSON.parse(followedRaw) : [];
    } catch {
      followed = [];
    }

    const rows = await db
      .select({
        id: appointments.id,
        leadId: appointments.leadId,
        type: appointments.type,
        title: appointments.title,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        assignedTo: appointments.assignedTo,
        outcome: appointments.outcome,
        outcomeNotes: appointments.outcomeNotes,
        outcomeMarkedAt: appointments.outcomeMarkedAt,
        outcomeMarkedBy: appointments.outcomeMarkedBy,
        syncStatus: appointments.syncStatus,
        syncedAt: appointments.syncedAt,
        ghlEventId: appointments.ghlEventId,
        ghlCalendarId: appointments.ghlCalendarId,
        ghlAppointmentStatus: appointments.ghlAppointmentStatus,
        origin: appointments.origin,
        firstName: leads.firstName,
        lastName: leads.lastName,
        email: leads.email,
        phone: leads.phone,
        stage: leads.stage,
        source: leads.source,
        estimatedValue: leads.estimatedValue,
        owner: leads.owner,
      })
      .from(appointments)
      .innerJoin(leads, eq(appointments.leadId, leads.id))
      .where(
        and(
          gte(appointments.startTime, startIso),
          lte(appointments.startTime, endIso),
        ),
      )
      .orderBy(asc(appointments.startTime));

    // Imported rows carry a calendar id; sample rows do not, so they are never
    // filtered out by a calendar selection they could not possibly match.
    const visible =
      followed.length > 0
        ? rows.filter(
            (r) => !r.ghlCalendarId || followed.includes(r.ghlCalendarId),
          )
        : rows;

    const marked = visible.filter((r) => r.outcome !== null).length;

    return NextResponse.json({
      date,
      timezone,
      appointments: visible,
      followedCalendars: followed,
      summary: {
        total: visible.length,
        marked,
        unmarked: visible.length - marked,
        booked: visible.filter((r) => r.outcome === 'booked').length,
        noShow: visible.filter((r) => r.outcome === 'no_show').length,
        notContinuing: visible.filter((r) => r.outcome === 'not_continuing').length,
      },
    });
  } catch (error) {
    console.error('Failed to fetch appointments:', error);
    return NextResponse.json(
      { error: 'Failed to fetch appointments', detail: String(error) },
      { status: 500 },
    );
  }
}

/** POST /api/appointments - create an appointment (manual entry). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.leadId || !body.startTime) {
      return NextResponse.json(
        { error: 'leadId and startTime are required' },
        { status: 400 },
      );
    }

    const timezone = await getTimezone();
    const now = new Date().toISOString();

    const [created] = await db
      .insert(appointments)
      .values({
        leadId: body.leadId,
        type: body.type ?? 'Consult',
        title: body.title ?? null,
        startTime: body.startTime,
        endTime: body.endTime ?? null,
        timezone: body.timezone ?? timezone,
        assignedTo: body.assignedTo ?? null,
        ghlEventId: body.ghlEventId ?? null,
        ghlCalendarId: body.ghlCalendarId ?? null,
        ghlContactId: body.ghlContactId ?? null,
        ghlOpportunityId: body.ghlOpportunityId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Failed to create appointment:', error);
    return NextResponse.json(
      { error: 'Failed to create appointment', detail: String(error) },
      { status: 500 },
    );
  }
}
