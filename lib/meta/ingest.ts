/**
 * Meta insights → ad_spend. Idempotent upserts keyed `meta:{ad_id}:{date}`.
 *   delta     last 3 days through today (Meta restates recent days)
 *   backfill  from settings.backfill_from (2026-06-16)
 * Rows carry origin='meta', so the metrics engine lets them override manual
 * weekly spend for the dates they cover.
 */

import { eq } from 'drizzle-orm';
import { db, adSpend, syncRuns, syncIncidents } from '@/db';
import { getSetting, getTimezone, SETTING_KEYS } from '../settings';
import { todayInTimezone, addDays } from '../dates';
import { getMetaConfig } from './config';
import { fetchInsights } from './client';
import { leadsFromActions } from './schemas';

export type MetaSyncMode = 'delta' | 'backfill';

export interface MetaSyncResult {
  ok: boolean;
  notConfigured?: boolean;
  runId: string;
  mode: MetaSyncMode;
  window: { since: string; until: string } | null;
  stats: { rows: number; days: number; campaigns: number; spendCents: number; rejected: number };
  requestsUsed: number;
  warnings: string[];
  error?: string;
  durationMs: number;
}

const DELTA_LOOKBACK_DAYS = 3;

export async function runMetaSync(options: { mode: MetaSyncMode; trigger: 'cron' | 'manual' | 'cli'; since?: string }): Promise<MetaSyncResult> {
  const startedAt = new Date();
  const stats = { rows: 0, days: 0, campaigns: 0, spendCents: 0, rejected: 0 };
  const warnings: string[] = [];
  let requestsUsed = 0;
  const backfilled = options.mode === 'backfill';

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
  const since = options.since ?? (backfilled ? ((await getSetting(SETTING_KEYS.backfillFrom)) ?? '2026-06-16') : addDays(today, -DELTA_LOOKBACK_DAYS));
  const window = { since, until: today };

  try {
    const fetched = await fetchInsights({ since, until: today, level: 'ad' });
    requestsUsed += fetched.requests;
    stats.rejected = fetched.rejected;
    warnings.push(...fetched.warnings);

    if (fetched.error) {
      await db.insert(syncIncidents).values({ syncRunId: runId, kind: 'error', severity: 'critical', message: `Meta insights read failed: ${fetched.error}` });
      return finish(false, window, fetched.error);
    }

    const days = new Set<string>();
    const campaigns = new Set<string>();
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

    if (!backfilled && fetched.rows.length === 0) {
      await db.insert(syncIncidents).values({
        syncRunId: runId,
        kind: 'silence',
        severity: 'warning',
        message: `Meta delta sync returned zero insight rows for ${since} – ${today}.`,
      });
    }
    return finish(true, window);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(syncIncidents).values({ syncRunId: runId, kind: 'error', severity: 'critical', message: `Meta sync crashed: ${message}` });
    return finish(false, window, message);
  }
}
