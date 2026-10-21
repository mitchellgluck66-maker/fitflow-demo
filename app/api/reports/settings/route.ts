import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { requireOwner } from '@/lib/auth/currentUser';
import { reportsSettingsState, saveReportSettings } from '@/lib/reports/settings';
import { isReportKind } from '@/lib/reports/kinds';

export const dynamic = 'force-dynamic';

/** GET /api/reports/settings — owner only: one card state per report (switch, recipients, next / last send, reason). */
export async function GET() {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    return NextResponse.json(await dbTimeout(reportsSettingsState(), 'reports settings'));
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load the report settings');
  }
}

/** POST /api/reports/settings { kind, enabled?, recipients?, includeWeekends? } — owner only; an invalid address is refused by name. */
export async function POST(request: NextRequest) {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    const body = await request.json().catch(() => ({}));
    if (!isReportKind(body.kind)) return NextResponse.json({ error: 'kind must be daily, weekly or monthly' }, { status: 400 });
    const r = await dbTimeout(saveReportSettings(body.kind, body), 'reports settings');
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, ...(await reportsSettingsState()) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to save the report settings');
  }
}
