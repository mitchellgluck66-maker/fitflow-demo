/** Companion stage 3 — build any report for its period (the dispatcher the runner, the preview and the script use). */

import { buildDailyReport, type DailyDeps } from './daily';
import { buildWeeklyReport } from './weekly';
import { buildMonthlyReport } from './monthly';
import { renderReport, type ReportModel } from './model';
import type { ReportKind } from './kinds';

export interface BuiltReport {
  model: ReportModel;
  html: string;
  text: string;
}

export async function buildReport(kind: ReportKind, period: { start: string; end: string }, opts: { now?: Date; timezone?: string; deps?: DailyDeps } = {}): Promise<BuiltReport> {
  const model =
    kind === 'daily'
      ? await buildDailyReport({ date: period.start, now: opts.now, timezone: opts.timezone }, opts.deps)
      : kind === 'weekly'
        ? await buildWeeklyReport({ start: period.start, now: opts.now, timezone: opts.timezone }, opts.deps)
        : await buildMonthlyReport({ start: period.start, now: opts.now, timezone: opts.timezone }, opts.deps);
  return { model, ...renderReport(model) };
}
