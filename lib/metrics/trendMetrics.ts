/**
 * Metric registry for the KPI trend drop-down — PURE.
 *
 * One entry per tile metric: how to compute it over ANY range with the engine
 * (sums for counts / cash, ratios recomputed from the range's totals for rates
 * and CAC — never an average of bucket ratios). Since 2026-09-30 (A1,
 * Mitchell's decision) the window and grain are ONE rule for every metric:
 * 30 days → daily · 3 months → weekly (Sun–Sat) · 6 months → weekly ·
 * 12 months → monthly; default 3 months. The card's own range is highlighted
 * and its value comes from the same compute, so the drop-down never disagrees
 * with the number it explains.
 */

import {
  computeAdsKpis,
  computeMarketing,
  computeRevenue,
  computeShowRates,
  funnelMembership,
  inReportingCurrency,
  type Currency,
  type MetricsInput,
  type Range,
} from './index';
import { addDays, addMonths, monthEnd, monthStart, weekStart, formatRangeLabel } from '../dates';
import type { DataMaturity } from './maturity';

export type TrendGrain = 'day' | 'week' | 'month';
export type TrendValueKind = 'count' | 'cents' | 'pct' | 'ratio';

export interface TrendMetric {
  key: string;
  label: string;
  kind: TrendValueKind;
  lowerIsBetter: boolean;
  /** Where a fuller view lives. */
  openIn: string;
  compute: (input: MetricsInput, range: Range) => number | null;
}

const rate = (type: string) => (input: MetricsInput, range: Range) => computeShowRates(input, range).find((r) => r.type === type)?.rate ?? null;
const count = (key: keyof ReturnType<typeof funnelMembership>) => (input: MetricsInput, range: Range) => funnelMembership(input, range)[key].length;

const M = (key: string, label: string, kind: TrendValueKind, lowerIsBetter: boolean, openIn: string, compute: TrendMetric['compute']): TrendMetric => ({
  key,
  label,
  kind,
  lowerIsBetter,
  openIn,
  compute,
});

export const TREND_METRICS: readonly TrendMetric[] = [
  // ---- volume / cash (summed over a range) ----
  M('initial_cash', 'Initial cash collected', 'cents', false, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).initialCents)),
  M('recurring_cash', 'Recurring cash', 'cents', false, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).recurringCents)),
  M('collected', 'Cash collected', 'cents', false, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).collectedCents)),
  M('failed', 'Still unpaid invoices', 'count', true, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).failedCount)),
  M('refunds', 'Refunds', 'cents', true, '/revenue', (i, r) => (computeRevenue(i, r).awaitingStripe ? null : computeRevenue(i, r).refundedCents)),
  M('enrollments', 'Enrollments', 'count', false, '/funnel', count('enrolled')),
  M('applied', 'Applied', 'count', false, '/funnel', count('applied')),
  M('consults_booked', 'Consults booked', 'count', false, '/funnel', count('consult_booked')),
  M('roadmaps_booked', 'Roadmaps booked', 'count', false, '/funnel', count('roadmap_booked')),
  M('spend', 'Spend', 'cents', true, '/ads', (i, r) => computeAdsKpis(i, r).spendCents),

  // ---- rates / CAC (recomputed from the range's totals) ----
  M('paid_cac', 'Paid CAC', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).paidCacCents),
  M('blended_cac', 'Blended CAC', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).blendedCacCents),
  M('cost_client', 'Cost per client', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).blendedCacCents),
  M('roas', 'ROAS', 'ratio', false, '/ads', (i, r) => computeMarketing(i, r).roas),
  M('ltv_cac', 'LTV:CAC', 'ratio', false, '/', (i, r) => computeMarketing(i, r).ltvToCac),
  M('cost_roadmap', 'Cost per roadmap booked', 'cents', true, '/ads', (i, r) => computeMarketing(i, r).costPerRoadmapCents),
  M('cpl', 'Cost per lead', 'cents', true, '/ads', (i, r) => computeAdsKpis(i, r).costPerLeadCents),
  M('cost_consult', 'Cost per consult', 'cents', true, '/ads', (i, r) => computeAdsKpis(i, r).costPerConsultCents),
  M('consult_show_rate', 'Consult show rate', 'pct', false, '/funnel', rate('Consult')),
  M('roadmap_show_rate', 'Roadmap show rate', 'pct', false, '/funnel', rate('Roadmap')),
];

const BY_KEY = new Map(TREND_METRICS.map((m) => [m.key, m]));

export function trendMetric(key: string): TrendMetric | null {
  return BY_KEY.get(key) ?? null;
}

/** The drop-down's windows — the same four for every metric. */
export const TREND_WINDOWS = ['30d', '3m', '6m', '12m'] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
export const DEFAULT_TREND_WINDOW: TrendWindow = '3m';
export const TREND_WINDOW_META: Record<TrendWindow, { label: string; short: string; grain: TrendGrain }> = {
  '30d': { label: 'Last 30 days', short: '30 days', grain: 'day' },
  '3m': { label: 'Last 3 months', short: '3 months', grain: 'week' },
  '6m': { label: 'Last 6 months', short: '6 months', grain: 'week' },
  '12m': { label: 'Last 12 months', short: '12 months', grain: 'month' },
};

export function isTrendWindow(v: unknown): v is TrendWindow {
  return typeof v === 'string' && (TREND_WINDOWS as readonly string[]).includes(v);
}

