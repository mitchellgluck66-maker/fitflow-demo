import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { requireOwner } from '@/lib/auth/currentUser';
import { getOnboardingView } from '@/lib/onboarding/service';
import { onboardingCsv } from '@/lib/onboarding/csv';

export const dynamic = 'force-dynamic';

/**
 * GET /api/onboarding?date=YYYY-MM-DD&range=day|week[&format=csv] — owner only (an onboarding login gets 403 from
 * the interceptor and again here). Every companion user's calls in the range with their Companion logs, the six
 * tiles and the needs-attention list — the same numbers the emails carry. Read-only.
 */
export async function GET(request: NextRequest) {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    const q = request.nextUrl.searchParams;
    const view = await dbTimeout(getOnboardingView({ range: q.get('range'), date: q.get('date') }), 'onboarding', 60_000);
    if ('error' in view) return NextResponse.json(view, { status: 400 });
    if (q.get('format') === 'csv') {
      const name = view.range === 'week' ? `onboarding-week-${view.start}.csv` : `onboarding-${view.start}.csv`;
      return new NextResponse(onboardingCsv(view.calls), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });
    }
    return NextResponse.json(view);
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load the onboarding calls');
  }
}
