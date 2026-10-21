/**
 * Shared handler for the per-job digest cron routes + the schedule gate the
 * dispatch uses (lib/email/schedule.ts holds the pure rule).
 *
 * 2026-10-21: every report sends on the first :37 run after 00:00 business
 * time and covers the period that just ended — daily = yesterday (weekends
 * off by default), weekly = Sunday for the Sun–Sat week just ended, monthly =
 * the 1st for the month just ended. This replaces the 6 am local window (M1,
 * 2026-09-29): with the window gone, DST no longer matters to WHETHER a run
 * sends — only the local calendar date does, and runDigest's per-(kind,
 * period) idempotency keeps it to one send per period however many runs land.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTimezone } from '../settings';
import { runDigest, includeWeekends } from './send';
import { reportDecision, type ScheduleDecision } from './schedule';
import type { DigestKind } from './digests';

export function localHour(now: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now);
  return Number(h) % 24;
}

/** The schedule decision for `kind` at `now`, with the timezone and the weekend setting resolved. */
export async function decideReport(kind: DigestKind, now: Date, timezone?: string): Promise<ScheduleDecision> {
  const [tz, weekends] = await Promise.all([timezone ? Promise.resolve(timezone) : getTimezone(), includeWeekends()]);
  return reportDecision(kind, now, tz, { includeWeekends: weekends });
}

export async function handleDigestCron(request: NextRequest, kind: DigestKind): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    if ((request.headers.get('authorization') ?? '') !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  }

  const force = request.nextUrl.searchParams.get('force') === '1';
  const timezone = await getTimezone();
  const now = new Date();
  const decision = await decideReport(kind, now, timezone);
  if (!force && !decision.due) {
    return NextResponse.json({ kind, skipped: decision.reason, localDate: decision.localDate, period: decision.period, timezone });
  }

  const result = await runDigest(kind, { force });
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 });
}
