import { NextResponse } from 'next/server';
import { desc, isNull, and, eq } from 'drizzle-orm';
import { db, syncRuns, syncIncidents, stages, pipelines } from '@/db';
import { getGhlConfig } from '@/lib/ghl/config';
import { getMetaConfig } from '@/lib/meta/config';
import { getStripeConfig } from '@/lib/stripe/config';
import { getGoogleAdsConfig } from '@/lib/googleads/config';
import { ROLE_LABELS, SEMANTIC_ROLES } from '@/lib/ghl/roles';
import { sentryConfigured } from '@/lib/sentry';
import { isStaleRun, STALE_RUN_ERROR } from '@/lib/staleRuns';
import { readReconcileSummary } from '@/lib/ghl/reconcile';

export const dynamic = 'force-dynamic';

export interface SourceHealth {
  key: 'ghl' | 'meta' | 'stripe' | 'google';
  label: string;
  configured: boolean;
  pending?: boolean;
  cadence: string;
  lastRun: {
    id: string;
    kind: string;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    requestsUsed: number;
    rowsUpserted: number;
    rejectedRows: number;
    error: string | null;
    warnings: string[];
  } | null;
}

const SOURCES: Array<{ key: SourceHealth['key']; label: string; kinds: string[]; cadence: string; rowKeys: string[] }> = [
  { key: 'ghl', label: 'GoHighLevel', kinds: ['ghl_delta', 'ghl_backfill'], cadence: 'hourly', rowKeys: ['contactsUpserted', 'appointmentsUpserted'] },
  { key: 'meta', label: 'Meta Ads', kinds: ['meta_delta', 'meta_backfill'], cadence: 'daily (dispatch)', rowKeys: ['rows'] },
  { key: 'stripe', label: 'Stripe', kinds: ['stripe_reconcile', 'stripe_backfill'], cadence: 'daily (dispatch) + webhook', rowKeys: ['charges', 'subscriptions', 'refunds', 'rows', 'payments'] },
  { key: 'google', label: 'Google Ads', kinds: ['google_delta', 'google_backfill'], cadence: 'daily (dispatch) / CSV', rowKeys: ['rows'] },
];

export async function GET() {
  try {
    const [ghl, meta, stripe, google] = await Promise.all([getGhlConfig(), getMetaConfig(), getStripeConfig(), getGoogleAdsConfig()]);
    const configuredBy: Record<SourceHealth['key'], boolean> = { ghl: ghl.configured, meta: meta.configured, stripe: stripe.configured, google: google.configured };

    // A 'running' row whose function died stays 'running' until the next sync
    // sweeps it (lib/staleRuns). Present it as what it is — failed — rather
    // than pretending a sync is alive.
    const now = new Date();
    const runs = (await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(300)).map((r) =>
      isStaleRun(r.status, r.startedAt, now) ? { ...r, status: 'failed', error: r.error ?? STALE_RUN_ERROR } : r,
    );
    const sources: SourceHealth[] = SOURCES.map((s) => {
      const r = runs.find((run) => s.kinds.includes(run.kind));
      const stats = (r?.stats ?? {}) as Record<string, number>;
      return {
        key: s.key,
        label: s.label,
        configured: configuredBy[s.key],
        pending: s.key === 'google' ? google.pending : undefined,
        cadence: s.cadence,
        lastRun: r
          ? {
              id: r.id,
              kind: r.kind,
              trigger: r.trigger,
              status: r.status,
              startedAt: r.startedAt.toISOString(),
              finishedAt: r.finishedAt?.toISOString() ?? null,
              durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
              requestsUsed: r.requestsUsed,
              rowsUpserted: s.rowKeys.reduce((sum, k) => sum + (stats[k] ?? 0), 0),
              rejectedRows: stats.rejectedRows ?? 0,
              error: r.error,
              warnings: r.warnings ?? [],
            }
          : null,
      };
    });

    const unmappedRows = await db
      .select({
        id: stages.id,
        name: stages.name,
        pipelineName: pipelines.name,
        suggestedRole: stages.suggestedRole,
        roleConfidence: stages.roleConfidence,
      })
      .from(stages)
      .innerJoin(pipelines, eq(stages.pipelineId, pipelines.id))
      // Followed pipelines only: unmapped stages in the dozens of pipelines
      // nobody follows are not a human's problem (Jake's account: 107 stages).
      .where(and(isNull(stages.semanticRole), isNull(stages.archivedAt), eq(pipelines.isTracked, true), isNull(pipelines.archivedAt)));

    const open = await db.select().from(syncIncidents).where(isNull(syncIncidents.resolvedAt)).orderBy(desc(syncIncidents.createdAt)).limit(100);

    return NextResponse.json({
      sources,
      unmappedStages: unmappedRows,
      roles: SEMANTIC_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
      incidents: open.map((i) => ({ ...i, createdAt: i.createdAt.toISOString(), resolvedAt: null })),
      recentRuns: runs.slice(0, 15).map((r) => ({
        id: r.id,
        kind: r.kind,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        requestsUsed: r.requestsUsed,
        stats: r.stats,
        error: r.error,
      })),
      sentry: sentryConfigured(),
      reconcile: await readReconcileSummary(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read sync health', detail: String(error) }, { status: 500 });
  }
}
