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

import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { db, adSpend, syncRuns, syncIncidents } from '@/db';
import { getSetting, setSetting, getTimezone, isValidTimezone, SETTING_KEYS, BACKFILL_DEFAULTS } from '../settings';
import { todayInTimezone, addDays } from '../dates';
import { getMetaConfig } from './config';
import { fetchInsights, fetchAccount, fetchAccountDailySpend } from './client';
import { writeMarker } from '../sync/markers';
import { leadsFromActions, purchasesFromActions, landingPageViewsFromActions, actionsByType, type MetaInsightRow } from './schemas';
import { captureException } from '../sentry';
import { sweepStaleRuns } from '../staleRuns';

export type MetaSyncMode = 'delta' | 'backfill';

export interface MetaSyncResult {
  ok: boolean;
  notConfigured?: boolean;
  runId: string;
  mode: MetaSyncMode;
  window: { since: string; until: string } | null;
  stats: { rows: number; days: number; campaigns: number; spendCents: number; rejected: number; chunksTotal: number; chunksDone: number; relabelled: number; checkedDays: number; refetchedDays: number };
  /** The ad account's currency this run stored spend in (null when the run failed before reading it). */
  currency?: string | null;
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

/** Currencies the money engine sums (lib/money). Anything else fails the run closed — never summed, never guessed. */
const SUPPORTED_CURRENCIES = new Set(['CAD', 'USD']);
/** The account-level completeness check looks this far back (days before today, account timezone). */
export const META_CHECK_DAYS = 30;
/** …at most this often (hours). */
export const META_CHECK_EVERY_HOURS = 20;

export interface MetaAccountInfo {
  id: string;
  name: string | null;
  currency: string;
  timezone: string | null;
  checkedAt: string;
}

/** The last account read (Setup / Sync health show it). */
export async function readMetaAccount(): Promise<MetaAccountInfo | null> {
  const raw = await getSetting(SETTING_KEYS.metaAccount);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetaAccountInfo;
  } catch {
    return null;
  }
}

function spendRowValues(row: MetaInsightRow, ctx: { accountId: string; currency: string; startedAt: Date; backfilled: boolean }) {
  const spendCents = Math.round(row.spend * 100);
  return {
    platform: 'meta',
    externalId: `meta:${row.ad_id}:${row.date_start}`,
    accountId: ctx.accountId,
    level: 'ad',
    campaignId: row.campaign_id ?? null,
    campaignName: row.campaign_name ?? null,
    adsetId: row.adset_id ?? null,
    adsetName: row.adset_name ?? null,
    adId: row.ad_id,
    adName: row.ad_name ?? null,
    date: row.date_start,
    spendCents,
    currency: ctx.currency,
    impressions: Math.round(row.impressions),
    clicks: Math.round(row.clicks),
    leads: Math.round(leadsFromActions(row.actions)),
    reach: row.reach != null ? Math.round(row.reach) : null,
    frequency: row.frequency ?? null,
    cpmCents: row.cpm != null ? Math.round(row.cpm * 100) : null,
    cpcCents: row.cpc != null ? Math.round(row.cpc * 100) : null,
    linkClicks: row.inline_link_clicks != null ? Math.round(row.inline_link_clicks) : null,
    landingPageViews: Math.round(landingPageViewsFromActions(row.actions)),
    purchases: Math.round(purchasesFromActions(row.actions)),
    actions: actionsByType(row.actions),
    source: 'meta',
    origin: 'meta',
    syncedAt: ctx.startedAt,
    backfilled: ctx.backfilled,
    updatedAt: ctx.startedAt,
  };
}

