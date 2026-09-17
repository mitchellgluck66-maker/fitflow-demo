/**
 * Meta insights → ad_spend. Idempotent upserts keyed `meta:{ad_id}:{date}`.
 *   delta     last 3 days through today (Meta restates recent days)
 *   backfill  from settings.meta_backfill_from (2026-07-16, the VSL launch —
 *             Meta's own window, independent of the GHL/Stripe backfill_from)
 * Rows carry origin='meta', so the metrics engine lets them override manual
 * weekly spend for the dates they cover.
 *
 * Every window is split into sequential ≤7-day chunks: the 2026-09-01 real
 * backfill (June 16 → today in one insights query) drew "Meta 500 unknown
 * error" while 4-day deltas succeeded. Each chunk gets 2 attempts with
 * backoff; a backfill records its cursor after every completed chunk
 * (settings.meta_backfill_cursor) so a re-run resumes instead of restarting.
 */

import { eq } from 'drizzle-orm';
import { db, adSpend, syncRuns, syncIncidents } from '@/db';
import { getSetting, setSetting, getTimezone, SETTING_KEYS, BACKFILL_DEFAULTS } from '../settings';
import { todayInTimezone, addDays } from '../dates';
import { getMetaConfig } from './config';
import { fetchInsights } from './client';
import { leadsFromActions } from './schemas';
import { captureException } from '../sentry';
import { sweepStaleRuns } from '../staleRuns';

export type MetaSyncMode = 'delta' | 'backfill';

export interface MetaSyncResult {
  ok: boolean;
  notConfigured?: boolean;
  runId: string;
  mode: MetaSyncMode;
  window: { since: string; until: string } | null;
  stats: { rows: number; days: number; campaigns: number; spendCents: number; rejected: number; chunksTotal: number; chunksDone: number };
  requestsUsed: number;
  warnings: string[];
  error?: string;
  durationMs: number;
}

const DELTA_LOOKBACK_DAYS = 3;
/** Meta 500s on long insight windows (runtime evidence 2026-09-01); ≤7 days works. */
const MAX_CHUNK_DAYS = 7;
const CHUNK_ATTEMPTS = 2;
const CHUNK_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split [since, until] (inclusive YYYY-MM-DD) into sequential ≤maxDays windows. */
export function chunkWindows(since: string, until: string, maxDays = MAX_CHUNK_DAYS): Array<{ since: string; until: string }> {
  const out: Array<{ since: string; until: string }> = [];
  let cursor = since;
  while (cursor <= until) {
    const end = addDays(cursor, maxDays - 1);
    out.push({ since: cursor, until: end < until ? end : until });
    cursor = addDays(cursor, maxDays);
  }
  return out;
}

