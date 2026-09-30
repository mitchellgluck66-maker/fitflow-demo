/**
 * The GHL data families' freshness, read ONLY from the markers the fetching code writes (lib/sync/markers.ts,
 * Ingestion v2 2026-09-30) — one reader so /api/sync/status and /api/sync-health cannot disagree. There is no
 * fallback to "the last run that succeeded": that is exactly how a frozen pipeline read as fresh (F1). No marker
 * yet = never completed = stale.
 */
import { desc, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { readMarker, type Marker } from './markers';
import { familyFreshness, GHL_FAMILIES, type FamilyFreshness } from './freshness';

const GHL_KINDS = ['ghl_delta', 'ghl_backfill'];

export interface GhlFreshness {
  families: FamilyFreshness[];
  /** Newest GHL run of any status. */
  lastRunAt: string | null;
  lastRunStatus: string | null;
  /** When the followed pipeline was last fully read (the ghl.opportunities marker). */
  trackedCompletedAt: string | null;
  /** The markers themselves (counts included) for Sync health. */
  markers: { opportunities: Marker | null; appointments: Marker | null; mirrors: Marker | null };
  stale: boolean;
  staleFamilies: FamilyFreshness[];
}

export async function readGhlFreshness(now: number = Date.now()): Promise<GhlFreshness> {
  const [opportunities, appointments, mirrors] = await Promise.all([readMarker('ghl.opportunities'), readMarker('ghl.appointments'), readMarker('ghl.mirrors')]);
  const [last] = await db.select({ status: syncRuns.status, startedAt: syncRuns.startedAt }).from(syncRuns).where(inArray(syncRuns.kind, GHL_KINDS)).orderBy(desc(syncRuns.startedAt)).limit(1);
  const lastRunAt = last?.startedAt ?? null;
  const marker = { stages_opportunities: opportunities?.completedAt ?? null, appointments: appointments?.completedAt ?? null } as const;
  const families = GHL_FAMILIES.map((f) => familyFreshness({ key: f.key, completedAt: marker[f.key], lastRunAt, now }));
  const staleFamilies = families.filter((f) => f.stale);
  return {
    families,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastRunStatus: last?.status ?? null,
    trackedCompletedAt: opportunities?.completedAt ?? null,
    markers: { opportunities, appointments, mirrors },
    stale: staleFamilies.length > 0,
    staleFamilies,
  };
}
