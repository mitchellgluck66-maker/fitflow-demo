import { NextRequest, NextResponse } from 'next/server';
import { dbTimeout, apiErrorResponse } from '@/lib/dbTimeout';
import { getScorecard } from '@/lib/metrics/service';
import { getNarrative } from '@/lib/anthropic/narrative';
import { assembleScorecard, scorecardKindOf, SCORECARD_DEFAULT_PRESET } from '@/lib/scorecard/assemble';

export const dynamic = 'force-dynamic';

/**
 * GET /api/scorecard/view?range&start&end&compare
 * The /scorecard page's data: the raw scorecard result (for the funnel strip
 * and trend popovers) plus the assembled model the weekly/monthly email
 * renders — the same function, so the page and the email agree to the digit.
 */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const result = await dbTimeout(getScorecard({ range: p.get('range') ?? SCORECARD_DEFAULT_PRESET, start: p.get('start'), end: p.get('end'), compare: p.get('compare') ?? 'previous_period' }), 'scorecard');
    const kind = scorecardKindOf(result);
    const narrative = kind === 'custom' ? null : await getNarrative(kind, result.range.start, result.range.end);
    return NextResponse.json({ result, view: assembleScorecard(result, narrative) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to assemble the scorecard');
  }
}
