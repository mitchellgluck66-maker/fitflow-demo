import { NextRequest, NextResponse } from 'next/server';
import { dbTimeout, apiErrorResponse } from '@/lib/dbTimeout';
import { getMetricTrend } from '@/lib/metrics/service';
import { TREND_METRICS, TREND_WINDOWS, isTrendWindow, DEFAULT_TREND_WINDOW } from '@/lib/metrics/trendMetrics';
import { isValidDate } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/**
 * GET /api/metrics/trend?metric=paid_cac&window=3m&start=2026-09-01&end=2026-09-30
 * The KPI trend drop-down's series: one rule for every metric — 30d daily ·
 * 3m / 6m weekly (Sun–Sat) · 12m monthly (default 3m) — plus the prior
 * equivalent span, and the card's range (`start`/`end`) as the highlight with
 * its engine value. Without `metric`, lists the registry.
 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const key = q.get('metric');
    if (!key) return NextResponse.json({ windows: TREND_WINDOWS, metrics: TREND_METRICS.map(({ key: k, label, kind, lowerIsBetter, openIn }) => ({ key: k, label, kind, lowerIsBetter, openIn })) });
    const w = q.get('window');
    if (w !== null && !isTrendWindow(w)) return NextResponse.json({ error: `Unknown window: ${w} (${TREND_WINDOWS.join(' / ')})` }, { status: 400 });
    const start = q.get('start');
    const end = q.get('end');
    const card = isValidDate(start) && isValidDate(end) && start <= end ? { start, end } : null;
    const trend = await dbTimeout(getMetricTrend(key, { pipelineId: q.get('pipeline') ?? undefined, window: w ?? DEFAULT_TREND_WINDOW, card }), 'metric trend');
    if (!trend) return NextResponse.json({ error: `Unknown metric: ${key}` }, { status: 404 });
    return NextResponse.json(trend);
  } catch (error) {
    return apiErrorResponse(error, 'Failed to compute trend');
  }
}
