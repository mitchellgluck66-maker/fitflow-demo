import { NextRequest, NextResponse } from 'next/server';
import { runStripeSync } from '@/lib/stripe/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST {mode: 'reconcile'|'backfill', since?} */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'backfill' ? 'backfill' : 'reconcile';
    const result = await runStripeSync({ mode, trigger: 'manual', since: typeof body.since === 'string' ? body.since : undefined });
    const s = result.stats;
    return NextResponse.json({
      ...result,
      message: result.notConfigured
        ? 'Stripe is not connected.'
        : result.ok
          ? `Stripe ${mode}: ${s.charges} charges, ${s.subscriptions} subscriptions, ${s.refunds} refunds · ${s.matched} matched, ${s.unmatched} need review (${result.requestsUsed} requests).`
          : (result.error ?? 'Stripe sync failed'),
    }, { status: result.notConfigured ? 400 : 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Stripe sync failed', detail: String(error) }, { status: 500 });
  }
}
