/**
 * Metric registry for the KPI trend popover — PURE.
 *
 * One entry per tile metric: how to compute it for a bucket from the engine,
 * and which grain is honest for it. Volume and cash metrics trend daily over
 * the last 30 days; rates and CAC trend over the last 12 Sun–Sat weeks
 * (daily CAC on a handful of enrollments is noise). Every value is computed
 * by the same engine functions the tiles use, so the popover never disagrees
 * with the number it explains.
 */

import {
  computeAdsKpis,
  computeMarketing,
  computeRevenue,
  computeShowRates,
  funnelMembership,
  type MetricsInput,
  type Range,
} from './index';
import { addDays, weekBuckets, weekStart, formatRangeLabel, type DateRange } from '../dates';

export type TrendGrain = 'day' | 'week';
export type TrendValueKind = 'count' | 'cents' | 'pct' | 'ratio';

export interface TrendMetric {
  key: string;
  label: string;
  grain: TrendGrain;
  kind: TrendValueKind;
  lowerIsBetter: boolean;
  /** Where a fuller view lives. */
  openIn: string;
  compute: (input: MetricsInput, range: Range) => number | null;
}

const rate = (type: string) => (input: MetricsInput, range: Range) => computeShowRates(input, range).find((r) => r.type === type)?.rate ?? null;
const count = (key: keyof ReturnType<typeof funnelMembership>) => (input: MetricsInput, range: Range) => funnelMembership(input, range)[key].length;

const M = (key: string, label: string, grain: TrendGrain, kind: TrendValueKind, lowerIsBetter: boolean, openIn: string, compute: TrendMetric['compute']): TrendMetric => ({
  key,
  label,
  grain,
  kind,
  lowerIsBetter,
  openIn,
  compute,
});

export const TREND_METRICS: readonly TrendMetric[] = [
  // ---- volume / cash: daily, last 30 days ----
  M('initial_cash', 'Initial cash collected', 'day', 'cents', false, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).initialCents)),
  M('recurring_cash', 'Recurring cash', 'day', 'cents', false, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).recurringCents)),
  M('collected', 'Cash collected', 'day', 'cents', false, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).collectedCents)),
  M('failed', 'Failed payments', 'day', 'count', true, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).failedCount)),
  M('refunds', 'Refunds', 'day', 'cents', true, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).refundedCents)),
  M('enrollments', 'Enrollments', 'day', 'count', false, '/funnel', count('enrolled')),
  M('applied', 'Applied', 'day', 'count', false, '/funnel', count('applied')),
  M('consults_booked', 'Consults booked', 'day', 'count', false, '/funnel', count('consult_booked')),
  M('roadmaps_booked', 'Roadmaps booked', 'day', 'count', false, '/funnel', count('roadmap_booked')),
  M('spend', 'Spend', 'day', 'cents', true, '/ads', (i, r) => computeAdsKpis(i, r).spendCents),

  // ---- rates / CAC: weekly, last 12 Sun–Sat weeks ----
  M('paid_cac', 'Paid CAC', 'week', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).paidCacCents),
  M('blended_cac', 'Blended CAC', 'week', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).blendedCacCents),
  M('cost_client', 'Cost per client', 'week', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).blendedCacCents),
  M('roas', 'ROAS', 'week', 'ratio', false, '/ads', (i, r) => computeMarketing(i, r).roas),
  M('ltv_cac', 'LTV:CAC', 'week', 'ratio', false, '/', (i, r) => computeMarketing(i, r).ltvToCac),
  M('cost_roadmap', 'Cost per roadmap booked', 'week', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).costPerRoadmapCents),
  M('cpl', 'Cost per lead', 'week', 'cents', true, '/ads', (i, r) => computeAdsKpis(i, r).costPerLeadCents),
  M('cost_consult', 'Cost per consult', 'week', 'cents', true, '/ads', (i, r) => computeAdsKpis(i, r).costPerConsultCents),
  M('consult_show_rate', 'Consult show rate', 'week', 'pct', false, '/funnel', rate('Consult')),
  M('roadmap_show_rate', 'Roadmap show rate', 'week', 'pct', false, '/funnel', rate('Roadmap')),
];

