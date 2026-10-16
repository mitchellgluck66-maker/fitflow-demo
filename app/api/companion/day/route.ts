import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { getMyDay } from '@/lib/companion/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/companion/day?date=YYYY-MM-DD[&user=<app user id>] — the viewed user's calls for one local day.
 * `source` is 'live' (GoHighLevel, cached ≤ 2 min), 'mirror' (GHL failed — `asOf` + `reason` say so) or 'none'
 * (no GHL user linked). Read-only; nothing here writes anywhere.
 */
export async function GET(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const q = request.nextUrl.searchParams;
    const r = await dbTimeout(getMyDay({ current: me.user, requestedUserId: q.get('user'), date: q.get('date') }), 'companion day');
    if (!r.ok) return NextResponse.json({ error: r.error, detail: r.detail }, { status: r.status });
    return NextResponse.json(r.day);
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load the day');
  }
}