export async function runMetaSync(options: { mode: MetaSyncMode; trigger: 'cron' | 'manual' | 'cli'; since?: string }): Promise<MetaSyncResult> {
  const startedAt = new Date();
  const stats = { rows: 0, days: 0, campaigns: 0, spendCents: 0, rejected: 0, chunksTotal: 0, chunksDone: 0 };
  const warnings: string[] = [];
  let requestsUsed = 0;
  const backfilled = options.mode === 'backfill';

  await sweepStaleRuns(startedAt);

  const [run] = await db
    .insert(syncRuns)
    .values({ kind: backfilled ? 'meta_backfill' : 'meta_delta', trigger: options.trigger, status: 'running', startedAt })
    .returning({ id: syncRuns.id });
  const runId = run.id;

  const finish = async (ok: boolean, window: MetaSyncResult['window'], error?: string, extra: Partial<MetaSyncResult> = {}): Promise<MetaSyncResult> => {
    const finishedAt = new Date();
    await db
      .update(syncRuns)
      .set({ status: ok ? 'succeeded' : 'failed', finishedAt, requestsUsed, stats, warnings, error: error ?? null })
      .where(eq(syncRuns.id, runId));
    return { ok, runId, mode: options.mode, window, stats, requestsUsed, warnings, error, durationMs: finishedAt.getTime() - startedAt.getTime(), ...extra };
  };

  const config = await getMetaConfig();
  if (!config.configured) {
    return finish(false, null, 'Meta Ads is not connected (no access token / ad account id).', { notConfigured: true });
  }

  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  // Meta has its OWN window (meta_backfill_from, 2026-07-16 = VSL launch);
  // the GHL/Stripe backfill_from never applies here. Rows imported before
  // that date by an earlier run are kept — we just never fetch them again.
  let since = options.since ?? (backfilled ? ((await getSetting(SETTING_KEYS.metaBackfillFrom)) ?? BACKFILL_DEFAULTS.meta) : addDays(today, -DELTA_LOOKBACK_DAYS));

  // Resume a partial backfill: the cursor points at the first day no completed
  // chunk has covered yet. An explicit `since` override starts fresh.
  if (backfilled && !options.since) {
    const cursor = await getSetting(SETTING_KEYS.metaBackfillCursor);
    if (cursor && cursor > since && cursor <= today) {
      warnings.push(`Resuming backfill from ${cursor} — a prior run completed chunks up to it.`);
      since = cursor;
    }
  }
  const window = { since, until: today };

  try {
    const chunks = chunkWindows(since, today);
    stats.chunksTotal = chunks.length;
    const days = new Set<string>();
    const campaigns = new Set<string>();

    for (const chunk of chunks) {
      let fetched = await fetchInsights({ since: chunk.since, until: chunk.until, level: 'ad' });
      requestsUsed += fetched.requests;
      for (let attempt = 2; fetched.error && attempt <= CHUNK_ATTEMPTS; attempt += 1) {
        warnings.push(`Chunk ${chunk.since} – ${chunk.until} failed (${fetched.error}); retrying.`);
        await sleep(CHUNK_BACKOFF_MS * (attempt - 1));
        fetched = await fetchInsights({ since: chunk.since, until: chunk.until, level: 'ad' });
        requestsUsed += fetched.requests;
      }
      stats.rejected += fetched.rejected;
      warnings.push(...fetched.warnings);

      if (fetched.error) {
        const error = `Meta insights read failed for ${chunk.since} – ${chunk.until} (chunk ${stats.chunksDone + 1}/${stats.chunksTotal}, ${CHUNK_ATTEMPTS} attempts): ${fetched.error}`;
        await db.insert(syncIncidents).values({ syncRunId: runId, kind: 'error', severity: 'critical', message: error });
        if (backfilled) warnings.push(`Progress saved — re-running the backfill resumes at ${chunk.since}.`);
        return finish(false, window, error);
      }

      for (const row of fetched.rows) {
        const spendCents = Math.round(row.spend * 100);
        days.add(row.date_start);
        if (row.campaign_id) campaigns.add(row.campaign_id);
        const values = {
          platform: 'meta',
          externalId: `meta:${row.ad_id}:${row.date_start}`,
          accountId: config.adAccountId,
          level: 'ad',
          campaignId: row.campaign_id ?? null,
          campaignName: row.campaign_name ?? null,
          adsetId: row.adset_id ?? null,
          adsetName: row.adset_name ?? null,
          adId: row.ad_id,
          adName: row.ad_name ?? null,
          date: row.date_start,
          spendCents,
          currency: row.account_currency ?? 'USD',
          impressions: Math.round(row.impressions),
          clicks: Math.round(row.clicks),
          leads: Math.round(leadsFromActions(row.actions)),
          source: 'meta',
          origin: 'meta',
          syncedAt: startedAt,
          backfilled,
          updatedAt: startedAt,
        };
        await db.insert(adSpend).values(values).onConflictDoUpdate({ target: adSpend.externalId, set: values });
        stats.rows += 1;
        stats.spendCents += spendCents;
      }
      stats.days = days.size;
      stats.campaigns = campaigns.size;
      stats.chunksDone += 1;

      // Persist per-chunk progress so a killed serverless run leaves an honest
      // trail and the next backfill resumes past everything completed.
      if (backfilled) await setSetting(SETTING_KEYS.metaBackfillCursor, addDays(chunk.until, 1));
      await db.update(syncRuns).set({ stats, requestsUsed, warnings }).where(eq(syncRuns.id, runId));
    }

    if (backfilled) await setSetting(SETTING_KEYS.metaBackfillCursor, '');

    if (!backfilled && stats.rows === 0) {
      await db.insert(syncIncidents).values({
        syncRunId: runId,
        kind: 'silence',
        severity: 'warning',
        message: `Meta delta sync returned zero insight rows for ${since} – ${today}.`,
      });
    }
    return finish(true, window);
  } catch (err) {
    captureException(err, { source: 'meta' });
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(syncIncidents).values({ syncRunId: runId, kind: 'error', severity: 'critical', message: `Meta sync crashed: ${message}` });
    return finish(false, window, message);
  }
}
