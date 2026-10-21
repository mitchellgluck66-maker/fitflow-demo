/**
 * Report schedule (2026-10-21 — "stage 3 schedules"): every report sends on the
 * FIRST :37 dispatch run after 00:00 business time and covers the period that
 * just ended. Pure: callers pass the instant, the timezone and the setting.
 *
 *   daily    → yesterday (00:00–23:59 local). Reports FOR a Saturday or a
 *              Sunday are skipped unless the owner setting "Include weekends"
 *              (`digest_include_weekends`) is on.
 *   weekly   → due on a Sunday, covering the Sun–Sat week that ended Saturday.
 *   monthly  → due on the 1st, covering the month that just ended.
 *
 * The local date comes from Intl in the business timezone, so a DST change
 * night (the clocks move at 2 am, after the 00:37 run) never shifts a period;
 * two runs inside the repeated hour of a fall-back night resolve to the same
 * local date and therefore the same period, and runDigest's per-(kind, period)
 * idempotency makes the second one `already_sent`. The 6 am window this
 * replaces lived in lib/email/cron.ts (M1, 2026-09-29).
 */

import { localDate, addDays, dayOfWeek, weekStart, monthStart, addMonths, formatLongDate, resolvePreset } from '../dates';
import { getDayBounds } from '../day';
import type { ReportKind } from '../reports/kinds';

/** The :37 dispatch plus a couple of minutes of steps — what the report cards show instead of a send-time field. */
export const SENDS_AT_TEXT = 'Sends ~12:40 am';

/** Meta restates a day's spend for up to this long after the day closes. */
export const META_SETTLING_HOURS = 48;

export interface ReportPeriod {
  start: string;
  end: string;
}

export interface ScheduleDecision {
  kind: ReportKind;
  /** Business-local calendar date of the run. */
  localDate: string;
  /** The period that most recently ended — computed whether or not the report is due. */
  period: ReportPeriod;
  due: boolean;
  /** Why it is not due (the dispatch's skip reason); null when due. */
  reason: string | null;
}

export function isWeekend(date: string): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/** The period each kind reports on when run on `localDate`: yesterday / the week that ended last Saturday / last month. */
export function periodEndedBefore(kind: ReportKind, localDay: string): ReportPeriod {
  if (kind === 'daily') {
    const y = addDays(localDay, -1);
    return { start: y, end: y };
  }
  if (kind === 'weekly') {
    const ws = weekStart(localDay);
    return { start: addDays(ws, -7), end: addDays(ws, -1) };
  }
  const ms = monthStart(localDay);
  return { start: addMonths(ms, -1), end: addDays(ms, -1) };
}

/** Pure: is `kind` due at `now`, and for which period? */
export function reportDecision(
  kind: ReportKind,
  now: Date,
  timezone: string,
  opts: { includeWeekends: boolean },
): ScheduleDecision {
  const localDay = localDate(now, timezone);
  const period = periodEndedBefore(kind, localDay);
  const base = { kind, localDate: localDay, period };

  if (kind === 'daily') {
    if (!opts.includeWeekends && isWeekend(period.start)) {
      return { ...base, due: false, reason: `weekend — the report for ${formatLongDate(period.start)} is skipped (Include weekends is off)` };
    }
    return { ...base, due: true, reason: null };
  }
  if (kind === 'weekly') {
    if (dayOfWeek(localDay) !== 0) {
      const nextSunday = addDays(weekStart(localDay), 7);
      return { ...base, due: false, reason: `not Sunday — the week ending ${formatLongDate(addDays(nextSunday, -1))} sends after midnight on ${formatLongDate(nextSunday)}` };
    }
    return { ...base, due: true, reason: null };
  }
  if (localDay.slice(8) !== '01') {
    const nextFirst = addMonths(monthStart(localDay), 1);
    return { ...base, due: false, reason: `not the 1st — this month sends after midnight on ${formatLongDate(nextFirst)}` };
  }
  return { ...base, due: true, reason: null };
}

/** The scorecard digests read `last_week` / `last_month` from the same local date — the two must agree. */
export function scorecardPresetPeriod(kind: 'weekly' | 'monthly', localDay: string): ReportPeriod {
  const r = resolvePreset(kind === 'weekly' ? 'last_week' : 'last_month', localDay);
  return { start: r.start, end: r.end };
}

/** Is Meta's figure for `day` (business-local) still settling when sent at `sentAt`? True inside 48 h of the day's close. */
export function metaSettling(day: string, timezone: string, sentAt: Date): boolean {
  const { endMs } = getDayBounds(day, timezone);
  return sentAt.getTime() - endMs < META_SETTLING_HOURS * 3_600_000;
}

/** One line per report card. */
export function scheduleText(kind: ReportKind, opts: { includeWeekends: boolean }): string {
  if (kind === 'daily') return `${SENDS_AT_TEXT} · covers yesterday${opts.includeWeekends ? ' · every day' : ' · weekends off'}`;
  if (kind === 'weekly') return `Sundays · ${SENDS_AT_TEXT} · the Sun–Sat week just ended`;
  return `1st of the month · ${SENDS_AT_TEXT} · the month just ended`;
}

/** The :37 dispatch after midnight — the first eligible run of a local day, as an instant. */
export function firstRunOfDay(localDay: string, timezone: string): Date {
  return new Date(getDayBounds(localDay, timezone).startMs + 37 * 60_000);
}

/** Pure: the next local day on which `kind` is due after `now` (≤ 62 days ahead), and the period it will cover. */
export function nextSend(kind: ReportKind, now: Date, timezone: string, opts: { includeWeekends: boolean }): { date: string; at: Date; period: ReportPeriod } | null {
  let day = localDate(now, timezone);
  for (let i = 0; i < 62; i += 1) {
    day = addDays(day, 1);
    const d = reportDecision(kind, firstRunOfDay(day, timezone), timezone, opts);
    if (d.due) return { date: day, at: firstRunOfDay(day, timezone), period: d.period };
  }
  return null;
}