const BY_KEY = new Map(TREND_METRICS.map((m) => [m.key, m]));

export function trendMetric(key: string): TrendMetric | null {
  return BY_KEY.get(key) ?? null;
}

export const DAILY_SPAN_DAYS = 30;
export const WEEKLY_SPAN_WEEKS = 12;

export interface TrendBucket {
  start: string;
  end: string;
  label: string;
}

/**
 * The buckets a metric trends over, ending at `today` (daily) or at the
 * current Sun–Sat week (weekly), plus the equivalent span immediately before
 * for the faint comparison line.
 */
export function trendSpans(grain: TrendGrain, today: string): { current: TrendBucket[]; previous: TrendBucket[]; window: Range } {
  if (grain === 'day') {
    const day = (d: string): TrendBucket => ({ start: d, end: d, label: formatRangeLabel(d, d) });
    const current: TrendBucket[] = [];
    const previous: TrendBucket[] = [];
    for (let i = DAILY_SPAN_DAYS - 1; i >= 0; i -= 1) current.push(day(addDays(today, -i)));
    for (let i = 2 * DAILY_SPAN_DAYS - 1; i >= DAILY_SPAN_DAYS; i -= 1) previous.push(day(addDays(today, -i)));
    return { current, previous, window: { start: previous[0].start, end: today } };
  }
  const thisWeek = weekStart(today);
  const currentStart = addDays(thisWeek, -7 * (WEEKLY_SPAN_WEEKS - 1));
  const previousStart = addDays(currentStart, -7 * WEEKLY_SPAN_WEEKS);
  const current = weekBuckets(currentStart, addDays(thisWeek, 6));
  const previous = weekBuckets(previousStart, addDays(currentStart, -1));
  return { current, previous, window: { start: previousStart, end: addDays(thisWeek, 6) } };
}

export interface TrendPointOut {
  start: string;
  end: string;
  label: string;
  value: number | null;
}

export interface MetricTrend {
  key: string;
  label: string;
  grain: TrendGrain;
  kind: TrendValueKind;
  lowerIsBetter: boolean;
  openIn: string;
  /** Last 30 days / last 12 weeks. */
  current: TrendPointOut[];
  /** The equivalent span before, aligned by index. */
  previous: TrendPointOut[];
  /** Whole-span value (the metric computed over the current span) and the prior span. */
  spanValue: number | null;
  previousSpanValue: number | null;
  span: { start: string; end: string; label: string };
  previousSpan: { start: string; end: string; label: string };
}

/** Compute a metric's trend from already-loaded rows (pure). */
export function computeMetricTrend(metric: TrendMetric, input: MetricsInput, today: string): MetricTrend {
  const spans = trendSpans(metric.grain, today);
  const point = (b: TrendBucket): TrendPointOut => ({ start: b.start, end: b.end, label: b.label, value: metric.compute(input, { start: b.start, end: b.end }) });
  const cur = { start: spans.current[0].start, end: spans.current[spans.current.length - 1].end };
  const prev = { start: spans.previous[0].start, end: spans.previous[spans.previous.length - 1].end };
  return {
    key: metric.key,
    label: metric.label,
    grain: metric.grain,
    kind: metric.kind,
    lowerIsBetter: metric.lowerIsBetter,
    openIn: metric.openIn,
    current: spans.current.map(point),
    previous: spans.previous.map(point),
    spanValue: metric.compute(input, cur),
    previousSpanValue: metric.compute(input, prev),
    span: { ...cur, label: formatRangeLabel(cur.start, cur.end) },
    previousSpan: { ...prev, label: formatRangeLabel(prev.start, prev.end) },
  };
}

/** The date window a metric's trend needs loaded. */
export function trendWindow(metric: TrendMetric, today: string): DateRange | Range {
  return trendSpans(metric.grain, today).window;
}
