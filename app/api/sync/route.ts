import { NextRequest, NextResponse } from 'next/server';
import { db, syncRuns, syncIncidents } from '@/db';
import { desc, isNull } from 'drizzle-orm';
import { runGhlSync, type SyncResult } from '@/lib/ghl/ingest';
import { readMarker } from '@/lib/sync/markers';
import { testConnection } from '@/lib/ghl/client';
import { getSetting, getTimezone, SETTING_KEYS } from '@/lib/settings';
import { ENABLE_WRITEBACK } from '@/lib/ghl/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** GET /api/sync — recent runs, open incidents, connection state. */
export async function GET() {
  try {
    const [runs, incidents, connection, lastSyncAt] = await Promise.all([
      db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(20),
      db.select().from(syncIncidents).where(isNull(syncIncidents.resolvedAt)).orderBy(desc(syncIncidents.createdAt)).limit(50),
      testConnection(),
      getSetting(SETTING_KEYS.ghlLastSyncAt),
    ]);
    return NextResponse.json({
      readOnly: true,
      writebackEnabled: ENABLE_WRITEBACK,
      connection,
      lastSyncAt,
      runs: runs.map((r) => ({
        ...r,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        since: r.since?.toISOString() ?? null,
      })),
      incidents: incidents.map((i) => ({ ...i, createdAt: i.createdAt.toISOString(), resolvedAt: null })),
      // Legacy shape for the old nav badge.
      stats: { isDryRun: false, pending: 0 },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read sync status', detail: String(error) }, { status: 500 });
  }
}

/**
 * POST /api/sync — "Sync now" (Ingestion v2, 2026-09-30). ALWAYS refreshes the followed pipeline first (the weekly
 * mirror pass is skipped here), inside the request: budget 200 s < maxDuration 300 s.
 *   Works → 200 { refreshed: true, opportunities, refreshedAt, message: "Followed pipeline: N opportunities refreshed at <time>" }
 *   Fails → { refreshed: false, message: the reason } — never a bare "Sync complete".
 * Body: { full?: true } re-fetches every contact.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await runGhlSync({ mode: 'delta', trigger: 'manual', mirrors: 'skip', full: body.full === true, budgetMs: SYNC_NOW_BUDGET_MS });
    return NextResponse.json(await describeSyncNow(result), { status: result.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, refreshed: false, message: `Sync failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
  }
}

/** The request's own budget — leaves 100 s of the 300 s maxDuration for the response. */
const SYNC_NOW_BUDGET_MS = 200_000;

async function describeSyncNow(result: SyncResult) {
  const base = { ok: result.ok, partial: result.partial, skipped: result.skipped ?? null, runId: result.runId || null, durationMs: result.durationMs };
  if (result.skipped) return { ...base, refreshed: false, message: `Not started: ${result.skipped.replace(/ — skipped$/, '')}. Try again in a minute.` };
  if (!result.ok) return { ...base, refreshed: false, message: `Sync failed: ${result.error ?? 'no error text'}` };
  if (!result.trackedComplete) return { ...base, refreshed: false, message: `Not finished: ${result.progress ?? 'the run stopped early'}` };
  const marker = await readMarker('ghl.opportunities');
  const at = marker ? new Date(marker.completedAt) : new Date();
  const tz = await getTimezone().catch(() => null);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at);
  return {
    ...base,
    refreshed: true,
    opportunities: marker?.fetched ?? result.stats.opportunities,
    refreshedAt: at.toISOString(),
    message: `Followed pipeline: ${marker?.fetched ?? result.stats.opportunities} opportunities refreshed at ${time}.`,
  };
}
