/**
 * The Meta-to-FitFlow ratio monitor (plan item 3). Daily, after the ledger:
 *
 *   1. Meta "Website Submit Applications" per campaign per ACCOUNT day for the last 36 days
 *      (`fetchCampaignSubmits`, ≤7-day chunks; explicit report time + windows).
 *   2. FitFlow's applications per campaign per day from the ledger (`verdict_current` rows by
 *      normalised utm_campaign; form applicants = A1 + A2 + U).
 *   3. `applied_ratio_daily` upsert — `meta_submits` is NULL when a day was never fetched; 0 only
 *      when the day's request succeeded and the campaign had no submit action that day.
 *   4. `judgeRatio` per campaign → ONE open `applied_ratio_drift` incident per campaign while it
 *      drifts, resolved when back in band (hysteresis).
 *
 * The Meta day is the account's (America/Los_Angeles); FitFlow's is the business day. The card says
 * so; the 7-day windows absorb the 1-hour offset. Nothing here writes to Meta.
 */

import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db, appliedLedger, appliedRatioDaily, syncIncidents, syncRuns } from '@/db';
import { getMetaConfig } from '../meta/config';
import { chunkWindows, readMetaAccount } from '../meta/ingest';
import { fetchCampaignSubmits } from '../meta/client';
import { normalizeCampaign } from '../metrics';
import { getSetting, setSetting } from '../settings';
import { todayInTimezone } from '../day';
import { readMarker, writeMarker } from '../sync/markers';
import { judgeRatio, shift, type RatioDay, type RatioState, type RatioVerdict } from './ratioDrift';
import { FORM_CLASSES } from './applied';

export const RATIO_SUMMARY_KEY = 'applied_ratio_summary';
export const RATIO_INCIDENT_KIND = 'applied_ratio_drift';
/** 7 rolling + 28 baseline, plus one day so the two-consecutive-days rule can judge yesterday's window too. */
export const RATIO_WINDOW_DAYS = 36;

export interface CampaignRatio {
  campaignId: string;
  campaignName: string;
  campaignKey: string;
  verdict: RatioVerdict;
  days: Array<{ date: string; meta: number | null; fitflow: number; formApplicants: number }>;
}

export interface AppliedRatioSummary {
  ranAt: string;
  /** The last ACCOUNT day covered. */
  through: string;
  since: string;
  metaDayTz: string;
  campaigns: Array<{ campaignId: string; campaignName: string; campaignKey: string; state: RatioState; rolling7: number | null; baseline: number | null; meta7: number; fitflow7: number; text: string }>;
  /** Ledger rows (counted, last 7 days) whose utm matches no Meta campaign — the denominator gap. */
  unmatchedUtmRows: number;
  fetchedDays: number;
  errors: string[];
  metaAsOf: string | null;
}

export interface RatioRunResult {
  ok: boolean;
  notConfigured?: boolean;
  skipped?: string;
  partial?: boolean;
  runId: string | null;
  summary: AppliedRatioSummary | null;
  error?: string;
  reason?: string;
}

export async function readRatioSummary(): Promise<AppliedRatioSummary | null> {
  const raw = await getSetting(RATIO_SUMMARY_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppliedRatioSummary;
  } catch {
    return null;
  }
}

/** PURE: FitFlow's counts per (campaign key, day) from ledger rows. */
export function fitflowByCampaignDay(rows: Array<{ campaignKey: string | null; ledgerOn: string; verdictCurrent: boolean | null; class: string }>): Map<string, { applied: number; form: number }> {
  const out = new Map<string, { applied: number; form: number }>();
  for (const r of rows) {
    if (!r.verdictCurrent || !r.campaignKey) continue;
    const k = `${r.campaignKey}|${r.ledgerOn}`;
    const cur = out.get(k) ?? { applied: 0, form: 0 };
    cur.applied += 1;
    if (FORM_CLASSES.has(r.class as never)) cur.form += 1;
    out.set(k, cur);
  }
  return out;
}

