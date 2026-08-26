import { NextRequest, NextResponse } from 'next/server';
import { getTodoBuckets } from '@/lib/metrics/service';

export const dynamic = 'force-dynamic';

/** GET /api/todo[?today=YYYY-MM-DD] — the Day-1 / Day-3 call list. */
export async function GET(request: NextRequest) {
  try {
    const today = request.nextUrl.searchParams.get('today') ?? undefined;
    const { timezone, buckets } = await getTodoBuckets(today);
    return NextResponse.json({ timezone, ...buckets });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to compute to-do list', detail: String(error) }, { status: 500 });
  }
}
