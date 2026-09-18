import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { getGhlConfig } from '@/lib/ghl/config';
import { getMetaConfig } from '@/lib/meta/config';
import { getStripeConfig } from '@/lib/stripe/config';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
import { readReconcileSummary } from '@/lib/ghl/reconcile';

export const dynamic = 'force-dynamic';

/** Data older than this is called out on every data page. */
export const STALE_AFTER_HOURS = 26;

export interface SourceFreshness {
  key: 'ghl' | 'meta' | 'stripe';
  label: string;
  configured: boolean;
  /** Newest run that COMPLETED (status succeeded) — partial runs are progress, not freshness. */
  lastSuccessAt: string | null;
  lastRunStatus: string | null;
  ageHours: number | null;
  stale: boolean;
  /** POST here to sync this source now. */
  syncEndpoint: string;
  syncBody: Record<string, string>;
}

const SOURCES: Array<{ key: SourceFreshness['key']; label: string; kinds: string[]; syncEndpoint: string; syncBody: Record<string, string> }> = [
  { key: 'ghl', label: 'GoHighLevel pipeline', kinds: ['ghl_delta', 'ghl_backfill'], syncEndpoint: '/api/sync', syncBody: {} },
  { key: 'meta', label: 'Meta Ads spend', kinds: ['meta_delta', 'meta_backfill'], syncEndpoint: '/api/meta/sync', syncBody: { mode: 'delta' } },
  { key: 'stripe', label: 'Stripe payments', kinds: ['stripe_reconcile', 'stripe_backfill'], syncEndpoint: '/api/stripe/sync', syncBody: { mode: 'reconcile' } },
];

/**
 * GET /api/sync/status — cheap freshness check for the stale-data banner
 * (no external request). A connected source whose last completed run is
 * older than 26h (or that never completed one) is stale, and the banner
 * offers that source's own sync button. Also carries the last
 * reconciliation verdict so drift shows where Jake looks.
 */
export async function GET() {
  try {
    const [ghl, meta, stripe, cursorRaw, reconcile] = await Promise.all([getGhlConfig(), getMetaConfig(), getStripeConfig(), getSetting(SETTING_KEYS.ghlSyncCursor), readReconcileSummary()]);
    const configured: Record<SourceFreshness['key'], boolean> = { ghl: ghl.configured, meta: meta.configured, stripe: stripe.configured };
    const now = Date.now();

    const sources: SourceFreshness[] = [];
    for (const s of SOURCES) {
      const [success] = await db
        .select({ finishedAt: syncRuns.finishedAt, startedAt: syncRuns.startedAt })
        .from(syncRuns)
        .where(and(inArray(syncRuns.kind, s.kinds), eq(syncRuns.status, 'succeeded')))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1);
      const [last] = await db.select({ status: syncRuns.status }).from(syncRuns).where(inArray(syncRuns.kind, s.kinds)).orderBy(desc(syncRuns.startedAt)).limit(1);
      const at = success?.finishedAt ?? success?.startedAt ?? null;
      const ageHours = at ? (now - at.getTime()) / 3_600_000 : null;
      sources.push({
        key: s.key,
        label: s.label,
        configured: configured[s.key],
        lastSuccessAt: at?.toISOString() ?? null,
        lastRunStatus: last?.status ?? null,
        ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
        stale: configured[s.key] && (ageHours === null || ageHours > STALE_AFTER_HOURS),
        syncEndpoint: s.syncEndpoint,
        syncBody: s.syncBody,
      });
    }

    let inProgress = false;
    try {
      inProgress = Boolean(cursorRaw && JSON.parse(cursorRaw));
    } catch {
      inProgress = false;
    }
    const ghlRow = sources.find((s) => s.key === 'ghl')!;
    return NextResponse.json({
      // Back-compat fields (GHL) for anything still reading the old shape.
      configured: ghlRow.configured,
      lastSuccessAt: ghlRow.lastSuccessAt,
      lastRunStatus: ghlRow.lastRunStatus,
      ageHours: ghlRow.ageHours,
      stale: sources.some((s) => s.stale),
      staleAfterHours: STALE_AFTER_HOURS,
      inProgress,
      sources,
      staleSources: sources.filter((s) => s.stale),
      reconcile: reconcile ? { at: reconcile.at, ok: reconcile.ok, mismatches: reconcile.mismatches.length, stagesChecked: reconcile.stagesChecked } : null,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read sync status', detail: String(error) }, { status: 500 });
  }
}
