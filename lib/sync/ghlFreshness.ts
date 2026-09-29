/**
 * The GHL data families' freshness, read from the markers the cycle writes
 * (lib/ghl/ingest.ts) — one reader so /api/sync/status and /api/sync-health
 * cannot disagree. A marker missing on a database that predates the
 * order-by-value cycle falls back to the last COMPLETED run, which is exactly
 * what the old banner keyed off.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { getSetting, SETTING_KEYS } from '../settings';
import { familyFreshness, GHL_FAMILIES, type FamilyFreshness } from './freshness';

const GHL_KINDS = ['ghl_delta', 'ghl_backfill'];

export interface GhlFreshness {
  families: FamilyFreshness[];
  /** Newest GHL run of any status. */
  lastRunAt: string | null;
  lastRunStatus: string | null;
  /** Newest run that completed a whole cycle (status succeeded). */
  lastSuccessAt: string | null;
  /** cycleStartedAt of the last cycle whose tracked phases completed (reconciliation eligibility). */
  trackedCompletedAt: string | null;
  stale: boolean;
  staleFamilies: FamilyFreshness[];
}

export async function readGhlFreshness(now: number = Date.now()): Promise<GhlFreshness> {
  const [oppsAt, apptsAt, trackedAt] = await Promise.all([
    getSetting(SETTING_KEYS.ghlTrackedOppsCompletedAt),
    getSetting(SETTING_KEYS.ghlAppointmentsCompletedAt),
    getSetting(SETTING_KEYS.ghlTrackedCompletedAt),
  ]);
  const [success] = await db
    .select({ finishedAt: syncRuns.finishedAt, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(and(inArray(syncRuns.kind, GHL_KINDS), eq(syncRuns.status, 'succeeded')))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  const [last] = await db.select({ status: syncRuns.status, startedAt: syncRuns.startedAt }).from(syncRuns).where(inArray(syncRuns.kind, GHL_KINDS)).orderBy(desc(syncRuns.startedAt)).limit(1);
  const successAt = success?.finishedAt ?? success?.startedAt ?? null;
  const lastRunAt = last?.startedAt ?? null;
  const marker = { stages_opportunities: oppsAt || null, appointments: apptsAt || null } as const;
  const families = GHL_FAMILIES.map((f) => familyFreshness({ key: f.key, completedAt: marker[f.key] ?? successAt, lastRunAt, now }));
  const staleFamilies = families.filter((f) => f.stale);
  return {
    families,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastRunStatus: last?.status ?? null,
    lastSuccessAt: successAt?.toISOString() ?? null,
    trackedCompletedAt: trackedAt || null,
    stale: staleFamilies.length > 0,
    staleFamilies,
  };
}
