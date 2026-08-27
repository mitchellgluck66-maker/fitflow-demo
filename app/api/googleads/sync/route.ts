import { NextRequest, NextResponse } from 'next/server';
import { runGoogleAdsSync } from '@/lib/googleads/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST {mode:'delta'|'backfill', since?} */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'backfill' ? 'backfill' : 'delta';
    const result = await runGoogleAdsSync({ mode, trigger: 'manual', since: typeof body.since === 'string' ? body.since : undefined });
    return NextResponse.json({
      ...result,
      message: result.ok
        ? `Google Ads ${mode}: ${result.stats.rows} rows across ${result.stats.days} days, ${result.stats.campaigns} campaigns.`
        : (result.error ?? 'Sync failed'),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Sync failed', detail: String(error) }, { status: 500 });
  }
}
