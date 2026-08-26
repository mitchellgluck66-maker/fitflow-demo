/**
 * Date-range + comparison engine (CLAUDE.md rule 2).
 *
 * Everything here works on plain calendar dates ("YYYY-MM-DD") in the
 * BUSINESS timezone. Weeks are ALWAYS Sunday–Saturday (Meta Ads convention).
 * The only place a timezone is consulted is when a calendar date must become
 * an absolute instant (`rangeToInstants`) or when "today" is resolved
 * (`todayInTimezone`) — never UTC.
 *
 * Pure: no Date.now() inside; callers pass `today`.
 */

import { getDayBounds, todayInTimezone, addDays } from '../day';

export { todayInTimezone, addDays };

export type Preset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'last_30_days'
  | 'custom';

export type ComparisonMode = 'previous_period' | 'last_year' | 'off';

export interface DateRange {
  /** Inclusive YYYY-MM-DD. */
  start: string;
  /** Inclusive YYYY-MM-DD. */
  end: string;
  preset: Preset;
  /** e.g. "Last week" */
  presetLabel: string;
  /** e.g. "Aug 17–23" */
  resolvedLabel: string;
}

export interface Comparison {
  mode: ComparisonMode;
  range: DateRange | null;
  /** e.g. "vs previous period · Aug 10–16" */
  label: string;
}

export const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' },
];

export const COMPARISONS: Array<{ value: ComparisonMode; label: string }> = [
  { value: 'previous_period', label: 'vs previous period' },
  { value: 'last_year', label: 'vs same period last year' },
  { value: 'off', label: 'No comparison' },
];

const PRESET_LABEL = Object.fromEntries(PRESETS.map((p) => [p.value, p.label])) as Record<Preset, string>;

// ---------------------------------------------------------------------------
// Calendar primitives (UTC-anchored arithmetic on plain dates — no tz needed)
// ---------------------------------------------------------------------------

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(date: string): Date {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d));
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return utc(date).getUTCDay();
}

/** Sunday that starts the Sun–Sat week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -dayOfWeek(date));
}

/** Saturday that ends the Sun–Sat week containing `date`. */
export function weekEnd(date: string): string {
  return addDays(weekStart(date), 6);
}

