import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { getAction } from '@/lib/companion/actions';
import { actionView } from '@/lib/companion/log';

export const dynamic = 'force-dynamic';

/** GET /api/companion/actions/{id} — one log's view (its own user, or an owner). */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const { id } = await context.params;
    const row = await dbTimeout(getAction(id), 'companion action');
    if (!row || (me.user.role !== 'owner' && row.userId !== me.user.uid)) return NextResponse.json({ error: 'No such log.' }, { status: 404 });
    return NextResponse.json({ action: actionView(row, new Date(), me.user) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read the log');
  }
}
