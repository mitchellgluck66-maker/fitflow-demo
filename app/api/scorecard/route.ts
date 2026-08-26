import { NextRequest, NextResponse } from 'next/server';
import { getScorecard } from '@/lib/metrics/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/scorecard?range=last_week&compare=previous_period[&start&end][&pipeline]
 * The single source of numbers for the Command Center and Funnel tab.
 * Emails call getScorecard() directly — same function, same numbers.
 */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const result = await getScorecard({
      range: p.get('range'),
      start: p.get('start'),
      end: p.get('end'),
      compare: p.get('compare'),
      pipelineId: p.get('pipeline') ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('scorecard failed:', error);
    return NextResponse.json({ error: 'Failed to compute scorecard', detail: String(error) }, { status: 500 });
  }
}
