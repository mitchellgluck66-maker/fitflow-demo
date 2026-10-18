import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { actionView, undoLog } from '@/lib/companion/log';

export const dynamic = 'force-dynamic';

/** POST /api/companion/actions/{id}/undo — within 5 minutes: reverse the applied steps, add "Undone by <user>". 410 after. */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const { id } = await context.params;
    const r = await dbTimeout(undoLog(id, me.user), 'companion undo', 120_000);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ action: actionView(r.action, new Date(), me.user) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to undo the log');
  }
}
