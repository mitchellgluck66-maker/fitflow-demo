/** Companion stage 3 — the period of a report kind that CONTAINS a date (previews, the script). Pure. */

import { addDays, monthEnd, weekEnd } from '../dates';
import { periodEndedBefore } from '../email/schedule';
import type { ReportKind } from './kinds';

export function periodContaining(kind: ReportKind, date: string): { start: string; end: string } {
  if (kind === 'daily') return { start: date, end: date };
  // periodEndedBefore(kind, d) = the period that ended before d → the one containing `date` ends at its week / month end.
  const end = kind === 'weekly' ? weekEnd(date) : monthEnd(date);
  return periodEndedBefore(kind, addDays(end, 1));
}
