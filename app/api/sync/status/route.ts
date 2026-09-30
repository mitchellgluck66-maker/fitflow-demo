import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { getGhlConfig } from '@/lib/ghl/config';
import { getMetaConfig } from '@/lib/meta/config';
import { getStripeConfig } from '@/lib/stripe/config';
import { readReconcileSummary } from '@/lib/ghl/reconcile';
import { readGhlFreshness } from '@/lib/sync/ghlFreshness';
import { STALE_AFTER_HOURS, markerFreshness, type FamilyFreshness } from '@/lib/sync/freshness';
import { readMarker } from '@/lib/sync/markers';
import { checkSchedulerSilence } from '@/lib/sync/scheduler';

export const dynamic = 'force-dynamic';

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

const SOURCES: Array<{ key: SourceFreshness['key']; label: string; kinds: string[]; syncEndpoint: string; syncBody: Record<string, string> }> = [
  { key: 'ghl', label: 'GoHighLevel pipeline', kinds: ['ghl_delta', 'ghl_backfill'], syncEndpoint: '/api/sync', syncBody: {} },
  { key: 'meta', label: 'Meta Ads spend', kinds: ['meta_delta', 'meta_backfill'], syncEndpoint: '/api/meta/sync', syncBody: { mode: 'delta' } },
  { key: 'stripe', label: 'Stripe payments', kinds: ['stripe_delta', 'stripe_reconcile', 'stripe_backfill'], syncEndpoint: '/api/stripe/sync', syncBody: { mode: 'reconcile' } },
];

/**
 * GET /api/sync/status — the stale-data banner (no external request), called on every page view.
 * Ingestion v2 (2026-09-30): freshness is read ONLY from the markers the fetching code writes
 * (lib/sync/markers.ts) — never from "a run succeeded". A connected source's family is stale when its marker is
 * older than STALE_AFTER_HOURS (3 h — the schedule is hourly) or missing. Also: the scheduler-silent check (no
 * scheduled run for 3 h → critical incident + banner line) and the last reconciliation verdict.
 */
export async function GET() {
  try {
    const [ghl, meta, stripe, reconcile, metaMarker, stripeMarker] = await Promise.all([
      getGhlConfig(), getMetaConfig(), getStripeConfig(), readReconcileSummary(), readMarker('meta.spend'), readMarker('stripe.payments'),
    ]);
    const configured: Record<SourceFreshness['key'], boolean> = { ghl: ghl.configured, meta: meta.configured, stripe: stripe.configured };
    const now = Date.now();
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

    const ghlRow = sources.find((s) => s.key === 'ghl')!;
    return NextResponse.json({
      // Back-compat fields (GHL) for anything still reading the old shape.
      configured: ghlRow.configured,
      lastSuccessAt: ghlRow.lastSuccessAt,
      lastRunStatus: ghlRow.lastRunStatus,
      ageHours: ghlRow.ageHours,
      stale: sources.some((s) => s.stale) || scheduler.silent,
      staleAfterHours: STALE_AFTER_HOURS,
      sources,
      staleSources: sources.filter((s) => s.stale),
      scheduler: { lastRun: scheduler.last, silent: scheduler.silent, ageHours: scheduler.ageHours, detail: scheduler.detail },
      reconcile: reconcile ? { at: reconcile.at, ok: reconcile.ok, mismatches: reconcile.mismatches.length, stagesChecked: reconcile.stagesChecked } : null,
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read sync status');
  }
}