export async function runMetaSync(options: { mode: MetaSyncMode; trigger: 'cron' | 'manual' | 'cli'; since?: string; now?: Date }): Promise<MetaSyncResult> {
  const startedAt = options.now ?? new Date();
  const stats = { rows: 0, days: 0, campaigns: 0, spendCents: 0, rejected: 0, chunksTotal: 0, chunksDone: 0, relabelled: 0, checkedDays: 0, refetchedDays: 0 };
  const warnings: string[] = [];
  let requestsUsed = 0;
  const backfilled = options.mode === 'backfill';

  await sweepStaleRuns(startedAt);

  const [run] = await db
    .insert(syncRuns)
    .values({ kind: backfilled ? 'meta_backfill' : 'meta_delta', trigger: options.trigger, status: 'running', startedAt })
    .returning({ id: syncRuns.id });
  const runId = run.id;

  let currency: string | null = null;
  const finish = async (ok: boolean, window: MetaSyncResult['window'], error?: string, extra: Partial<MetaSyncResult> = {}): Promise<MetaSyncResult> => {
    const finishedAt = new Date();
    const recorded: Record<string, number | string> = { ...stats };
    if (currency) recorded.currency = currency;
    if (error) recorded.reason = error;
    await db
      .update(syncRuns)
      .set({ status: ok ? 'succeeded' : 'failed', finishedAt, requestsUsed, stats: recorded, warnings, error: error ?? null })
      .where(eq(syncRuns.id, runId));
    return { ok, runId, mode: options.mode, window, stats, currency, requestsUsed, warnings, error, durationMs: finishedAt.getTime() - startedAt.getTime(), ...extra };
  };
  const incident = async (kind: string, severity: 'info' | 'warning' | 'critical', message: string, details?: Record<string, unknown>) => {
    await db.insert(syncIncidents).values({ syncRunId: runId, kind, severity, message, details });
  };

  const config = await getMetaConfig();
  if (!config.configured) {
    return finish(false, null, 'Meta Ads is not connected (no access token / ad account id).', { notConfigured: true });
  }

  const accountId = config.adAccountId as string; // configured ⇒ set
  try {
    // ---- The account first: its currency and timezone govern every row (F13, 2026-09-30) ----------------------
    const account = await fetchAccount();
    requestsUsed += 1;
    if (!account.ok || !account.data) {
      const error = `Meta account read failed: ${account.error ?? 'no data'} — spend not stored`;
      await incident('error', 'critical', error);
      return finish(false, null, error);
    }
    const accountCurrency = account.data.currency?.trim().toUpperCase() || null;
    if (!accountCurrency || !SUPPORTED_CURRENCIES.has(accountCurrency)) {
      const error = !accountCurrency
        ? 'Meta did not return the account currency — spend not stored'
        : `Meta account currency ${accountCurrency} is not supported (CAD / USD) — spend not stored`;
      await incident('meta_currency', 'critical', error, { accountId: account.data.id, currency: accountCurrency });
      return finish(false, null, error);
    }
    currency = accountCurrency;
    const accountTz = account.data.timezone_name && isValidTimezone(account.data.timezone_name) ? account.data.timezone_name : null;
    const info: MetaAccountInfo = { id: account.data.id, name: account.data.name ?? null, currency, timezone: accountTz, checkedAt: startedAt.toISOString() };
    await setSetting(SETTING_KEYS.metaAccount, JSON.stringify(info));
    if (!accountTz) warnings.push(`Meta returned no valid account timezone (${account.data.timezone_name ?? 'none'}); windows use the business timezone.`);

    // ---- Self-repair: every row of THIS account is in the account's currency (Meta reports spend in it; an
    // account's currency cannot change). Rows labelled otherwise — all 5,587 before 2026-09-30, stored as USD by a
    // silent default — are relabelled, counted and reported. Idempotent: the second run relabels 0.
    const relabelled = await db
      .update(adSpend)
      .set({ currency, updatedAt: startedAt })
      .where(and(eq(adSpend.platform, 'meta'), eq(adSpend.origin, 'meta'), eq(adSpend.accountId, accountId), ne(adSpend.currency, currency)))
      .returning({ id: adSpend.id });
    stats.relabelled = relabelled.length;
    if (relabelled.length > 0) {
      const msg = `Relabelled ${relabelled.length} Meta spend rows to ${currency} — the ad account's currency (they had been stored with a different label).`;
      warnings.push(msg);
      await incident('meta_currency_relabelled', 'info', msg, { count: relabelled.length, currency });
    }

    const timezone = accountTz ?? (await getTimezone());
    const today = todayInTimezone(timezone, startedAt);
    // Meta has its OWN window (meta_backfill_from, 2026-07-16 = VSL launch).
    let since = options.since ?? (backfilled ? ((await getSetting(SETTING_KEYS.metaBackfillFrom)) ?? BACKFILL_DEFAULTS.meta) : addDays(today, -DELTA_LOOKBACK_DAYS));
    if (backfilled && !options.since) {
      const cursor = await getSetting(SETTING_KEYS.metaBackfillCursor);
      if (cursor && cursor > since && cursor <= today) {
        warnings.push(`Resuming backfill from ${cursor} — a prior run completed chunks up to it.`);
        since = cursor;
      }
    }
    const window = { since, until: today };
    const ctx = { accountId, currency, startedAt, backfilled };

    // One window of ad-level rows → upsert. The row's own account_currency must agree with the account's.
    const ingestRows = async (rows: MetaInsightRow[]): Promise<string | null> => {
      const mismatch = rows.find((r) => r.account_currency && r.account_currency.toUpperCase() !== currency);
      if (mismatch) return `Meta row for ${mismatch.date_start} says ${mismatch.account_currency} but the account is ${currency} — spend not stored`;
      for (const row of rows) {
        const values = spendRowValues(row, ctx);
        await db.insert(adSpend).values(values).onConflictDoUpdate({ target: adSpend.externalId, set: values });
        stats.rows += 1;
        stats.spendCents += values.spendCents;
      }
      return null;
    };

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
        await incident('error', 'critical', error);
        if (backfilled) warnings.push(`Progress saved — re-running the backfill resumes at ${chunk.since}.`);
        return finish(false, window, error);
      }
      const bad = await ingestRows(fetched.rows);
      if (bad) {
        await incident('meta_currency_mismatch', 'critical', bad, { currency });
        return finish(false, window, bad);
      }
      for (const row of fetched.rows) {
        days.add(row.date_start);
        if (row.campaign_id) campaigns.add(row.campaign_id);
      }
      stats.days = days.size;
      stats.campaigns = campaigns.size;
      stats.chunksDone += 1;
      if (backfilled) await setSetting(SETTING_KEYS.metaBackfillCursor, addDays(chunk.until, 1));
      await db.update(syncRuns).set({ stats, requestsUsed, warnings }).where(eq(syncRuns.id, runId));
    }
    if (backfilled) await setSetting(SETTING_KEYS.metaBackfillCursor, '');

    if (!backfilled && stats.rows === 0) {
      await incident('silence', 'warning', `Meta delta sync returned zero insight rows for ${since} – ${today}.`);
    }

    // ---- Completeness: account-level spend per day vs the mirror (daily; F13 / Ingestion v2) -------------------
    const check = await runMetaSpendCheck({ today, force: backfilled, accountId, ingestRows, now: startedAt });
    requestsUsed += check.requests;
    stats.checkedDays = check.checkedDays;
    stats.refetchedDays = check.refetchedDays;
    if (check.error) {
      await incident('error', 'critical', check.error);
      return finish(false, window, check.error);
    }
    if (check.stillDiffering.length > 0) {
      const msg = `Meta spend differs from the mirror after re-fetch on ${check.stillDiffering.length} day(s): ${check.stillDiffering.map((d) => `${d.date} Meta ${d.metaCents} vs mirror ${d.mirrorCents}`).join('; ')}`;
      await incident('meta_spend_mismatch', 'critical', msg, { days: check.stillDiffering });
      return finish(false, window, msg);
    }

    await writeMarker({ family: 'meta.spend', runId, fetched: stats.rows, detail: `${window.since} – ${window.until} · ${currency}${check.ran ? ` · checked ${check.checkedDays} days vs account totals` : ''}` });
    return finish(true, window);
  } catch (err) {
    captureException(err, { source: 'meta' });
    const message = err instanceof Error ? err.message : String(err);
    await incident('error', 'critical', `Meta sync crashed: ${message}`);
    return finish(false, null, message);
  }
}

