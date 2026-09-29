/**
 * Shared handler for the digest cron routes + the send-window rule the
 * dispatch uses.
 *
 * Vercel cron runs in UTC, so a fixed UTC time drifts an hour against the
 * business clock at every DST change. M1 (2026-09-29 audit): the Hobby
 * dispatch fires ~13:28 UTC = 7:28am MDT in summer but 6:28am MST from Nov 1,
 * which a "≥ 7am" guard would have skipped ALL winter. The window therefore
 * opens at 6am local and stays open for the rest of the day; runDigest's
 * per-(kind, period) idempotency guarantees exactly one send per day however
 * many runs land inside it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTimezone } from '../settings';
import { runDigest } from './send';
import type { DigestKind } from './digests';

/** Digests may send from this local hour on (was 7 until 2026-09-29 — see M1 above). */
export const SEND_WINDOW_START_LOCAL = 6;

export function localHour(now: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now);
  return Number(h) % 24;
}

/** Pure: is `now` inside today's send window in the business timezone? */
export function inSendWindow(now: Date, timezone: string): boolean {
  return localHour(now, timezone) >= SEND_WINDOW_START_LOCAL;
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
  const hour = localHour(now, timezone);
  if (!force && !inSendWindow(now, timezone)) {
    return NextResponse.json({ kind, skipped: `before ${SEND_WINDOW_START_LOCAL}am local`, localHour: hour, timezone });
  }

  const result = await runDigest(kind, { force });
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 });
}
