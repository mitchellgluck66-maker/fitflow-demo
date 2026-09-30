import { NextRequest, NextResponse } from 'next/server';
import { runGhlSync } from '@/lib/ghl/ingest';
import { recordScheduledRun, schedulerVia } from '@/lib/sync/scheduler';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/sync-ghl — the GHL sync (Ingestion v2, 2026-09-30). Primary schedule: Vercel Pro cron hourly at
 * :07 (vercel.json); fallback: the GitHub Actions heartbeat every 6 h. Every call records itself for the
 * scheduler-silent check. Safe at any cadence: one run at a time (atomic lease); a call that lands while another
 * run holds it returns 200 `skipped` without touching anything.
 *
 * Vercel invokes cron routes with `Authorization: Bearer $CRON_SECRET`. We
 * require it in production so nobody can trigger syncs from outside; locally
 * (no CRON_SECRET set) the route is open for `curl` testing.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  }

  await recordScheduledRun('/api/cron/sync-ghl', schedulerVia(request.headers));
  // Ingestion v2: the followed pipeline in full (200 s budget < maxDuration 300), then the weekly mirror pass if due.
  const result = await runGhlSync({ mode: 'delta', trigger: 'cron' });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
