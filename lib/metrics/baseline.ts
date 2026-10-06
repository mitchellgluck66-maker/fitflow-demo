/**
 * THE baseline rule (2026-10-06, after the Oct 4 smoke: two runs on the same data read "a normal week"
 * and "double your normal week" because an 8-week enrollment baseline was built from GHL stage history
 * that is incomplete before `history_complete_since` — entered-Enrolled per week 0, 1, 2, 12 (a catch-up)
 * where Stripe first payments read 6, 3, 1, 5).
 *
 * One function, every caller: the chips' baseline in `computeScorecard`, `get_scorecard.baseline` (and so the
 * starter snapshot), the brief's 8/12-week baselines, the insight and ask contexts. For a HISTORY-DEPENDENT
 * metric (everything derived from a GHL stage entry — `lib/metrics/maturity.ts#HISTORY_DEPENDENT_METRICS`)
 * the weeks that start before `history_complete_since` are EXCLUDED, not flagged; for a metric dated by its
 * own source (Stripe cash and new paying clients, Meta spend, calendar outcomes) every complete week counts.
 * Fewer than `BASELINE_MIN_WEEKS` usable weeks → no number, a note every consumer renders instead:
 * "baseline needs 4 complete weeks of complete stage history; have 2 (Sep 6–19)". After the disclaimer's
 * sunset nothing is excluded (self-expiring, like the badge). PURE.
 */

import { formatRangeLabel, trailingWeeks, type WeekBucket } from '../dates';
import { HISTORY_DEPENDENT_METRICS, MATURITY_DEFAULTS } from './maturity';
import { computeFunnel, computeRevenue, computeSpend, inReportingCurrency, type MetricsInput, type Range } from './index';

export const BASELINE_WEEKS = 8;
export const BASELINE_MIN_WEEKS = 4;

/** The two baseline families: what a GHL stage entry dates, and what a source dates itself. */
export type BaselineFamily = 'stage_history' | 'source_dated';

export function baselineFamilyOf(metric: string): BaselineFamily {
  return HISTORY_DEPENDENT_METRICS.has(metric) || metric === 'conversions' || metric === 'funnel' ? 'stage_history' : 'source_dated';
}

export interface CleanBaseline {
  metric: string;
  family: BaselineFamily;
  /** Every candidate week (the trailing N complete Sun–Sat weeks), for the trend callers. */
  candidate: WeekBucket[];
  /** The weeks the baseline is built from (a contiguous trailing block). */
  weeks: WeekBucket[];
  /** Weeks excluded because they start before complete stage history (empty for a source-dated metric or after the sunset). */
  excluded: WeekBucket[];
  /** The contiguous range of `weeks`; null when not enough. */
  range: Range | null;
  enough: boolean;
  /** Why there is no number, or null. */
  note: string | null;
  /** One line for tool results and the brief: "8 weeks (Aug 2 – Sep 26)" / "4 weeks (Sep 6 – Oct 3) · 4 maturing weeks excluded (Aug 9 – Sep 5)". */
  summary: string;
}

export interface BaselineSettings {
  historyCompleteSince?: string | null;
  sunset?: string | null;
  today: string;
}

/** The clean baseline for `metric` over the given candidate weeks (complete Sun–Sat weeks, oldest first). */
export function cleanBaseline(p: { candidate: WeekBucket[]; metric: string; minWeeks?: number } & BaselineSettings): CleanBaseline {
  const minWeeks = p.minWeeks ?? BASELINE_MIN_WEEKS;
  const hcs = p.historyCompleteSince || MATURITY_DEFAULTS.historyCompleteSince;
  const sunset = p.sunset || MATURITY_DEFAULTS.disclaimerSunset;
  const family = baselineFamilyOf(p.metric);
  const exclude = family === 'stage_history' && p.today < sunset;
  const weeks = exclude ? p.candidate.filter((w) => w.start >= hcs) : [...p.candidate];
  const excluded = exclude ? p.candidate.filter((w) => w.start < hcs) : [];
  const enough = weeks.length >= minWeeks;
  const span = (ws: WeekBucket[]) => (ws.length ? formatRangeLabel(ws[0].start, ws[ws.length - 1].end) : '');
  const have = weeks.length ? `have ${weeks.length} (${span(weeks)})` : 'have 0';
  const note = enough ? null : `baseline needs ${minWeeks} complete weeks${family === 'stage_history' ? ' of complete stage history' : ''}; ${have}`;
  const summary = enough
    ? `${weeks.length} weeks (${span(weeks)})${excluded.length ? ` · ${excluded.length} maturing week${excluded.length === 1 ? '' : 's'} excluded (${span(excluded)})` : ''}`
    : `${note}${excluded.length ? ` · ${excluded.length} maturing week${excluded.length === 1 ? '' : 's'} excluded (${span(excluded)})` : ''}`;
  return { metric: p.metric, family, candidate: p.candidate, weeks, excluded, range: enough ? { start: weeks[0].start, end: weeks[weeks.length - 1].end } : null, enough, note, summary };
}

