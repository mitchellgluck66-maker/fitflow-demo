import { NextRequest, NextResponse } from 'next/server';
import { runGhlSync } from '@/lib/ghl/ingest';
import { runMetaSync } from '@/lib/meta/ingest';
import { runStripeSync } from '@/lib/stripe/ingest';
import { runDigest } from '@/lib/email/send';
import { localHour, SEND_HOUR_LOCAL } from '@/lib/email/cron';
import { getTimezone } from '@/lib/settings';
import { todayInTimezone } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/dispatch — the ONE scheduled job besides the hourly GHL sync.
 *
 * Vercel Hobby allows two cron jobs, so everything else funnels through here.
 * vercel.json fires it at 11:00 and 12:00 UTC (7am business-local floats
 * across DST); each step guards itself:
 *   1. GHL delta sync        — always (idempotent)
 *   2. Meta insights delta   — always when configured (restates last 3 days)
 *   3. Stripe reconcile      — always when configured (last 7 days)
 *   4. Daily to-do digest    — only at 7am local; idempotent per day
 *   5. Weekly scorecard      — only Mondays at 7am local; idempotent per week
 *   6. Monthly scorecard     — only the 1st at 7am local; idempotent per month
 * `?only=ghl,meta,stripe,daily,weekly,monthly` limits the steps; `?force=1`
 * bypasses the hour/day guards (never the secret).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    if ((request.headers.get('authorization') ?? '') !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  }

  const force = request.nextUrl.searchParams.get('force') === '1';
  const only = new Set((request.nextUrl.searchParams.get('only') ?? '').split(',').filter(Boolean));
  const want = (step: string) => only.size === 0 || only.has(step);

  const timezone = await getTimezone();
  const now = new Date();
  const hour = localHour(now, timezone);
  const today = todayInTimezone(timezone);
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 1 = Monday
  const isSendHour = force || hour === SEND_HOUR_LOCAL;

  const steps: Record<string, unknown> = {};
  const startedAt = Date.now();

  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      steps[name] = await fn();
    } catch (err) {
      steps[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  if (want('ghl')) await run('ghl', () => runGhlSync({ mode: 'delta', trigger: 'cron' }));
  if (want('meta')) await run('meta', () => runMetaSync({ mode: 'delta', trigger: 'cron' }));
  if (want('stripe')) await run('stripe', () => runStripeSync({ mode: 'reconcile', trigger: 'cron' }));

  if (want('daily')) {
    steps.daily = isSendHour ? await runDigest('daily_todo', { force }) : { skipped: 'not 7am local', localHour: hour };
  }
  if (want('weekly')) {
    steps.weekly =
      isSendHour && (force || dow === 1) ? await runDigest('weekly', { force }) : { skipped: dow === 1 ? 'not 7am local' : 'not Monday', localHour: hour };
  }
  if (want('monthly')) {
    steps.monthly =
      isSendHour && (force || d === 1) ? await runDigest('monthly', { force }) : { skipped: d === 1 ? 'not 7am local' : 'not the 1st', localHour: hour };
  }

  const failed = Object.values(steps).some((s) => s && typeof s === 'object' && 'ok' in s && (s as { ok: unknown }).ok === false && !('notConfigured' in s && (s as { notConfigured: unknown }).notConfigured));

  return NextResponse.json(
    { ok: !failed, timezone, today, localHour: hour, durationMs: Date.now() - startedAt, steps },
    { status: failed ? 500 : 200 },
  );
}
