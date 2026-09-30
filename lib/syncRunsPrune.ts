/**
 * sync_runs retention (2026-09-29, with the hourly heartbeat).
 *
 * The dispatch writes one `dispatch:<step>` row per step per run (~13 × 24 a
 * day) on top of each source's own rows. Nightly — once per business-local
 * day, from the dispatch — rows older than SYNC_RUN_RETENTION_DAYS are
 * deleted, EXCEPT the latest row per (kind, status): Sync health's "last run"
 * and the freshness fallback ("last completed run") must survive even for a
 * source idle for months. Incidents keep their text (FK is ON DELETE SET NULL).
 */

import { and, desc, lt, notInArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from './settings';

export const SYNC_RUN_RETENTION_DAYS = 30;

/** Delete old sync_runs rows (keeping the newest per kind + status). Returns how many were removed. */
export async function pruneSyncRuns(now: Date = new Date(), retentionDays = SYNC_RUN_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const newestPerKindStatus = db
    .selectDistinctOn([syncRuns.kind, syncRuns.status], { id: syncRuns.id })
    .from(syncRuns)
    .orderBy(syncRuns.kind, syncRuns.status, desc(syncRuns.startedAt));
  const removed = await db
    .delete(syncRuns)
    .where(and(lt(syncRuns.startedAt, cutoff), notInArray(syncRuns.id, newestPerKindStatus)))
    .returning({ id: syncRuns.id });
  return removed.length;
}

/** The dispatch step: prune at most once per business-local day (`today` = YYYY-MM-DD in the business tz). */
export async function runNightlyPrune(today: string, opts: { force?: boolean; now?: Date } = {}): Promise<{ ok: true; removed: number; skipped?: string }> {
  if (!opts.force && (await getSetting(SETTING_KEYS.syncRunsPrunedOn)) === today) {
    return { ok: true, removed: 0, skipped: `already pruned today (${today})` };
  }
  const removed = await pruneSyncRuns(opts.now);
  await setSetting(SETTING_KEYS.syncRunsPrunedOn, today);
  return { ok: true, removed, ...(removed === 0 ? { skipped: 'nothing older than 30 days to prune' } : {}) };
}
