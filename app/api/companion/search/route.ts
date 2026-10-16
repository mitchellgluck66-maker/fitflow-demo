import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { searchPeople } from '@/lib/companion/briefService';

export const dynamic = 'force-dynamic';

/** GET /api/companion/search?q= — our contacts + a live GoHighLevel lookup, merged by GHL contact id. */
export async function GET(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const q = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 80);
    const r = await dbTimeout(searchPeople(q), 'companion search');
    return NextResponse.json({ q, ...r });
  } catch (error) {
    return apiErrorResponse(error, 'Search failed');
  }
}
