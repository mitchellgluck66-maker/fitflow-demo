import { NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { resolveViewing } from '@/lib/companion/viewing';
import { timezoneFor } from '@/lib/companion/service';

export const dynamic = 'force-dynamic';

/** GET /api/companion/me — the signed-in person, the user whose day is shown by default, the technician list (owner). */
export async function GET() {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const v = await dbTimeout(resolveViewing(me.user, null), 'companion me');
    if (!v.ok) return NextResponse.json({ error: v.error, detail: v.detail }, { status: v.status });
    const timezone = await timezoneFor(v.viewing).catch(() => null);
    return NextResponse.json({
      user: { id: me.user.uid, name: me.user.name, email: me.user.email, role: me.user.role, source: me.user.source, hasRow: me.user.source === 'db' },
      viewing: { id: v.viewing.id, name: v.viewing.name, ghlUserId: v.viewing.ghlUserId, isSelf: v.viewing.isSelf, autoPicked: v.viewing.autoPicked },
      technicians: v.technicians,
      timezone,
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read the current user');
  }
}