/** The trailing `n` complete weeks before `date`, cleaned for `metric`. */
export function trailingBaseline(p: { before: string; metric: string; n?: number; minWeeks?: number } & BaselineSettings): CleanBaseline {
  const t = trailingWeeks(p.before, p.n ?? BASELINE_WEEKS);
  return cleanBaseline({ candidate: t.weeks, metric: p.metric, minWeeks: p.minWeeks, historyCompleteSince: p.historyCompleteSince, sunset: p.sunset, today: p.today });
}

/** Per-week averages over a clean baseline — the numbers a "normal week" is judged against. */
export interface BaselineAverages {
  weeksUsed: number;
  weeksExcluded: number;
  summary: string;
  note: string | null;
  /** Stage-history family (null when not enough). */
  enrollmentsPerWeek: number | null;
  /** Source-dated family (Stripe / Meta). */
  newPayingClientsPerWeek: number | null;
  initialCashPerWeekCents: number | null;
  spendPerWeekCents: number | null;
}

export interface ScorecardBaselines {
  /** For everything a GHL stage entry dates: enrollments, consults, roadmaps, CAC, conversions. */
  stageHistory: CleanBaseline;
  /** For what a source dates itself: Stripe cash and new paying clients, Meta spend. */
  sourceDated: CleanBaseline;
  averages: BaselineAverages;
}

/** Build both baselines before a range and the averages the verdict and the snapshot cite. */
export function scorecardBaselines(raw: MetricsInput, range: Range, settings: BaselineSettings): ScorecardBaselines {
  const input = inReportingCurrency(raw);
  const stageHistory = trailingBaseline({ before: range.start, metric: 'enrollments', ...settings });
  const sourceDated = trailingBaseline({ before: range.start, metric: 'initial_cash', ...settings });
  const avg = (ws: WeekBucket[], f: (w: WeekBucket) => number) => (ws.length ? ws.reduce((a, w) => a + f(w), 0) / ws.length : null);
  const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
  const enrolled = (w: WeekBucket) => computeFunnel(input, { start: w.start, end: w.end }).stages.find((s) => s.key === 'enrolled')?.count ?? 0;
  const stripe = sourceDated.weeks.map((w) => computeRevenue(input, { start: w.start, end: w.end }));
  const anyStripe = stripe.some((r) => !r.awaitingStripe);
  const averages: BaselineAverages = {
    weeksUsed: stageHistory.weeks.length,
    weeksExcluded: stageHistory.excluded.length,
    summary: stageHistory.summary,
    note: stageHistory.note,
    enrollmentsPerWeek: stageHistory.enough ? r2(avg(stageHistory.weeks, enrolled)) : null,
    newPayingClientsPerWeek: sourceDated.enough && anyStripe ? r2(stripe.reduce((a, r) => a + r.initialCount, 0) / stripe.length) : null,
    initialCashPerWeekCents: sourceDated.enough && anyStripe ? Math.round(stripe.reduce((a, r) => a + r.initialCents, 0) / stripe.length) : null,
    spendPerWeekCents: sourceDated.enough ? Math.round(sourceDated.weeks.reduce((a, w) => a + computeSpend(input.spend, { start: w.start, end: w.end }, input.money), 0) / sourceDated.weeks.length) : null,
  };
  return { stageHistory, sourceDated, averages };
}

