import { NextRequest, NextResponse } from 'next/server';
import { getMetricTrend } from '@/lib/metrics/service';
import { TREND_METRICS } from '@/lib/metrics/trendMetrics';

export const dynamic = 'force-dynamic';

/**
 * GET /api/metrics/trend?metric=paid_cac — the KPI trend popover's series:
 * last 30 days (daily, volume/cash) or last 12 Sun–Sat weeks (rates/CAC),
 * plus the prior equivalent span. Without `metric`, lists the registry.
 */
export async function GET(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get('metric');
    if (!key) return NextResponse.json({ metrics: TREND_METRICS.map(({ key: k, label, grain, kind, lowerIsBetter, openIn }) => ({ key: k, label, grain, kind, lowerIsBetter, openIn })) });
    const trend = await getMetricTrend(key, { pipelineId: request.nextUrl.searchParams.get('pipeline') ?? undefined });
    if (!trend) return NextResponse.json({ error: `Unknown metric: ${key}` }, { status: 404 });
    return NextResponse.json(trend);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to compute trend', detail: String(error) }, { status: 500 });
  }
}
