/**
 * Google Ads → ad_spend. Two paths share one upsert:
 *   - runGoogleAdsSync: GAQL campaign/day spend (origin 'google')
 *   - importGoogleAdsCsv: parsed UI export (origin 'google_csv')
 * Both are API-grade for precedence: they replace manual weekly fallback for
 * their platform+date (see lib/metrics#expandSpend).
 */

import { eq } from 'drizzle-orm';
import { db, adSpend, syncRuns, syncIncidents } from '@/db';
import { getSetting, getTimezone, SETTING_KEYS } from '../settings';
import { todayInTimezone, addDays } from '../dates';
import { captureException } from '../sentry';
import { getGoogleAdsConfig } from './config';
import { fetchSpendReport } from './client';
import { getGoogleAdsRequestCount } from './client';
import { csvExternalId, parseGoogleAdsCsv, type GoogleCsvRow } from './csv';

export interface GoogleSyncResult {
  ok: boolean;
  notConfigured?: boolean;
  runId: string | null;
  mode: 'delta' | 'backfill';
  stats: { rows: number; days: number; campaigns: number; spendCents: number; rejectedRows: number };
  requestsUsed: number;
  warnings: string[];
  error?: string;
  durationMs: number;
}

const DELTA_LOOKBACK_DAYS = 3;

export async function runGoogleAdsSync(options: { mode: 'delta' | 'backfill'; trigger: 'cron' | 'manual' | 'cli'; since?: string }): Promise<GoogleSyncResult> {
  const startedAt = new Date();
  const stats = { rows: 0, days: 0, campaigns: 0, spendCents: 0, rejectedRows: 0 };
  const warnings: string[] = [];
  const requestsBefore = getGoogleAdsRequestCount();

  const config = await getGoogleAdsConfig();
  if (!config.configured) {
    return {
      ok: false,
      notConfigured: true,
      runId: null,
      mode: options.mode,
      stats,
      requestsUsed: 0,
      warnings,
      error: config.pending ? 'Google Ads is pending OAuth approval.' : 'Google Ads is not connected.',
      durationMs: 0,
    };
  }

  const [run] = await db
    .insert(syncRuns)
    .values({ kind: options.mode === 'backfill' ? 'google_backfill' : 'google_delta', trigger: options.trigger, status: 'running', startedAt })
    .returning({ id: syncRuns.id });

  const finish = async (ok: boolean, since: string, error?: string): Promise<GoogleSyncResult> => {
    const finishedAt = new Date();
    const requestsUsed = getGoogleAdsRequestCount() - requestsBefore;
    await db
      .update(syncRuns)
      .set({ status: ok ? 'succeeded' : 'failed', finishedAt, since: new Date(`${since}T00:00:00Z`), requestsUsed, stats, warnings, error: error ?? null })
      .where(eq(syncRuns.id, run.id));
    return { ok, runId: run.id, mode: options.mode, stats, requestsUsed, warnings, error, durationMs: finishedAt.getTime() - startedAt.getTime() };
  };

  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const since =
    options.since ??
    (options.mode === 'backfill' ? ((await getSetting(SETTING_KEYS.backfillFrom)) ?? '2026-06-16') : addDays(today, -DELTA_LOOKBACK_DAYS));

  try {
    const report = await fetchSpendReport(since, today, config);
    if (!report.ok || !report.data) {
      await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Google Ads read failed: ${report.error}` });
      captureException(new Error(report.error ?? 'Google Ads read failed'), { source: 'googleads', runId: run.id });
      return finish(false, since, report.error);
    }
    stats.rejectedRows = report.rejected;
    warnings.push(...report.warnings);

    const days = new Set<string>();
    const campaigns = new Set<string>();
    for (const row of report.data) {
      const date = row.segments?.date;
      const campaignId = row.campaign?.id != null ? String(row.campaign.id) : null;
      if (!date || !campaignId) {
        stats.rejectedRows += 1;
        continue;
      }
      const micros = Number(row.metrics?.costMicros ?? 0);
      const spendCents = Math.round(micros / 10_000);
      await upsertGoogleRow({
        externalId: `google:${campaignId}:${date}`,
        date,
        campaignId,
        campaignName: row.campaign?.name ?? campaignId,
        spendCents,
        impressions: Math.round(Number(row.metrics?.impressions ?? 0)),
        clicks: Math.round(Number(row.metrics?.clicks ?? 0)),
        leads: Math.round(Number(row.metrics?.conversions ?? 0)),
        origin: 'google',
        source: 'google',
        accountId: config.customerId,
        backfilled: options.mode === 'backfill',
        now: startedAt,
      });
      stats.rows += 1;
      stats.spendCents += spendCents;
      days.add(date);
      campaigns.add(campaignId);
    }
    stats.days = days.size;
    stats.campaigns = campaigns.size;
    if (stats.rows === 0 && options.mode === 'delta') {
      await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'silence', severity: 'info', message: 'Google Ads delta returned zero rows.' });
    }
    return finish(true, since);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureException(err, { source: 'googleads', runId: run.id });
    await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Google Ads sync crashed: ${message}` });
    return finish(false, since, message);
  }
}

