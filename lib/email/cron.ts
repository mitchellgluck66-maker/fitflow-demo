/**
 * Shared handler for the digest cron routes.
 *
 * Vercel cron runs in UTC; 7am in the business timezone floats between 11:00
 * and 12:00 UTC across DST, so vercel.json fires at both hours and this
 * handler only proceeds when it is actually 7 o'clock locally. runDigest's
 * per-period idempotency guarantees a single send even if both fire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTimezone } from '../settings';
import { runDigest } from './send';
import type { DigestKind } from './digests';

export const SEND_HOUR_LOCAL = 7;

export function localHour(now: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now);
  return Number(h) % 24;
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
  const hour = localHour(new Date(), timezone);
  if (!force && hour !== SEND_HOUR_LOCAL) {
    return NextResponse.json({ kind, skipped: 'not 7am local', localHour: hour, timezone });
  }

  const result = await runDigest(kind, { force });
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 });
}
