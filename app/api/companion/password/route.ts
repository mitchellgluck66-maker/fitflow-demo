import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { changeOwnPassword, UserInputError } from '@/lib/auth/users';

export const dynamic = 'force-dynamic';

/** POST /api/companion/password { current, next } — the signed-in person changes their own password. Never logged. */
export async function POST(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  if (me.user.source !== 'db') return NextResponse.json({ error: 'The team password is changed in the Vercel environment (APP_PASSWORD)', detail: 'Only personal logins change their password here.' }, { status: 409 });
  try {
    const body = await request.json().catch(() => ({}));
    await dbTimeout(changeOwnPassword(me.user.uid, body.current, body.next), 'companion password');
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UserInputError) return NextResponse.json({ error: error.message }, { status: error.message === 'Current password is wrong.' ? 401 : error.status });
    return apiErrorResponse(error, 'Failed to change the password');
  }
}
