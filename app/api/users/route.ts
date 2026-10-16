import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { requireOwner } from '@/lib/auth/currentUser';
import { createUser, listAppUsers, UserInputError } from '@/lib/auth/users';
import { listUsers as listGhlUsers } from '@/lib/ghl/client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/users — owner only: every login (no hashes) + GoHighLevel's user list for the "GHL user" picker
 * (`ghlUsers.error` names the reason when GHL cannot be read; the picker then accepts a typed id).
 */
export async function GET() {
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;
  try {
    const [users, ghl] = await dbTimeout(Promise.all([listAppUsers(), listGhlUsers().catch((e: unknown) => ({ ok: false as const, data: null, error: e instanceof Error ? e.message : String(e) }))]), 'users');
    const ghlUsers = ghl.ok && ghl.data ? { users: ghl.data.users.map((u) => ({ id: u.id, name: (u.name ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`).trim() || u.id, email: u.email ?? null })), error: null } : { users: [], error: ghl.error ?? 'GoHighLevel users could not be read' };
    return NextResponse.json({ users, me: auth.user.uid, ghlUsers });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to list users');
  }
}

/** POST /api/users { name, email, role, password, ghlUserId? } — owner only. The password is never echoed. */
export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json().catch(() => ({}));
    const user = await dbTimeout(createUser({ name: body.name, email: body.email, role: body.role, password: body.password, ghlUserId: body.ghlUserId }), 'users');
    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (error) {
    if (error instanceof UserInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    return apiErrorResponse(error, 'Failed to add the user');
  }
}