export interface TrendBucket {
  start: string;
  end: string;
  label: string;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (start: string) => `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} ’${start.slice(2, 4)}`;

/** Buckets of `grain` covering [start, end]; the last one is cut at `end` (to date, never the future). */
function bucketsOf(grain: TrendGrain, start: string, end: string): TrendBucket[] {
  const out: TrendBucket[] = [];
  for (let cursor = start; cursor <= end; ) {
    const natural = grain === 'day' ? cursor : grain === 'week' ? addDays(cursor, 6) : monthEnd(cursor);
    const bEnd = natural < end ? natural : end;
    out.push({ start: cursor, end: bEnd, label: grain === 'month' ? monthLabel(cursor) : formatRangeLabel(cursor, bEnd) });
    cursor = addDays(natural, 1);
  }
  return out;
}

/** The first day of a window ending `today` (pure): 30 days; the Sun–Sat week holding the day after
 *  "today − N months" (3 / 6 months, weekly); the month 11 months back (12 months, monthly). */
export function trendWindowStart(window: TrendWindow, today: string): string {
  if (window === '30d') return addDays(today, -29);
  if (window === '12m') return monthStart(addMonths(today, -11));
  return weekStart(addDays(addMonths(today, window === '3m' ? -3 : -6), 1));
}

/**
 * The window's buckets ending `today` (last bucket to date), plus the equivalent span immediately
 * before (the same number of whole buckets) for the faint comparison line.
 */
export function trendSpans(window: TrendWindow, today: string): { grain: TrendGrain; current: TrendBucket[]; previous: TrendBucket[]; span: Range; previousSpan: Range } {
  const grain = TREND_WINDOW_META[window].grain;
  const start = trendWindowStart(window, today);
  const current = bucketsOf(grain, start, today);
  const n = current.length;
  const prevEnd = addDays(start, -1);
  const prevStart = grain === 'day' ? addDays(start, -n) : grain === 'week' ? addDays(start, -7 * n) : addMonths(start, -n);
  const previous = bucketsOf(grain, prevStart, prevEnd);
  return { grain, current, previous, span: { start, end: today }, previousSpan: { start: prevStart, end: prevEnd } };
}

export interface TrendPointOut {
  start: string;
  end: string;
  label: string;
  value: number | null;
  /** True when the bucket overlaps the card's selected range (the highlighted band). */
  inCard: boolean;
}

export interface MetricTrend {
  key: string;
  label: string;
  window: TrendWindow;
  /** "Last 3 months". */
  windowLabel: string;
  grain: TrendGrain;
  kind: TrendValueKind;
  lowerIsBetter: boolean;
  openIn: string;
  /** Currency of every 'cents' value (the reporting currency). */
  currency: Currency;
  current: TrendPointOut[];
  /** The equivalent span before, aligned by index. */
  previous: TrendPointOut[];
  /** The metric computed by the engine over the whole window (the header value) and the prior span. */
  spanValue: number | null;
  previousSpanValue: number | null;
  span: { start: string; end: string; label: string };
  previousSpan: { start: string; end: string; label: string };
  /** The card's selected range: its value (= the tile) and whether it lies inside the window. */
  highlight: { start: string; end: string; label: string; value: number | null; inWindow: boolean } | null;
  /** Maturing-data disclaimer for the window (set by the service; null in pure computation). */
  maturity: DataMaturity | null;
  /** True when this metric carries the badge for the window. */
  maturing: boolean;
}

/** Compute a metric's trend from already-loaded rows (pure). `card` = the tile's selected range. */
export function computeMetricTrend(metric: TrendMetric, raw: MetricsInput, today: string, window: TrendWindow = DEFAULT_TREND_WINDOW, card: Range | null = null): MetricTrend {
  const input = inReportingCurrency(raw);
  const spans = trendSpans(window, today);
  const overlaps = (b: TrendBucket) => Boolean(card && b.start <= card.end && b.end >= card.start);
  const point = (b: TrendBucket, highlightable: boolean): TrendPointOut => ({ start: b.start, end: b.end, label: b.label, value: metric.compute(input, { start: b.start, end: b.end }), inCard: highlightable && overlaps(b) });
  const cur = spans.span;
  const prev = spans.previousSpan;
  return {
    key: metric.key,
    label: metric.label,
    window,
    windowLabel: TREND_WINDOW_META[window].label,
    grain: spans.grain,
    kind: metric.kind,
    lowerIsBetter: metric.lowerIsBetter,
    openIn: metric.openIn,
    currency: input.money.reporting,
    current: spans.current.map((b) => point(b, true)),
    previous: spans.previous.map((b) => point(b, false)),
    spanValue: metric.compute(input, cur),
    previousSpanValue: metric.compute(input, prev),
    span: { ...cur, label: formatRangeLabel(cur.start, cur.end) },
    previousSpan: { ...prev, label: formatRangeLabel(prev.start, prev.end) },
    highlight: card
      ? { start: card.start, end: card.end, label: formatRangeLabel(card.start, card.end), value: metric.compute(input, card), inWindow: card.start <= cur.end && card.end >= cur.start }
      : null,
    maturity: null,
    maturing: false,
  };
}

/** The date range a trend needs loaded: the prior span through the window, widened to the card's range. */
export function trendWindow(window: TrendWindow, today: string, card: Range | null = null): Range {
  const s = trendSpans(window, today);
  const start = card && card.start < s.previousSpan.start ? card.start : s.previousSpan.start;
  const end = card && card.end > today ? card.end : today;
  return { start, end };
}
