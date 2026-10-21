import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { requireOwner } from '@/lib/auth/currentUser';
import { runReport } from '@/lib/reports/run';
import { isReportKind } from '@/lib/reports/kinds';
import { resendConfigured } from '@/lib/email/resend';

export const dynamic = 'force-dynamic';

/**
 * POST /api/reports/test { kind } — "Send test to me": the latest period to the signed-in owner's own email, archived
 * with is_test so it never counts as the scheduled send. The team-password owner has no email → 409.
 */
export async function POST(request: NextRequest) {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    const body = await request.json().catch(() => ({}));
    if (!isReportKind(body.kind)) return NextResponse.json({ error: 'kind must be daily, weekly or monthly' }, { status: 400 });
    if (!owner.user.email) return NextResponse.json({ error: 'Sign in with a personal login to send a test to yourself — the team password has no email address.' }, { status: 409 });
    if (!resendConfigured()) return NextResponse.json({ error: 'RESEND_API_KEY / RESEND_FROM_EMAIL are not set — nothing can be sent. Use Preview instead.' }, { status: 409 });
    const result = await dbTimeout(runReport(body.kind, { test: true, to: [owner.user.email] }), 'report test send', 120_000);
    return NextResponse.json({ ok: result.status === 'sent', ...result }, { status: result.status === 'sent' ? 200 : 502 });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to send the test');
  }
}
