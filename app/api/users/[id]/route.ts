import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { requireOwner } from '@/lib/auth/currentUser';
import { updateUser, UserInputError } from '@/lib/auth/users';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/users/[id] { name?, role?, ghlUserId?, active?, password? } — owner only. `password` resets it (the
 * owner types or generates one; it is never echoed). An owner cannot disable their own login.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    if (id === auth.user.uid && body.active === false) return NextResponse.json({ error: 'You cannot disable the login you are using.' }, { status: 400 });
    const user = await dbTimeout(updateUser(id, { name: body.name, role: body.role, ghlUserId: body.ghlUserId, active: body.active, password: body.password }), 'users');
    return NextResponse.json({ ok: true, user });
  } catch (error) {
    if (error instanceof UserInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    return apiErrorResponse(error, 'Failed to update the user');
  }
}