export function monthStart(date: string): string {
  const { y, m } = parts(date);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

export function monthEnd(date: string): string {
  const { y, m } = parts(date);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export function addMonths(date: string, months: number): string {
  const { y, m, d } = parts(date);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return fromUtc(target);
}

/** Inclusive day count. */
export function daysBetween(start: string, end: string): number {
  return Math.round((utc(end).getTime() - utc(start).getTime()) / 86_400_000) + 1;
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { y, m, d } = parts(value);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDay(date: string, withYear = false): string {
  const { y, m, d } = parts(date);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/**
 * "Aug 17–23" · "Aug 30 – Sep 5" · "Dec 28, 2025 – Jan 3, 2026" · "Aug 26".
 * Year is shown only when the range is not in `referenceYear`.
 */
export function formatRangeLabel(start: string, end: string, referenceYear?: number): string {
  const s = parts(start);
  const e = parts(end);
  const showYear = referenceYear !== undefined && (s.y !== referenceYear || e.y !== referenceYear);
  if (start === end) return fmtDay(start, showYear);
  if (s.y === e.y && s.m === e.m) return `${MONTHS[s.m - 1]} ${s.d}–${e.d}${showYear ? `, ${s.y}` : ''}`;
  if (s.y === e.y) return `${fmtDay(start)} – ${fmtDay(end, showYear)}`;
  return `${fmtDay(start, true)} – ${fmtDay(end, true)}`;
}

/** "Sunday, Aug 17, 2026" style for tooltips. */
export function formatLongDate(date: string): string {
  const d = utc(date);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${day}, ${fmtDay(date, true)}`;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export function resolvePreset(
  preset: Preset,
  today: string,
  custom?: { start: string; end: string },
): DateRange {
  let start: string;
  let end: string;

  switch (preset) {
    case 'today':
      start = end = today;
      break;
    case 'yesterday':
      start = end = addDays(today, -1);
      break;
    case 'this_week':
      start = weekStart(today);
      end = weekEnd(today);
      break;
    case 'last_week':
      start = addDays(weekStart(today), -7);
      end = addDays(start, 6);
      break;
    case 'this_month':
      start = monthStart(today);
      end = monthEnd(today);
      break;
    case 'last_month': {
      const prev = addMonths(monthStart(today), -1);
      start = monthStart(prev);
      end = monthEnd(prev);
      break;
    }
    case 'last_30_days':
      start = addDays(today, -29);
      end = today;
      break;
    case 'custom': {
      if (!custom || !isValidDate(custom.start) || !isValidDate(custom.end)) {
        return resolvePreset('last_30_days', today);
      }
      start = custom.start <= custom.end ? custom.start : custom.end;
      end = custom.start <= custom.end ? custom.end : custom.start;
      break;
    }
  }

  const year = parts(today).y;
  return {
    start,
    end,
    preset,
    presetLabel: PRESET_LABEL[preset],
    resolvedLabel: formatRangeLabel(start, end, year),
  };
}

/** Parse URL/search params into a range. Unknown → last_30_days. */
export function rangeFromParams(
  params: { range?: string | null; start?: string | null; end?: string | null },
  today: string,
): DateRange {
  const preset = (PRESETS.some((p) => p.value === params.range) ? params.range : 'last_30_days') as Preset;
  if (preset === 'custom' || (params.start && params.end && !params.range)) {
    return resolvePreset('custom', today, { start: params.start ?? '', end: params.end ?? '' });
  }
  return resolvePreset(preset, today);
}

// ---------------------------------------------------------------------------
// Comparison ranges
// ---------------------------------------------------------------------------

/**
 * Previous period: for week presets the previous Sun–Sat week(s); for month
 * presets the previous calendar month; otherwise the same number of days
 * immediately before `start`.
 */
export function previousPeriod(range: DateRange, today: string): DateRange {
  let start: string;
  let end: string;

  if (range.preset === 'this_week' || range.preset === 'last_week') {
    start = addDays(range.start, -7);
    end = addDays(range.end, -7);
  } else if (range.preset === 'this_month' || range.preset === 'last_month') {
    const prev = addMonths(range.start, -1);
    start = monthStart(prev);
    end = monthEnd(prev);
  } else {
    const len = daysBetween(range.start, range.end);
    end = addDays(range.start, -1);
    start = addDays(end, -(len - 1));
  }

  return {
    start,
    end,
    preset: 'custom',
    presetLabel: 'Previous period',
    resolvedLabel: formatRangeLabel(start, end, parts(today).y),
  };
}

/**
 * Same period last year: week presets shift by 52 weeks (364 days) so the
 * comparison is still a Sun–Sat week; month presets use the same calendar
 * month; everything else shifts the calendar dates back one year.
 */
export function samePeriodLastYear(range: DateRange, today: string): DateRange {
  let start: string;
  let end: string;

  if (range.preset === 'this_week' || range.preset === 'last_week') {
    start = addDays(range.start, -364);
    end = addDays(range.end, -364);
  } else if (range.preset === 'this_month' || range.preset === 'last_month') {
    const prev = addMonths(range.start, -12);
    start = monthStart(prev);
    end = monthEnd(prev);
  } else {
    start = addMonths(range.start, -12);
    end = addMonths(range.end, -12);
  }

  return {
    start,
    end,
    preset: 'custom',
    presetLabel: 'Same period last year',
    resolvedLabel: formatRangeLabel(start, end, parts(today).y),
  };
}

export function resolveComparison(range: DateRange, mode: ComparisonMode, today: string): Comparison {
  if (mode === 'off') return { mode, range: null, label: 'No comparison' };
  const cmp = mode === 'previous_period' ? previousPeriod(range, today) : samePeriodLastYear(range, today);
  return {
    mode,
    range: cmp,
    label: `${mode === 'previous_period' ? 'vs previous period' : 'vs same period last year'} · ${cmp.resolvedLabel}`,
  };
}

export function comparisonFromParam(value: string | null | undefined): ComparisonMode {
  return value === 'last_year' || value === 'off' ? value : 'previous_period';
}

// ---------------------------------------------------------------------------
// Week buckets
// ---------------------------------------------------------------------------

export interface WeekBucket {
  /** Sunday, YYYY-MM-DD. */
  start: string;
  /** Saturday, YYYY-MM-DD. */
  end: string;
  label: string;
}

/** Every Sun–Sat week that overlaps [start, end], in order. */
export function weekBuckets(start: string, end: string): WeekBucket[] {
  const out: WeekBucket[] = [];
  let cursor = weekStart(start);
  while (cursor <= end) {
    const wEnd = addDays(cursor, 6);
    out.push({ start: cursor, end: wEnd, label: formatRangeLabel(cursor, wEnd) });
    cursor = addDays(cursor, 7);
  }
  return out;
}

/** The N complete Sun–Sat weeks immediately before the week containing `date`. */
export function trailingWeeks(date: string, n: number): { start: string; end: string; weeks: WeekBucket[] } {
  const end = addDays(weekStart(date), -1);
  const start = addDays(end, -(7 * n - 1));
  return { start, end, weeks: weekBuckets(start, end) };
}

/** Which Sun–Sat week does this local calendar date belong to? */
export function weekKey(date: string): string {
  return weekStart(date);
}

export interface DayBucket {
  date: string;
  label: string;
}

export function dayBuckets(start: string, end: string): DayBucket[] {
  const out: DayBucket[] = [];
  let cursor = start;
  while (cursor <= end) {
    out.push({ date: cursor, label: fmtDay(cursor) });
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Choose day vs week granularity for a trend chart. */
export function trendGrain(range: DateRange): 'day' | 'week' {
  return daysBetween(range.start, range.end) > 31 ? 'week' : 'day';
}

// ---------------------------------------------------------------------------
// Instants (the only place the timezone matters)
// ---------------------------------------------------------------------------

export interface Instants {
  startMs: number;
  endMs: number;
  start: Date;
  end: Date;
}

export function rangeToInstants(range: { start: string; end: string }, timezone: string): Instants {
  const { startMs } = getDayBounds(range.start, timezone);
  const { endMs } = getDayBounds(range.end, timezone);
  return { startMs, endMs, start: new Date(startMs), end: new Date(endMs) };
}

/** Local calendar date (YYYY-MM-DD) of an instant in the business timezone. */
export function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}
