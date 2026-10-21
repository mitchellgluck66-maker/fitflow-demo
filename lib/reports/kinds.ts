/**
 * Companion stage 3, item 2 — the three reports (Daily / Weekly / Monthly), each independently on/off. They
 * replace the digests `daily_todo` / `weekly` / `monthly` (the archive keeps the old rows under their old kind).
 */

export type ReportKind = 'daily' | 'weekly' | 'monthly';
export const REPORT_KINDS: readonly ReportKind[] = ['daily', 'weekly', 'monthly'];

export const REPORT_LABELS: Record<ReportKind, string> = { daily: 'Daily report', weekly: 'Weekly report', monthly: 'Monthly report' };

/** Archive rows written before stage 3 keep their kind; the UI labels them. */
export const LEGACY_KIND_LABELS: Record<string, string> = { daily_todo: 'Daily to-do (retired)', weekly: 'Weekly report', monthly: 'Monthly report' };

export function isReportKind(v: unknown): v is ReportKind {
  return v === 'daily' || v === 'weekly' || v === 'monthly';
}

/** Accepts the retired digest name too (old links, the per-job cron route). */
export function reportKindOf(v: unknown): ReportKind | null {
  if (v === 'daily_todo') return 'daily';
  return isReportKind(v) ? v : null;
}

/** Settings keys per report (migration 0023 copies the digest rows that were stored explicitly). */
export const REPORT_SETTING_KEYS = {
  daily: { enabled: 'report_daily_enabled', recipients: 'report_daily_recipients' },
  weekly: { enabled: 'report_weekly_enabled', recipients: 'report_weekly_recipients' },
  monthly: { enabled: 'report_monthly_enabled', recipients: 'report_monthly_recipients' },
} as const;

/** The page each report's button opens. */
export function reportPagePath(kind: ReportKind, period: { start: string; end: string }): string {
  if (kind === 'daily') return `/onboarding?range=day&date=${period.start}`;
  if (kind === 'weekly') return `/scorecard?range=week&start=${period.start}&compare=previous_period`;
  return `/scorecard?range=month&start=${period.start}&compare=previous_period`;
}
