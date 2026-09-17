/**
 * Glue between the date engine, the row loader and the pure metrics engine.
 * Command Center, Funnel tab and the email digests all go through here, so
 * a number on screen and the same number in an email come from one call path.
 */

import {
  resolveComparison,
  rangeFromParams,
  comparisonFromParam,
  trailingWeeks,
  weekBuckets,
  dayBuckets,
  trendGrain,
  todayInTimezone,
  type DateRange,
  type Comparison,
  type ComparisonMode,
} from '../dates';
import { getTimezone, getSetting, SETTING_KEYS } from '../settings';
import { computeMaturity, isMaturingMetric, type DataMaturity } from './maturity';
import { loadMetricsInput } from './load';
import {
  computeScorecard,
  computeTrend,
  computeTodoBuckets,
  computeAdsKpis,
  computeCampaignTable,
  computeRevenueSummary,
  type AdsKpis,
  type CampaignRow,
  type RevenueSummary,
  type Scorecard,
  type TrendPoint,
  type TodoBuckets,
  type MetricsInput,
} from './index';

export interface ScorecardResult {
  timezone: string;
  today: string;
  range: DateRange;
  comparison: Comparison;
  /** The trailing 8 complete Sun–Sat weeks before the range — chip baseline. */
  baseline: { start: string; end: string };
  scorecard: Scorecard;
  trend: { grain: 'day' | 'week'; current: TrendPoint[]; comparison: TrendPoint[] | null };
  /** Always Sun–Sat weeks (range padded to whole weeks) — for conversion-over-time charts. */
  trendWeekly: { current: TrendPoint[]; comparison: TrendPoint[] | null };
  /** Same weeks in cohort mode: each week's applicants and what they reached since. */
  trendWeeklyCohort: { current: TrendPoint[]; comparison: TrendPoint[] | null };
  /** The trailing 8 complete Sun–Sat weeks before the range, week by week (Ask-the-dashboard context). */
  trailingWeeks: TrendPoint[];
  /** Ads tab: KPIs + campaign table (current and comparison period). */
  ads: { kpis: AdsKpis; previousKpis: AdsKpis | null; campaigns: CampaignRow[]; previousCampaigns: CampaignRow[] | null };
  /** Revenue tab. */
  revenue: RevenueSummary;
  /** Maturing-data disclaimer state for this range (self-expiring; see lib/metrics/maturity.ts). */
  maturity: DataMaturity;
}

/** Read the two disclaimer dates and evaluate them for a range. */
export async function getMaturity(range: { start: string; end: string }, today: string): Promise<DataMaturity> {
  const [since, sunset] = await Promise.all([getSetting(SETTING_KEYS.historyCompleteSince), getSetting(SETTING_KEYS.disclaimerSunset)]);
  return computeMaturity({ range, today, historyCompleteSince: since, sunset });
}

export async function getScorecard(params: {
  range?: string | null;
  start?: string | null;
  end?: string | null;
  compare?: string | null;
  pipelineId?: string;
}): Promise<ScorecardResult> {
  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const range = rangeFromParams(params, today);
  const mode: ComparisonMode = comparisonFromParam(params.compare);
  const comparison = resolveComparison(range, mode, today);
  const baseline = trailingWeeks(range.start, 8);

  // Widest window needed by any computation below.
  const starts = [range.start, comparison.range?.start ?? range.start, baseline.start];
  const ends = [range.end, comparison.range?.end ?? range.end, baseline.end];
  const input = await loadMetricsInput({
    start: starts.reduce((a, b) => (a < b ? a : b)),
    end: ends.reduce((a, b) => (a > b ? a : b)),
    timezone,
    pipelineId: params.pipelineId,
  });

  const scorecard = computeScorecard(input, range, comparison.range, { start: baseline.start, end: baseline.end });

  const grain = trendGrain(range);
  const bucketsFor = (r: { start: string; end: string }) =>
    grain === 'week' ? weekBuckets(r.start, r.end) : dayBuckets(r.start, r.end).map((d) => ({ start: d.date, end: d.date, label: d.label }));

  return {
    timezone,
    today,
    range,
    comparison,
    baseline: { start: baseline.start, end: baseline.end },
    scorecard,
    trend: {
      grain,
      current: computeTrend(input, bucketsFor(range)),
      comparison: comparison.range ? computeTrend(input, bucketsFor(comparison.range)) : null,
    },
    trendWeekly: {
      current: computeTrend(input, weekBuckets(range.start, range.end)),
      comparison: comparison.range ? computeTrend(input, weekBuckets(comparison.range.start, comparison.range.end)) : null,
    },
    trailingWeeks: computeTrend(input, weekBuckets(baseline.start, baseline.end)),
    trendWeeklyCohort: {
      current: computeTrend(input, weekBuckets(range.start, range.end), 'cohort'),
      comparison: comparison.range ? computeTrend(input, weekBuckets(comparison.range.start, comparison.range.end), 'cohort') : null,
    },
    ads: {
      kpis: computeAdsKpis(input, range),
      previousKpis: comparison.range ? computeAdsKpis(input, comparison.range) : null,
      campaigns: computeCampaignTable(input, range),
      previousCampaigns: comparison.range ? computeCampaignTable(input, comparison.range) : null,
    },
    revenue: computeRevenueSummary(input, range),
    maturity: await getMaturity(range, today),
  };
}

/** Today's Day-1 / Day-3 call list, for the daily email and the Reports preview. */
export async function getTodoBuckets(todayOverride?: string): Promise<{ timezone: string; today: string; buckets: TodoBuckets; input: MetricsInput }> {
  const timezone = await getTimezone();
  const today = todayOverride ?? todayInTimezone(timezone);
  // Applied/no-shows within the last week are all the buckets can reference.
  const input = await loadMetricsInput({ start: addDaysLocal(today, -10), end: today, timezone });
  return { timezone, today, buckets: computeTodoBuckets(input, today), input };
}

function addDaysLocal(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// KPI trend popover
// ---------------------------------------------------------------------------

import { trendMetric, computeMetricTrend, trendWindow, type MetricTrend } from './trendMetrics';

/** One metric's trend (daily 30d or weekly 12w + the prior span) from the same engine as the tiles. */
export async function getMetricTrend(key: string, params: { pipelineId?: string } = {}): Promise<MetricTrend | null> {
  const metric = trendMetric(key);
  if (!metric) return null;
  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const window = trendWindow(metric, today);
  const input = await loadMetricsInput({ start: window.start, end: window.end, timezone, pipelineId: params.pipelineId });
  const trend = computeMetricTrend(metric, input, today);
  // The popover's "selected range" is the trend's current span.
  const maturity = await getMaturity(trend.span, today);
  return { ...trend, maturity, maturing: isMaturingMetric(metric.key, maturity) };
}