export async function runAppliedRatio(options: { trigger: 'cron' | 'manual' | 'cli'; force?: boolean; today?: string }): Promise<RatioRunResult> {
  const startedAt = new Date();
  const config = await getMetaConfig();
  if (!config.configured) return { ok: false, notConfigured: true, runId: null, summary: await readRatioSummary(), error: 'Meta is not connected.' };
  const account = await readMetaAccount();
  if (!account?.timezone) return { ok: true, runId: null, summary: await readRatioSummary(), skipped: 'Meta account timezone unknown — the Meta sync records it on its next run' };
  const tz = account.timezone;
  const through = options.today ?? todayInTimezone(tz);
  const previous = await readRatioSummary();
  if (!options.force && previous?.through === through) {
    const marker = await readMarker('applied.ratio');
    if (marker) return { ok: true, runId: null, summary: previous, skipped: `already ran today at ${new Date(marker.completedAt).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })}` };
  }
  const ledgerMarker = await readMarker('applied.ledger');
  if (!ledgerMarker) return { ok: true, runId: null, summary: previous, skipped: 'waiting for the first Applied ledger run' };

  const [run] = await db.insert(syncRuns).values({ kind: 'applied_ratio', trigger: options.trigger, status: 'running', startedAt }).returning({ id: syncRuns.id });
  let requests = 0;
  try {
    const since = shift(through, -(RATIO_WINDOW_DAYS - 1));
    const errors: string[] = [];
    const fetchedDays = new Set<string>();
    const meta = new Map<string, { campaignId: string; campaignName: string; date: string; submits: number }>();
    const campaigns = new Map<string, string>(); // id → name
    for (const chunk of chunkWindows(since, through)) {
      const r = await fetchCampaignSubmits(chunk);
      requests += r.requests;
      if (r.error) {
        errors.push(`${chunk.since} – ${chunk.until}: ${r.error}`);
        continue;
      }
      for (let d = chunk.since; d <= chunk.until; d = shift(d, 1)) fetchedDays.add(d);
      for (const row of r.rows) {
        meta.set(`${row.campaignId}|${row.date}`, row);
        campaigns.set(row.campaignId, row.campaignName);
      }
    }
    // Campaigns already in the table stay in the monitor even when Meta returned no row for them this window.
    const known = await db.selectDistinct({ campaignId: appliedRatioDaily.campaignId, campaignName: appliedRatioDaily.campaignName }).from(appliedRatioDaily);
    for (const k of known) if (!campaigns.has(k.campaignId)) campaigns.set(k.campaignId, k.campaignName);

    const ledgerRows = await db
      .select({ campaignKey: appliedLedger.campaignKey, ledgerOn: appliedLedger.ledgerOn, verdictCurrent: appliedLedger.verdictCurrent, class: appliedLedger.class })
      .from(appliedLedger)
      .where(gte(appliedLedger.ledgerOn, shift(since, -1)));
    const fitflow = fitflowByCampaignDay(ledgerRows);
    const existing = new Map((await db.select({ campaignId: appliedRatioDaily.campaignId, date: appliedRatioDaily.date, metaSubmits: appliedRatioDaily.metaSubmits }).from(appliedRatioDaily).where(gte(appliedRatioDaily.date, since))).map((r) => [`${r.campaignId}|${r.date}`, r.metaSubmits]));

    const upserts: Array<typeof appliedRatioDaily.$inferInsert> = [];
    const perCampaign = new Map<string, RatioDay[]>();
    for (const [campaignId, campaignName] of campaigns) {
      const campaignKey = normalizeCampaign(campaignName);
      const days: RatioDay[] = [];
      for (let d = since; d <= through; d = shift(d, 1)) {
        const k = `${campaignId}|${d}`;
        const fetched = fetchedDays.has(d);
        const metaSubmits = fetched ? (meta.get(k)?.submits ?? 0) : (existing.get(k) ?? null);
        const ff = fitflow.get(`${campaignKey}|${d}`) ?? { applied: 0, form: 0 };
        upserts.push({ campaignId, date: d, campaignName, campaignKey, metaDayTz: tz, metaSubmits, fitflowApplied: ff.applied, fitflowFormApplicants: ff.form, fetchedAt: fetched ? startedAt : undefined, computedAt: startedAt });
        days.push({ date: d, meta: metaSubmits, fitflow: ff.applied });
      }
      perCampaign.set(campaignId, days);
    }
    for (let i = 0; i < upserts.length; i += 500) {
      const batch = upserts.slice(i, i + 500);
      await db
        .insert(appliedRatioDaily)
        .values(batch)
        .onConflictDoUpdate({
          target: [appliedRatioDaily.campaignId, appliedRatioDaily.date],
          set: {
            campaignName: sql`excluded.campaign_name`,
            campaignKey: sql`excluded.campaign_key`,
            metaDayTz: sql`excluded.meta_day_tz`,
            metaSubmits: sql`coalesce(excluded.meta_submits, ${appliedRatioDaily.metaSubmits})`,
            fitflowApplied: sql`excluded.fitflow_applied`,
            fitflowFormApplicants: sql`excluded.fitflow_form_applicants`,
            fetchedAt: sql`coalesce(excluded.fetched_at, ${appliedRatioDaily.fetchedAt})`,
            computedAt: sql`excluded.computed_at`,
          },
        });
    }

    // Drift per campaign, with ONE incident per campaign.
    const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, RATIO_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));
    const openByCampaign = new Map(open.map((i) => [String((i.details as { campaignId?: string } | null)?.campaignId ?? ''), i]));
    const summaryCampaigns: AppliedRatioSummary['campaigns'] = [];
    for (const [campaignId, campaignName] of campaigns) {
      const previousState = (openByCampaign.get(campaignId)?.details as { state?: RatioState } | null)?.state;
      const verdict = judgeRatio(perCampaign.get(campaignId) ?? [], through, previousState === 'drift_up' || previousState === 'drift_down' ? previousState : null);
      summaryCampaigns.push({ campaignId, campaignName, campaignKey: normalizeCampaign(campaignName), state: verdict.state, rolling7: verdict.rolling7, baseline: verdict.baseline, meta7: verdict.meta7, fitflow7: verdict.fitflow7, text: verdict.text });
      const drifting = verdict.state === 'drift_up' || verdict.state === 'drift_down' || verdict.state === 'broken_meta' || verdict.state === 'broken_fitflow';
      const existingIncident = openByCampaign.get(campaignId);
      const message = `Applied ratio · ${campaignName}: ${verdict.text}`;
      const details = { campaignId, campaignName, state: verdict.state, rolling7: verdict.rolling7, baseline: verdict.baseline, meta7: verdict.meta7, fitflow7: verdict.fitflow7, through };
      if (drifting) {
        if (existingIncident) await db.update(syncIncidents).set({ message, details, severity: 'warning' }).where(eq(syncIncidents.id, existingIncident.id));
        else await db.insert(syncIncidents).values({ syncRunId: run.id, kind: RATIO_INCIDENT_KIND, severity: 'warning', message, details });
      } else if (existingIncident) {
        await db.update(syncIncidents).set({ resolvedAt: startedAt, details: { ...(existingIncident.details ?? {}), resolvedBy: verdict.text } }).where(eq(syncIncidents.id, existingIncident.id));
      }
    }
    // Incidents for campaigns Meta no longer lists resolve too.
    for (const [campaignId, inc] of openByCampaign) if (!campaigns.has(campaignId)) await db.update(syncIncidents).set({ resolvedAt: startedAt, details: { ...(inc.details ?? {}), resolvedBy: 'campaign no longer reported by Meta' } }).where(eq(syncIncidents.id, inc.id));

    // The denominator gap: counted rows in the last 7 business days whose utm matches no Meta campaign.
    const keys = new Set([...campaigns.values()].map((n) => normalizeCampaign(n)));
    const unmatchedUtmRows = ledgerRows.filter((r) => r.verdictCurrent && r.ledgerOn >= shift(through, -6) && (!r.campaignKey || !keys.has(r.campaignKey))).length;

    const metaMarker = await readMarker('meta.spend');
    const summary: AppliedRatioSummary = { ranAt: startedAt.toISOString(), through, since, metaDayTz: tz, campaigns: summaryCampaigns, unmatchedUtmRows, fetchedDays: fetchedDays.size, errors, metaAsOf: metaMarker?.completedAt ?? null };
    await setSetting(RATIO_SUMMARY_KEY, JSON.stringify(summary));
    if (errors.length === 0) await writeMarker({ family: 'applied.ratio', runId: run.id, fetched: upserts.length, detail: `${campaigns.size} campaigns · ${fetchedDays.size} days` });
    const states = summaryCampaigns.map((c) => `${c.campaignName} ${c.state}${c.rolling7 !== null ? ` ${c.rolling7.toFixed(2)}×` : ''}`).join(' · ');
    const reason = `${campaigns.size} campaigns · ${fetchedDays.size}/${RATIO_WINDOW_DAYS} days fetched · ${states || 'no campaigns'}${unmatchedUtmRows ? ` · ${unmatchedUtmRows} counted rows match no campaign` : ''}${errors.length ? ` · ${errors.length} chunk error(s): ${errors[0]}` : ''}`;
    const partial = errors.length > 0;
    await db.update(syncRuns).set({ status: partial ? 'partial' : 'succeeded', finishedAt: new Date(), requestsUsed: requests, stats: { campaigns: campaigns.size, fetchedDays: fetchedDays.size, unmatchedUtmRows, reason, ...(partial ? { partial: 'true' } : {}) }, warnings: errors, error: partial ? errors[0] : null }).where(eq(syncRuns.id, run.id));
    return { ok: true, partial, runId: run.id, summary, reason, ...(partial ? { error: errors[0] } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(syncRuns).set({ status: 'failed', finishedAt: new Date(), requestsUsed: requests, error: message, stats: { reason: message } }).where(eq(syncRuns.id, run.id));
    await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Applied ratio monitor failed: ${message}` });
    return { ok: false, runId: run.id, summary: previous, error: message };
  }
}

/** The dispatch step. */
export async function runAppliedRatioStep(opts: { force?: boolean } = {}): Promise<RatioRunResult | { skipped: string }> {
  const r = await runAppliedRatio({ trigger: 'cron', force: opts.force });
  if (r.skipped) return { skipped: r.skipped };
  return r;
}

/** For the card: every campaign's last `days` rows. */
export async function ratioRows(days = 7): Promise<CampaignRatio[]> {
  const summary = await readRatioSummary();
  if (!summary) return [];
  const since = shift(summary.through, -(days - 1));
  const rows = await db.select().from(appliedRatioDaily).where(and(gte(appliedRatioDaily.date, since), inArray(appliedRatioDaily.campaignId, summary.campaigns.map((c) => c.campaignId).concat(['-']))));
  return summary.campaigns.map((c) => ({
    campaignId: c.campaignId,
    campaignName: c.campaignName,
    campaignKey: c.campaignKey,
    verdict: { state: c.state, rolling7: c.rolling7, baseline: c.baseline, meta7: c.meta7, fitflow7: c.fitflow7, meta28: 0, fitflow28: 0, missingDays: [], text: c.text },
    days: rows.filter((r) => r.campaignId === c.campaignId).sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, meta: r.metaSubmits, fitflow: r.fitflowApplied, formApplicants: r.fitflowFormApplicants })),
  }));
}
