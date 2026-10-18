import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { getOutcomesForCall } from '@/lib/companion/outcomeService';
import type { CallType } from '@/lib/companion/calendars';

export const dynamic = 'force-dynamic';

/**
 * GET /api/companion/outcomes?callType=Consult|Roadmap|Other — what the pop-out offers: the dry-run state, the
 * call type's outcomes (each resolved to a stage, or `unavailable` with the reason) and the "Move to…" stages of
 * the followed pipeline. Read-only.
 */
export async function GET(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const raw = request.nextUrl.searchParams.get('callType') ?? 'Other';
    const callType: CallType = raw === 'Consult' || raw === 'Roadmap' ? raw : 'Other';
    return NextResponse.json(await dbTimeout(getOutcomesForCall(callType), 'companion outcomes'));
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load the outcomes');
  }
}
