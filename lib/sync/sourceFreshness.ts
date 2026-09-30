/**
 * Source freshness — ONE reader for the stale banner (`/api/sync/status`) and
 * the Analyst's `get_data_health` / every tool result's `freshness` field, so
 * a page and the Analyst can never disagree about what is stale.
 *
 * Ingestion v2 (2026-09-30): freshness is read ONLY from the markers the
 * fetching code writes (lib/sync/markers.ts) — never from "a run succeeded".
 * A connected source's family is stale when its marker is older than
 * STALE_AFTER_HOURS (3 h — the schedule is hourly) or missing. Also: the
 * scheduler-silent check and the last reconciliation verdict.
 */

import { getGhlConfig } from '../ghl/config';
import { getMetaConfig } from '../meta/config';
import { getStripeConfig } from '../stripe/config';
import { readReconcileSummary } from '../ghl/reconcile';
import { readGhlFreshness } from './ghlFreshness';
import { STALE_AFTER_HOURS, markerFreshness, type FamilyFreshness } from './freshness';
import { readMarker } from './markers';
import { checkSchedulerSilence, type SchedulerLastRun } from './scheduler';

export { STALE_AFTER_HOURS };

export interface SourceFreshness {
  key: 'ghl' | 'meta' | 'stripe';
  label: string;
  configured: boolean;
  /** When the source's data family last COMPLETED — its freshness marker (never run activity). */
  lastSuccessAt: string | null;
  lastRunStatus: string | null;
  ageHours: number | null;
  stale: boolean;
  /** GHL only: freshness PER DATA FAMILY (stages/opportunities vs appointments) — the banner names the stale family. */
  families?: FamilyFreshness[];
  /** One line naming what is stale and since when (families for GHL). */
  detail?: string;
  /** Rows the last completed fetch read (from its marker). */
  fetched?: number | null;
  /** POST here to sync this source now. */
  syncEndpoint: string;
  syncBody: Record<string, string>;
}

export interface SyncStatus {
  stale: boolean;
  staleAfterHours: number;
  sources: SourceFreshness[];
  staleSources: SourceFreshness[];
  scheduler: { lastRun: SchedulerLastRun | null; silent: boolean; ageHours: number | null; detail: string | null };
  reconcile: { at: string; ok: boolean; mismatches: number; stagesChecked: number } | null;
}

const SOURCES: Array<{ key: SourceFreshness['key']; label: string; syncEndpoint: string; syncBody: Record<string, string> }> = [
  { key: 'ghl', label: 'GoHighLevel pipeline', syncEndpoint: '/api/sync', syncBody: {} },
  { key: 'meta', label: 'Meta Ads spend', syncEndpoint: '/api/meta/sync', syncBody: { mode: 'delta' } },
  { key: 'stripe', label: 'Stripe payments', syncEndpoint: '/api/stripe/sync', syncBody: { mode: 'reconcile' } },
];

export async function readSyncStatus(now: number = Date.now()): Promise<SyncStatus> {
  const [ghl, meta, stripe, reconcile, metaMarker, stripeMarker] = await Promise.all([
    getGhlConfig(), getMetaConfig(), getStripeConfig(), readReconcileSummary(), readMarker('meta.spend'), readMarker('stripe.payments'),
  ]);
  const configured: Record<SourceFreshness['key'], boolean> = { ghl: ghl.configured, meta: meta.configured, stripe: stripe.configured };
  const scheduler = await checkSchedulerSilence(new Date(now));

  const sources: SourceFreshness[] = [];
  for (const s of SOURCES) {
    if (s.key === 'ghl') {
      const g = await readGhlFreshness(now);
      const worst = g.families.reduce<FamilyFreshness | null>((a, f) => (!a || (f.ageHours ?? Infinity) > (a.ageHours ?? Infinity) ? f : a), null);
      sources.push({
        key: s.key,
        label: s.label,
        configured: configured[s.key],
        lastSuccessAt: worst?.completedAt ?? null,
        lastRunStatus: g.lastRunStatus,
        ageHours: worst?.ageHours ?? null,
        stale: configured[s.key] && g.stale,
        families: g.families,
        fetched: g.markers.opportunities?.fetched ?? null,
        detail: g.staleFamilies.length ? g.staleFamilies.map((f) => f.detail).join('; ') : undefined,
        syncEndpoint: s.syncEndpoint,
        syncBody: s.syncBody,
      });
      continue;
    }
    const f = markerFreshness({ label: s.label, marker: s.key === 'meta' ? metaMarker : stripeMarker, now });
    sources.push({
      key: s.key,
      label: s.label,
      configured: configured[s.key],
      lastSuccessAt: f.completedAt,
      lastRunStatus: null,
      ageHours: f.ageHours,
      stale: configured[s.key] && f.stale,
      fetched: f.fetched,
      detail: configured[s.key] && f.stale ? f.detail : undefined,
      syncEndpoint: s.syncEndpoint,
      syncBody: s.syncBody,
    });
  }

  return {
    stale: sources.some((s) => s.stale) || scheduler.silent,
    staleAfterHours: STALE_AFTER_HOURS,
    sources,
    staleSources: sources.filter((s) => s.stale),
    scheduler: { lastRun: scheduler.last, silent: scheduler.silent, ageHours: scheduler.ageHours, detail: scheduler.detail },
    reconcile: reconcile ? { at: reconcile.at, ok: reconcile.ok, mismatches: reconcile.mismatches.length, stagesChecked: reconcile.stagesChecked } : null,
  };
}

/** The compact freshness block every Analyst tool result carries: "data fresh 12 min ago" or what is stale. */
export function freshnessSummary(status: SyncStatus): { stale: boolean; line: string; sources: Array<{ key: string; configured: boolean; stale: boolean; ageHours: number | null; detail: string | null }> } {
  const configured = status.sources.filter((s) => s.configured);
  const newest = configured.reduce<number | null>((a, s) => (s.ageHours === null ? a : a === null ? s.ageHours : Math.max(a, s.ageHours)), null);
  const staleNames = status.staleSources.map((s) => `${s.label}${s.detail ? ` (${s.detail})` : s.ageHours !== null ? ` (last completed ${s.ageHours.toFixed(1)} h ago)` : ' (never completed)'}`);
  const line = status.scheduler.silent
    ? `STALE — the scheduler has been silent${status.scheduler.detail ? `: ${status.scheduler.detail}` : ''}`
    : staleNames.length
      ? `STALE — ${staleNames.join('; ')}`
      : configured.length === 0
        ? 'no sources connected'
        : newest === null
          ? 'fresh'
          : `data fresh — oldest connected source completed ${newest < 1 ? `${Math.round(newest * 60)} min` : `${newest.toFixed(1)} h`} ago`;
  return { stale: status.stale, line, sources: status.sources.map((s) => ({ key: s.key, configured: s.configured, stale: s.stale, ageHours: s.ageHours, detail: s.detail ?? null })) };
}
