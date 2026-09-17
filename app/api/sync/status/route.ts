import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, syncRuns } from '@/db';
import { getGhlConfig } from '@/lib/ghl/config';
import { getSetting, SETTING_KEYS } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** Pipeline data older than this is called out on every data page. */
export const STALE_AFTER_HOURS = 26;

/**
 * GET /api/sync/status — cheap freshness check for the stale-data banner
 * (no GHL request, unlike /api/sync). "Last successful" = the newest GHL run
 * that completed a full cycle (status succeeded); partial runs are progress,
 * not freshness.
 */
export async function GET() {
  try {
    const [config, [lastSuccess], [lastRun], cursorRaw] = await Promise.all([
      getGhlConfig(),
      db
        .select({ finishedAt: syncRuns.finishedAt, startedAt: syncRuns.startedAt, kind: syncRuns.kind })
        .from(syncRuns)
        .where(and(inArray(syncRuns.kind, ['ghl_delta', 'ghl_backfill']), eq(syncRuns.status, 'succeeded')))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1),
      db
        .select({ startedAt: syncRuns.startedAt, status: syncRuns.status, kind: syncRuns.kind })
        .from(syncRuns)
        .where(inArray(syncRuns.kind, ['ghl_delta', 'ghl_backfill']))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1),
      getSetting(SETTING_KEYS.ghlSyncCursor),
    ]);
    const lastSuccessAt = lastSuccess?.finishedAt ?? lastSuccess?.startedAt ?? null;
    const ageHours = lastSuccessAt ? (Date.now() - lastSuccessAt.getTime()) / 3_600_000 : null;
    let inProgress = false;
    try {
      inProgress = Boolean(cursorRaw && JSON.parse(cursorRaw));
    } catch {
      inProgress = false;
    }
    return NextResponse.json({
      configured: config.configured,
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      lastRunAt: lastRun?.startedAt.toISOString() ?? null,
      lastRunStatus: lastRun?.status ?? null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      stale: config.configured && (ageHours === null || ageHours > STALE_AFTER_HOURS),
      staleAfterHours: STALE_AFTER_HOURS,
      inProgress,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read sync status', detail: String(error) }, { status: 500 });
  }
}
