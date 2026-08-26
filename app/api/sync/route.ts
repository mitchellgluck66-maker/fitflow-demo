import { NextRequest, NextResponse } from 'next/server';
import { runSync, getQueueStats } from '@/lib/ghl/sync';
import { testConnection } from '@/lib/ghl/client';
import { setSetting, SETTING_KEYS } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/** GET /api/sync - queue stats and connection state for the status badge. */
export async function GET() {
  try {
    const [stats, connection] = await Promise.all([getQueueStats(), testConnection()]);
    return NextResponse.json({ stats, connection });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read sync status', detail: String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/sync - drain the outbox now.
 *
 * Called by the midnight job and by the "Sync now" button. Safe to call
 * repeatedly: succeeded rows are never reprocessed.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await runSync({ limit: body.limit });

    await setSetting(SETTING_KEYS.lastAutoSyncAt, new Date().toISOString());

    return NextResponse.json({
      ok: true,
      ...result,
      message: result.dryRun
        ? `Dry run complete - ${result.processed} operations previewed. Add GHL credentials and set GHL_DRY_RUN=false to send them.`
        : `Synced ${result.succeeded}/${result.processed} operations to GoHighLevel.`,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    return NextResponse.json(
      { error: 'Sync failed', detail: String(error) },
      { status: 500 },
    );
  }
}
