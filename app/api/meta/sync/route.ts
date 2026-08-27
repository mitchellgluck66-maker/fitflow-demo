import { NextRequest, NextResponse } from 'next/server';
import { runMetaSync } from '@/lib/meta/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST {mode?: 'delta'|'backfill', since?: 'YYYY-MM-DD'} */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'backfill' ? 'backfill' : 'delta';
    const result = await runMetaSync({ mode, trigger: 'manual', since: typeof body.since === 'string' ? body.since : undefined });
    return NextResponse.json({
      ...result,
      message: result.ok
        ? `Meta ${mode}: ${result.stats.rows} ad-day rows across ${result.stats.campaigns} campaigns, ${result.stats.days} days (${result.requestsUsed} requests).`
        : (result.error ?? 'Meta sync failed'),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Meta sync failed', detail: String(error) }, { status: 500 });
  }
}
