import { NextRequest, NextResponse } from 'next/server';
import { db, syncRuns } from '@/db';
import { runGhlSync } from '@/lib/ghl/ingest';
import { runReconcile } from '@/lib/ghl/reconcile';
import { runMetaSync } from '@/lib/meta/ingest';
import { runStripeSync } from '@/lib/stripe/ingest';
import { runGoogleAdsSync } from '@/lib/googleads/ingest';
import { runInsights } from '@/lib/anthropic/insights';
import { runWeeklyNarrative } from '@/lib/anthropic/narrative';
import { runDigest } from '@/lib/email/send';
import { localHour, SEND_HOUR_LOCAL } from '@/lib/email/cron';
import { getTimezone } from '@/lib/settings';
import { todayInTimezone } from '@/lib/dates';
import { runDispatch, type DispatchStep, type StepOutcome } from '@/lib/dispatch';
import { sweepIncidentNoise } from '@/lib/incidents/noise';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/dispatch — the ONE scheduled job besides sync-ghl.
 *
 * Every step is isolated (lib/dispatch.ts): its own try/catch and timeout,
 * its own outcome row. Order = cheap and critical first, the long GHL walk
 * (budgeted, resumable) after, digests last:
 *   stripe → meta → google → ghl (20s budget) → reconcile → incident sweep
 *   → insights → narratives → daily / weekly / monthly digests
 * `?only=stripe,meta,google,ghl,reconcile,sweep,insights,narrative,daily,weekly,monthly`
 * limits the steps; `?force=1` bypasses the hour/day guards (never the secret).
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
  const gate = (ok: boolean, reason: string) => (ok ? null : reason);

  let ghlPartial = false;
  const steps: DispatchStep[] = [
    { name: 'stripe', ownsRun: true, run: () => runStripeSync({ mode: 'reconcile', trigger: 'cron' }) },
    { name: 'meta', ownsRun: true, run: () => runMetaSync({ mode: 'delta', trigger: 'cron' }) },
    { name: 'google', ownsRun: true, run: () => runGoogleAdsSync({ mode: 'delta', trigger: 'cron' }) },
    {
      name: 'ghl',
      ownsRun: true,
      timeoutMs: 30_000,
      run: async () => {
        const r = await runGhlSync({ mode: 'delta', trigger: 'cron', budgetMs: 20_000 });
        ghlPartial = r.partial;
        return r;
      },
    },
    { name: 'reconcile', run: async () => (ghlPartial ? { ok: true, skipped: 'GHL cycle still in progress — reconciling after it completes' } : runReconcile({ trigger: 'cron' })) },
    { name: 'sweep', run: () => sweepIncidentNoise() },
    { name: 'insights', run: () => runInsights({ range: 'this_week', compare: 'previous_period' }) },
    { name: 'narrative_weekly', skip: gate(force || dow === 1, 'not Monday'), run: () => runWeeklyNarrative('weekly', { force }) },
    { name: 'narrative_monthly', skip: gate(force || d === 1, 'not the 1st'), run: () => runWeeklyNarrative('monthly', { force }) },
    { name: 'daily', skip: gate(isSendHour, `before ${SEND_HOUR_LOCAL}am local`), run: () => runDigest('daily_todo', { force }) },
    { name: 'weekly', skip: gate(isSendHour && (force || dow === 1), dow === 1 ? `before ${SEND_HOUR_LOCAL}am local` : 'not Monday'), run: () => runDigest('weekly', { force }) },
    { name: 'monthly', skip: gate(isSendHour && (force || d === 1), d === 1 ? `before ${SEND_HOUR_LOCAL}am local` : 'not the 1st'), run: () => runDigest('monthly', { force }) },
  ].filter((s) => want(s.name === 'narrative_weekly' || s.name === 'narrative_monthly' ? 'narrative' : s.name));

  const record = async (name: string, outcome: StepOutcome) => {
    const status = outcome.status === 'succeeded' ? 'succeeded' : outcome.status === 'skipped' ? 'skipped' : 'failed';
    const finishedAt = new Date();
    await db.insert(syncRuns).values({
      kind: `dispatch:${name}`,
      trigger: 'cron',
      status,
      startedAt: new Date(finishedAt.getTime() - ('durationMs' in outcome ? outcome.durationMs : 0)),
      finishedAt,
      stats: 'durationMs' in outcome ? { durationMs: outcome.durationMs } : {},
      warnings: outcome.status === 'skipped' ? [outcome.reason] : [],
      error: 'error' in outcome ? outcome.error : null,
    });
  };

  const result = await runDispatch(steps, { record });
  return NextResponse.json({ ok: result.ok, timezone, today, localHour: hour, durationMs: result.durationMs, order: result.order, steps: result.steps }, { status: result.ok ? 200 : 500 });
}
