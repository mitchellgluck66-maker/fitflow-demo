import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { getBrief } from '@/lib/companion/briefService';
import { getMyDay } from '@/lib/companion/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/companion/brief?contact=<ghl contact id>[&event=<ghl event id>&date=&user=] — the pop-out brief.
 * With an event, the call context comes from the (cached) live day when it holds the event, else from the mirror.
 * Notes come from GHL's read-only notes endpoint; a refused read is `notes.status = 'unavailable'` with the reason.
 */
export async function GET(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const q = request.nextUrl.searchParams;
    const ghlContactId = q.get('contact')?.trim() ?? '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ghlContactId)) return NextResponse.json({ error: 'Bad contact id' }, { status: 400 });
    const eventId = q.get('event')?.trim() || null;
    let call = null;
    if (eventId) {
      const day = await getMyDay({ current: me.user, requestedUserId: q.get('user'), date: q.get('date') });
      const hit = day.ok ? day.day.calls.find((c) => c.eventId === eventId) : undefined;
      if (hit) call = { eventId: hit.eventId, callType: hit.callType, calendarName: hit.calendarName, startIso: hit.startIso, endIso: hit.endIso, title: hit.title };
    }
    const brief = await dbTimeout(getBrief({ ghlContactId, eventId, call }), 'companion brief');
    return NextResponse.json(brief);
  } catch (error) {
    return apiErrorResponse(error, 'Failed to build the brief');
  }
}
