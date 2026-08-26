import { NextRequest, NextResponse } from 'next/server';
import { db, syncRuns, syncIncidents } from '@/db';
import { desc, isNull } from 'drizzle-orm';
import { runGhlSync } from '@/lib/ghl/ingest';
import { testConnection } from '@/lib/ghl/client';
import { getSetting, SETTING_KEYS } from '@/lib/settings';
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

/** POST /api/sync — run the hourly delta sync now (read-only against GHL). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await runGhlSync({
      mode: 'delta',
      trigger: 'manual',
      since: typeof body.since === 'string' ? body.since : undefined,
    });
    return NextResponse.json({
      ...result,
      message: result.ok
        ? `Synced: ${result.stats.opportunities} opportunities, ${result.stats.appointmentsUpserted} appointments, ${result.stats.transitions} stage moves (${result.requestsUsed} requests, ${Math.round(result.durationMs / 1000)}s).`
        : (result.error ?? 'Sync failed'),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Sync failed', detail: String(error) }, { status: 500 });
  }
}
