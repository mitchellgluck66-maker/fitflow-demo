import { NextRequest, NextResponse } from 'next/server';
import { getLatestInsights, runInsights } from '@/lib/anthropic/insights';
import { getAnthropicConfig } from '@/lib/anthropic/config';
import { getTimezone } from '@/lib/settings';
import { rangeFromParams, todayInTimezone } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET ?range&start&end — latest cached findings for that period (no generation). */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const config = await getAnthropicConfig();
    const timezone = await getTimezone();
    const range = rangeFromParams({ range: p.get('range'), start: p.get('start'), end: p.get('end') }, todayInTimezone(timezone));
    const latest = await getLatestInsights(range);
    return NextResponse.json({ notConfigured: !config.configured, cached: true, range: { start: range.start, end: range.end }, ...latest });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read insights', detail: String(error) }, { status: 500 });
  }
}

/** POST {range?, compare?, start?, end?, force?} — generate now. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await runInsights({ range: body.range, compare: body.compare, start: body.start, end: body.end, force: body.force === true });
    return NextResponse.json(result, { status: result.ok || result.notConfigured ? 200 : 500 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to generate insights', detail: String(error) }, { status: 500 });
  }
}
