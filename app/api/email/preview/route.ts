import { NextRequest, NextResponse } from 'next/server';
import { buildReport } from '@/lib/reports/build';
import { decideReport } from '@/lib/reports/run';
import { reportKindOf } from '@/lib/reports/kinds';
import { periodContaining } from '@/lib/reports/period';

export const dynamic = 'force-dynamic';

/**
 * GET /api/email/preview?kind=daily|weekly|monthly[&date=YYYY-MM-DD][&format=text] — render only, never sent.
 * Without `date`: the latest period (what the next scheduled run would send). With `date`: the period that
 * contains it — the day itself, its Sun–Sat week, its month (`periodEndedBefore` reads the day AFTER the period).
 */
export async function GET(request: NextRequest) {
  const kind = reportKindOf(request.nextUrl.searchParams.get('kind') ?? 'daily');
  if (!kind) return NextResponse.json({ error: 'kind must be daily, weekly or monthly' }, { status: 400 });
  const date = request.nextUrl.searchParams.get('date') ?? request.nextUrl.searchParams.get('today');
  try {
    const now = new Date();
    const period = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? periodContaining(kind, date) : (await decideReport(kind, now)).period;
    const built = await buildReport(kind, period, { now });
    if (request.nextUrl.searchParams.get('format') === 'text') {
      return new NextResponse(built.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new NextResponse(built.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Digest-Empty': String(built.model.empty), 'X-Report-Subject': encodeURIComponent(built.model.subject) } });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to render the report', detail: String(error) }, { status: 500 });
  }
}
