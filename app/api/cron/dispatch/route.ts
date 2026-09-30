import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { runGhlSync, readSyncCursor } from '@/lib/ghl/ingest';
import { runReconcile } from '@/lib/ghl/reconcile';
import { runMetaSync } from '@/lib/meta/ingest';
import { runMetaTokenCheck } from '@/lib/meta/token';
import { runScheduledStripeSync } from '@/lib/stripe/ingest';
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
import { sweepIncidentNoise } from '@/lib/incidents/noise';
import { runNightlyPrune } from '@/lib/syncRunsPrune';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/dispatch — the ONE scheduled job besides sync-ghl.
 *
 * Callers: the GitHub Actions heartbeat (hourly, right after
 * /api/cron/sync-ghl) and the daily Vercel cron (fallback).
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
  const [state, lastGhlOk, liveGhl, ghlCursor, ghlTrackedCompletedAt] = await Promise.all([
    readDispatchState(),
    db.select({ finishedAt: syncRuns.finishedAt }).from(syncRuns)
      .where(and(inArray(syncRuns.kind, ghlKinds), inArray(syncRuns.status, ['succeeded', 'partial'])))
      .orderBy(desc(syncRuns.finishedAt)).limit(1),
    db.select({ id: syncRuns.id }).from(syncRuns).where(and(inArray(syncRuns.kind, ghlKinds), eq(syncRuns.status, 'running'))).limit(1),
    readSyncCursor(),
    getSetting(SETTING_KEYS.ghlTrackedCompletedAt),
  ]);

  const steps: DispatchStep[] = [
    { name: 'stripe', ownsRun: true, run: () => runScheduledStripeSync({ budgetMs: 15_000 }) },
    { name: 'meta', ownsRun: true, run: () => runMetaSync({ mode: 'delta', trigger: 'cron' }) },
    // H2: one debug_token GET — when does the stored Meta token expire? (7-day warning incident)
    { name: 'meta_token', timeoutMs: 10_000, run: () => runMetaTokenCheck() },
    { name: 'google', ownsRun: true, run: () => runGoogleAdsSync({ mode: 'delta', trigger: 'cron' }) },
    {
      name: 'ghl',
      ownsRun: true,
      timeoutMs: 30_000,
      skip: force ? null : ghlFallbackGate(lastGhlOk[0]?.finishedAt ?? null, now),
      run: () => runGhlSync({ mode: 'delta', trigger: 'cron', budgetMs: 20_000 }),
    },
    {
      name: 'reconcile',
      after: ['ghl'],
      // Eligible once the TRACKED phases of the current cycle are complete (persisted cycle state, whatever ran first).
      skip: reconcileGate({ cursorPhase: ghlCursor?.phase ?? null, trackedCompletedAt: ghlTrackedCompletedAt || null, ghlRunLive: liveGhl.length > 0 }),
      run: () => runReconcile({ trigger: 'cron' }),
    },
    { name: 'sweep', run: () => sweepIncidentNoise() },
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