interface UpsertRow {
  externalId: string;
  date: string;
  campaignId: string | null;
  campaignName: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  leads: number;
  origin: 'google' | 'google_csv';
  source: string;
  accountId: string | null;
  backfilled: boolean;
  now: Date;
  enteredBy?: string;
}

async function upsertGoogleRow(r: UpsertRow): Promise<void> {
  const values = {
    externalId: r.externalId,
    platform: 'google',
    level: 'campaign',
    accountId: r.accountId,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    date: r.date,
    spendCents: r.spendCents,
    currency: 'USD',
    impressions: r.impressions,
    clicks: r.clicks,
    leads: r.leads,
    enteredBy: r.enteredBy ?? null,
    source: r.source,
    origin: r.origin,
    syncedAt: r.now,
    backfilled: r.backfilled,
    updatedAt: r.now,
  };
  await db.insert(adSpend).values(values).onConflictDoUpdate({ target: adSpend.externalId, set: values });
}

export interface CsvImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  spendCents: number;
  days: number;
  campaigns: number;
  warnings: string[];
  dateRange: { start: string; end: string } | null;
}

/** Import a Google Ads UI export. Idempotent: same file twice → same rows. */
export async function importGoogleAdsCsv(text: string, options: { enteredBy?: string } = {}): Promise<CsvImportResult> {
  const parsed = parseGoogleAdsCsv(text);
  const now = new Date();
  // Same campaign+date appearing twice in one file → sum (e.g. split by network).
  const merged = new Map<string, GoogleCsvRow>();
  for (const row of parsed.rows) {
    const id = csvExternalId(row);
    const prev = merged.get(id);
    merged.set(
      id,
      prev
        ? { ...prev, spendCents: prev.spendCents + row.spendCents, impressions: prev.impressions + row.impressions, clicks: prev.clicks + row.clicks, conversions: prev.conversions + row.conversions }
        : row,
    );
  }
  let spendCents = 0;
  const days = new Set<string>();
  const campaigns = new Set<string>();
  for (const [externalId, row] of merged) {
    await upsertGoogleRow({
      externalId,
      date: row.date,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      spendCents: row.spendCents,
      impressions: row.impressions,
      clicks: row.clicks,
      leads: Math.round(row.conversions),
      origin: 'google_csv',
      source: 'google_csv',
      accountId: null,
      backfilled: true,
      now,
      enteredBy: options.enteredBy ?? 'csv upload',
    });
    spendCents += row.spendCents;
    days.add(row.date);
    campaigns.add(row.campaignName);
  }
  const dates = Array.from(days).sort();
  return {
    ok: merged.size > 0,
    imported: merged.size,
    skipped: parsed.skipped,
    spendCents,
    days: days.size,
    campaigns: campaigns.size,
    warnings: parsed.warnings,
    dateRange: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
  };
}
