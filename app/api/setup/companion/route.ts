import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth/currentUser';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { getCompanionAdminState } from '@/lib/companion/admin';

export const dynamic = 'force-dynamic';

/** GET /api/setup/companion — the owner's view: write key state, dry run, the outcome map, failed logs. Owner only. */
export async function GET() {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    return NextResponse.json(await dbTimeout(getCompanionAdminState(), 'companion admin'));
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load the Companion settings');
  }
}
