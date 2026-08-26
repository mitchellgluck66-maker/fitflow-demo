import { NextRequest, NextResponse } from 'next/server';
import { runGhlSync } from '@/lib/ghl/ingest';
import { getDataProvenance } from '@/lib/provenance';
import { getSetting, SETTING_KEYS } from '@/lib/settings';

export const dynamic = 'force-dynamic';
// A backfill walks a lot of rate-limited calls.
export const maxDuration = 300;

/** GET /api/ghl/backfill — provenance + configured backfill start date. */
export async function GET() {
  try {
    return NextResponse.json({
      ...(await getDataProvenance()),
      backfillFrom: await getSetting(SETTING_KEYS.backfillFrom),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read provenance', detail: String(error) }, { status: 500 });
  }
}

/**
 * POST /api/ghl/backfill  Body: { since?: 'YYYY-MM-DD' }
 * Imports everything from the backfill start (default June 16, 2026) forward,
 * every row flagged backfilled=true. Idempotent — safe to re-run.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await runGhlSync({
      mode: 'backfill',
      trigger: 'manual',
      since: typeof body.since === 'string' ? body.since : undefined,
    });
    return NextResponse.json({
      ...result,
      provenance: await getDataProvenance(),
      message: result.ok
        ? `Backfill complete: ${result.stats.contactsUpserted} contacts, ${result.stats.appointmentsUpserted} appointments, ${result.stats.transitions} stage transitions (${result.requestsUsed} API requests).`
        : (result.error ?? 'Backfill failed'),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Backfill failed', detail: String(error) }, { status: 500 });
  }
}