export interface MetaSpendDayDiff {
  date: string;
  metaCents: number;
  mirrorCents: number;
}

/**
 * Account-level spend per day (what Meta's UI totals) vs the sum of the mirror's ad-level rows, for the last
 * META_CHECK_DAYS completed days (account timezone). A differing day is re-fetched at ad level and compared again;
 * what still differs is returned. Runs at most every META_CHECK_EVERY_HOURS (summary in settings.meta_spend_check).
 */
export async function runMetaSpendCheck(p: {
  today: string;
  force: boolean;
  accountId: string;
  ingestRows: (rows: MetaInsightRow[]) => Promise<string | null>;
  now: Date;
}): Promise<{ ran: boolean; checkedDays: number; refetchedDays: number; stillDiffering: MetaSpendDayDiff[]; requests: number; error?: string }> {
  const out = { ran: false, checkedDays: 0, refetchedDays: 0, stillDiffering: [] as MetaSpendDayDiff[], requests: 0 };
  const lastRaw = await getSetting(SETTING_KEYS.metaSpendCheck);
  const last = lastRaw ? (JSON.parse(lastRaw) as { checkedAt?: string }) : null;
  if (!p.force && last?.checkedAt && p.now.getTime() - Date.parse(last.checkedAt) < META_CHECK_EVERY_HOURS * 3_600_000) return out;
  out.ran = true;

  const until = addDays(p.today, -1); // today is still accumulating at Meta
  const since = addDays(p.today, -META_CHECK_DAYS);
  const compare = async (): Promise<{ diffs: MetaSpendDayDiff[]; days: number; error?: string }> => {
    const live = await fetchAccountDailySpend({ since, until });
    out.requests += live.requests;
    if (live.error) return { diffs: [], days: 0, error: `Meta account-level spend read failed: ${live.error}` };
    const metaByDay = new Map(live.rows.map((r) => [r.date_start, Math.round(r.spend * 100)]));
    const mirror = await db
      .select({ date: adSpend.date, cents: sql<number>`coalesce(sum(${adSpend.spendCents}), 0)::int` })
      .from(adSpend)
      .where(and(eq(adSpend.platform, 'meta'), eq(adSpend.origin, 'meta'), eq(adSpend.accountId, p.accountId), gte(adSpend.date, since), lte(adSpend.date, until)))
      .groupBy(adSpend.date);
    const mirrorByDay = new Map(mirror.map((m) => [String(m.date), Number(m.cents)]));
    const allDays = new Set([...metaByDay.keys(), ...mirrorByDay.keys()]);
    const diffs = [...allDays].sort().map((date) => ({ date, metaCents: metaByDay.get(date) ?? 0, mirrorCents: mirrorByDay.get(date) ?? 0 })).filter((d) => d.metaCents !== d.mirrorCents);
    return { diffs, days: allDays.size };
  };

  const first = await compare();
  if (first.error) return { ...out, error: first.error };
  out.checkedDays = first.days;
  for (const d of first.diffs) {
    const fetched = await fetchInsights({ since: d.date, until: d.date, level: 'ad' });
    out.requests += fetched.requests;
    if (fetched.error) return { ...out, error: `Meta re-fetch of ${d.date} failed: ${fetched.error}` };
    const bad = await p.ingestRows(fetched.rows);
    if (bad) return { ...out, error: bad };
    out.refetchedDays += 1;
  }
  const second = first.diffs.length > 0 ? await compare() : first;
  if (second.error) return { ...out, error: second.error };
  out.stillDiffering = second.diffs;
  await setSetting(SETTING_KEYS.metaSpendCheck, JSON.stringify({ checkedAt: p.now.toISOString(), since, until, days: out.checkedDays, refetched: out.refetchedDays, stillDiffering: out.stillDiffering }));
  return out;
}
