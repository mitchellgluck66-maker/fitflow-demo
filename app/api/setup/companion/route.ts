import { NextRequest, NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth/currentUser';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { getCompanionAdminState, patchCompanionSettings } from '@/lib/companion/admin';

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

/**
 * PATCH /api/setup/companion { dryRun?, confirm?, rescheduleAppointment?, outcomeMap? } — owner only. Turning dry
 * run OFF requires `confirm: true`; the response is the fresh state.
 */
export async function PATCH(request: NextRequest) {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    const r = await dbTimeout(patchCompanionSettings(await request.json().catch(() => null)), 'companion admin');
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, changed: r.changed, state: await getCompanionAdminState() });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to save the Companion settings');
  }
}
