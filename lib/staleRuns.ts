/**
 * Stale sync-run sweeper.
 *
 * A serverless function that dies mid-sync leaves its sync_runs row stuck at
 * status='running' forever (observed twice on the 2026-09-01 first real run).
 * No cron route can outlive `maxDuration` (300s), so any 'running' row older
 * than STALE_RUN_MINUTES is dead. Every sync start sweeps them to
 * status='failed' with a distinctive error, and sync-health presents
 * not-yet-swept ones the same way rather than pretending they are alive.
 */

import { and, eq, lt } from 'drizzle-orm';
import { db, syncRuns } from '@/db';

export const STALE_RUN_MINUTES = 10;
export const STALE_RUN_ERROR = 'timed out (stale)';

export function isStaleRun(status: string, startedAt: Date, now: Date = new Date()): boolean {
  return status === 'running' && now.getTime() - startedAt.getTime() > STALE_RUN_MINUTES * 60_000;
}

/** Mark dead 'running' rows failed. Returns how many were swept. */
export async function sweepStaleRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);
  const swept = await db
    .update(syncRuns)
    .set({ status: 'failed', finishedAt: now, error: STALE_RUN_ERROR })
    .where(and(eq(syncRuns.status, 'running'), lt(syncRuns.startedAt, cutoff)))
    .returning({ id: syncRuns.id });
  return swept.length;
}
