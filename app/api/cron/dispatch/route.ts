import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db, syncRuns, syncLocks } from '@/db';
import { runGhlSync, GHL_LOCK } from '@/lib/ghl/ingest';
import { readMarker } from '@/lib/sync/markers';
import { runReconcile } from '@/lib/ghl/reconcile';
import { runMetaSync } from '@/lib/meta/ingest';
import { runMetaTokenCheck } from '@/lib/meta/token';
import { runScheduledStripeSync } from '@/lib/stripe/ingest';
import { runStripeCompleteness } from '@/lib/stripe/completeness';
import { runFxSync } from '@/lib/fx/boc';
import { runGoogleAdsSync } from '@/lib/googleads/ingest';
import { runInsights, INSIGHT_MIN_INTERVAL_MS } from '@/lib/anthropic/insights';
import { runWeeklyNarrative } from '@/lib/anthropic/narrative';
import { runDigest } from '@/lib/email/send';
import { inSendWindow, localHour, SEND_WINDOW_START_LOCAL } from '@/lib/email/cron';
import { getSetting, getTimezone, SETTING_KEYS } from '@/lib/settings';
import { todayInTimezone } from '@/lib/dates';
import {
  runDispatch, statsForOutcome, orderSteps, nextDispatchState, assessDispatch, ghlFallbackGate, reconcileGate,
  type DispatchStep, type StepOutcome,
} from '@/lib/dispatch';
import { readDispatchState, writeDispatchState, syncStuckIncidents } from '@/lib/dispatchState';
import { recordScheduledRun, schedulerVia } from '@/lib/sync/scheduler';
import { sweepIncidentNoise } from '@/lib/incidents/noise';
import { runNightlyPrune } from '@/lib/syncRunsPrune';
import { runUtmBackfill } from '@/lib/attribution/utmBackfill';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/dispatch — the ONE scheduled job besides sync-ghl.
 *
 * Callers: the Vercel Pro cron hourly at :37 (primary, vercel.json) and the GitHub Actions heartbeat every 6 h
 * (fallback). Every call records itself for the scheduler-silent check (lib/sync/scheduler.ts).
 *
 * Every step is isolated (lib/dispatch.ts): its own try/catch and timeout,
 * its own outcome row. Since 2026-09-30:
 *   - ORDER is fair, not fixed: never-succeeded / starved steps first, then
 *     least-recently-successful (`orderSteps` over settings.dispatch_state);
 *     `after` keeps a narrative ahead of its digest and reconcile after ghl.
 *   - stripe = `runScheduledStripeSync`: incremental delta, the heavy 7-day
 *     reconcile only when its marker is > 20 h old (budgeted, resumable).
 *   - ghl runs here ONLY as a fallback — when no GHL run has finished OK
 *     (succeeded / partial) for 2 h, i.e. the heartbeat's sync-ghl call is
 *     not happening. Reconcile reads the persisted cycle state, not this run.
 *   - STATUS: 200 (ok, partial when something was deferred / timed out);
 *     500 only for a failed step or one stuck STUCK_THRESHOLD runs in a row
 *     (+ one `dispatch_stuck` incident naming it).
 * Every step is safe to repeat: sources upsert by external id; GHL refuses to
 * overlap a live run; reconcile and sweep are idempotent; insights regenerate
 * at most every 20 h; narratives and digests are once per period inside the
 * 6am-local window; prune runs once per local day.
 * `?only=stripe,meta,meta_token,google,ghl,reconcile,sweep,prune,insights,narrative,daily,weekly,monthly`
 * limits the steps; `?force=1` bypasses the hour/day/fallback guards (never the secret).
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

  await recordScheduledRun('/api/cron/dispatch', schedulerVia(request.headers));
  const force = request.nextUrl.searchParams.get('force') === '1';
  const only = new Set((request.nextUrl.searchParams.get('only') ?? '').split(',').filter(Boolean));
  const want = (step: string) => only.size === 0 || only.has(step);

  const timezone = await getTimezone();
  const now = new Date();
  const hour = localHour(now, timezone);
  const today = todayInTimezone(timezone);
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 1 = Monday
  const isSendHour = force || inSendWindow(now, timezone);
  const gate = (ok: boolean, reason: string) => (ok ? null : reason);

  const ghlKinds = ['ghl_delta', 'ghl_backfill'];
  const [state, lastGhlOk, liveGhl, trackedMarker] = await Promise.all([
    readDispatchState(),
    db.select({ finishedAt: syncRuns.finishedAt }).from(syncRuns)
      .where(and(inArray(syncRuns.kind, ghlKinds), inArray(syncRuns.status, ['succeeded', 'partial'])))
      .orderBy(desc(syncRuns.finishedAt)).limit(1),
    // A GHL run is live when it holds the lease (lib/syncLock.ts), not when a sync_runs row says 'running'.
    db.select({ name: syncLocks.name }).from(syncLocks).where(and(eq(syncLocks.name, GHL_LOCK), gt(syncLocks.expiresAt, now))).limit(1),
    readMarker('ghl.opportunities'),
  ]);

  const steps: DispatchStep[] = [
    { name: 'stripe', ownsRun: true, timeoutMs: 60_000, run: () => runScheduledStripeSync({ budgetMs: 45_000 }) },
    // F12: the per-day completeness sweep since backfill_from — refills any day that differs (Sep 2–11 included).
    { name: 'stripe_completeness', ownsRun: true, timeoutMs: 90_000, run: () => runStripeCompleteness({ trigger: 'cron', budgetMs: 75_000 }) },
    { name: 'meta', ownsRun: true, timeoutMs: 60_000, run: () => runMetaSync({ mode: 'delta', trigger: 'cron' }) },
    // Bank of Canada USD→CAD: backfills every missing business day since the earliest money row, then daily.
    { name: 'fx', ownsRun: true, timeoutMs: 20_000, run: () => runFxSync({ trigger: 'cron' }) },
    // H2: one debug_token GET — when does the stored Meta token expire? (7-day warning incident)
    { name: 'meta_token', timeoutMs: 10_000, run: () => runMetaTokenCheck() },
    { name: 'google', ownsRun: true, run: () => runGoogleAdsSync({ mode: 'delta', trigger: 'cron' }) },
    {
      name: 'ghl',
      ownsRun: true,
      // Fallback only (sync-ghl normally covers it): a full followed-pipeline read fits 150 s.
      timeoutMs: 180_000,
      skip: force ? null : ghlFallbackGate(lastGhlOk[0]?.finishedAt ?? null, now),
      run: () => runGhlSync({ mode: 'delta', trigger: 'cron', budgetMs: 150_000, mirrors: 'skip' }),
    },
    {
      name: 'reconcile',
      after: ['ghl'],
      // Eligible once the TRACKED phases of the current cycle are complete (persisted cycle state, whatever ran first).
      skip: reconcileGate({ trackedCompletedAt: trackedMarker?.completedAt ?? null, ghlRunLive: liveGhl.length > 0 }),
      run: () => runReconcile({ trigger: 'cron' }),
    },
    { name: 'sweep', run: () => sweepIncidentNoise() },
    // F3: fill every existing contact's empty utm_* from its landing URL — once (then "done"); sync fills new ones.
    { name: 'utm_backfill', run: () => runUtmBackfill() },
    // sync_runs retention: once per local day, rows > 30 days (the newest per kind + status always kept).
    { name: 'prune', run: () => runNightlyPrune(today, { force }) },
    { name: 'insights', run: () => runInsights({ range: 'this_week', compare: 'previous_period', minIntervalMs: force ? undefined : INSIGHT_MIN_INTERVAL_MS }) },
    // Narratives wait for the send window so the run that sends the digest writes its narrative first (once per period).
    { name: 'narrative_weekly', skip: gate(isSendHour && (force || dow === 1), dow === 1 ? `before ${SEND_WINDOW_START_LOCAL}am local` : 'not Monday'), run: () => runWeeklyNarrative('weekly', { force }) },
    { name: 'narrative_monthly', skip: gate(isSendHour && (force || d === 1), d === 1 ? `before ${SEND_WINDOW_START_LOCAL}am local` : 'not the 1st'), run: () => runWeeklyNarrative('monthly', { force }) },
    { name: 'daily', skip: gate(isSendHour, `before ${SEND_WINDOW_START_LOCAL}am local`), run: () => runDigest('daily_todo', { force }) },
    { name: 'weekly', after: ['narrative_weekly'], skip: gate(isSendHour && (force || dow === 1), dow === 1 ? `before ${SEND_WINDOW_START_LOCAL}am local` : 'not Monday'), run: () => runDigest('weekly', { force }) },
    { name: 'monthly', after: ['narrative_monthly'], skip: gate(isSendHour && (force || d === 1), d === 1 ? `before ${SEND_WINDOW_START_LOCAL}am local` : 'not the 1st'), run: () => runDigest('monthly', { force }) },
  ].filter((s) => want(s.name === 'narrative_weekly' || s.name === 'narrative_monthly' ? 'narrative' : s.name));

  const record = async (name: string, outcome: StepOutcome) => {
    const finishedAt = new Date();
    await db.insert(syncRuns).values({
      kind: `dispatch:${name}`,
      trigger: 'cron',
      status: outcome.status === 'timed_out' ? 'timed_out' : outcome.status, // succeeded | failed | skipped | deferred | timed_out
      startedAt: new Date(finishedAt.getTime() - ('durationMs' in outcome ? outcome.durationMs : 0)),
      finishedAt,
      stats: statsForOutcome(outcome),   // 2026-09-29: every skipped / stored / partial step says why
      warnings: outcome.status === 'skipped' || outcome.status === 'deferred' ? [outcome.reason] : [],
      error: 'error' in outcome ? outcome.error : null,
    });
  };

  const result = await runDispatch(orderSteps(steps, state), { record });

  // Fold this run into the history, then decide the status from it (a step's 3rd consecutive deferral is stuck).
  const nextState = nextDispatchState(state, result.steps, now.toISOString());
  const assessment = assessDispatch(result.steps, nextState);
  try {
    await writeDispatchState(nextState);
    await syncStuckIncidents(assessment, result.steps);
  } catch {
    /* bookkeeping must never turn a healthy dispatch into a 500 */
  }

  return NextResponse.json(
    {
      ok: assessment.ok,
      partial: assessment.partial,
      failed: assessment.failed,
      stuck: assessment.stuck,
      deferred: assessment.deferred,
      timezone, today, localHour: hour, durationMs: result.durationMs, order: result.order, steps: result.steps,
    },
    { status: assessment.httpStatus },
  );
}
