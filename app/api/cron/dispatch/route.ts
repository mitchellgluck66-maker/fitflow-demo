import { NextRequest, NextResponse } from 'next/server';
import { runGhlSync } from '@/lib/ghl/ingest';
import { runMetaSync } from '@/lib/meta/ingest';
import { runStripeSync } from '@/lib/stripe/ingest';
import { runGoogleAdsSync } from '@/lib/googleads/ingest';
import { runInsights } from '@/lib/anthropic/insights';
import { runWeeklyNarrative } from '@/lib/anthropic/narrative';
import { runDigest } from '@/lib/email/send';
import { localHour, SEND_HOUR_LOCAL } from '@/lib/email/cron';
import { getTimezone } from '@/lib/settings';
import { todayInTimezone } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/dispatch — the ONE scheduled job besides the hourly GHL sync.
 *
 * Vercel Hobby allows two cron jobs, each at most once a day, so everything
 * else funnels through here. vercel.json fires it once daily (13:00 UTC);
 * each step guards itself:
 *   1. GHL delta sync        — always (idempotent)
 *   2. Meta insights delta   — always when configured (restates last 3 days)
 *   3. Stripe reconcile      — always when configured (last 7 days)
 *   4. Google Ads delta      — always when configured (OAuth granted)
 *   5. Insights (Anthropic)  — this week vs previous, cached by input hash
 *   6. Weekly/monthly narrative — generated ahead of the Monday / 1st emails
 *   7. Daily to-do digest    — at/after 7am local; idempotent per day
 *   8. Weekly scorecard      — Mondays at/after 7am local; idempotent per week
 *   9. Monthly scorecard     — the 1st at/after 7am local; idempotent per month
 * "At/after" rather than "exactly": a once-daily cron cannot land on 7:00
 * sharp in every DST regime, and runDigest's per-period idempotency means
 * the first dispatch after 7am is the only one that sends.
 * `?only=ghl,meta,stripe,google,insights,narrative,daily,weekly,monthly`
 * limits the steps; `?force=1`
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
  const isSendHour = force || hour >= SEND_HOUR_LOCAL;

  const steps: Record<string, unknown> = {};
  const startedAt = Date.now();

  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      steps[name] = await fn();
    } catch (err) {
      steps[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // The GHL delta is resumable (lib/ghl/ingest.ts): it does what fits in the
  // budget and the next dispatch / sync-ghl invocation continues the cycle.
  if (want('ghl')) await run('ghl', () => runGhlSync({ mode: 'delta', trigger: 'cron', budgetMs: 20_000 }));
  if (want('meta')) await run('meta', () => runMetaSync({ mode: 'delta', trigger: 'cron' }));
  if (want('stripe')) await run('stripe', () => runStripeSync({ mode: 'reconcile', trigger: 'cron' }));
  if (want('google')) await run('google', () => runGoogleAdsSync({ mode: 'delta', trigger: 'cron' }));

  // Intelligence: cheap when nothing changed (cached by input hash), silent
  // without a key. Narratives are prepared the same morning the email goes.
  if (want('insights')) await run('insights', () => runInsights({ range: 'this_week', compare: 'previous_period' }));
  if (want('narrative')) {
    if (force || dow === 1) await run('narrative_weekly', () => runWeeklyNarrative('weekly', { force }));
    if (force || d === 1) await run('narrative_monthly', () => runWeeklyNarrative('monthly', { force }));
  }

  if (want('daily')) {
    steps.daily = isSendHour ? await runDigest('daily_todo', { force }) : { skipped: 'before 7am local', localHour: hour };
  }
  if (want('weekly')) {
    steps.weekly =
      isSendHour && (force || dow === 1) ? await runDigest('weekly', { force }) : { skipped: dow === 1 ? 'before 7am local' : 'not Monday', localHour: hour };
  }
  if (want('monthly')) {
    steps.monthly =
      isSendHour && (force || d === 1) ? await runDigest('monthly', { force }) : { skipped: d === 1 ? 'before 7am local' : 'not the 1st', localHour: hour };
  }

  const failed = Object.values(steps).some((s) => s && typeof s === 'object' && 'ok' in s && (s as { ok: unknown }).ok === false && !('notConfigured' in s && (s as { notConfigured: unknown }).notConfigured));

  return NextResponse.json(
    { ok: !failed, timezone, today, localHour: hour, durationMs: Date.now() - startedAt, steps },
    { status: failed ? 500 : 200 },
  );
}
