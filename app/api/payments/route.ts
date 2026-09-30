import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { listStripePayments } from '@/lib/queries/payments';
import { manualMatch } from '@/lib/stripe/matching';

export const dynamic = 'force-dynamic';

/** GET /api/payments?unmatched=1 — Stripe payments with no contact, for the review list. */
export async function GET(request: NextRequest) {
  try {
    const unmatched = request.nextUrl.searchParams.get('unmatched') === '1';
    const rows = await listStripePayments({ unmatched });

    return NextResponse.json({ count: rows.length, payments: rows });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to load payments');
  }
}

/** PATCH {paymentId, contactId|null} — manual match (persists, never overwritten by sync). */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.paymentId !== 'string') return NextResponse.json({ error: 'paymentId required' }, { status: 400 });
    const contactId = typeof body.contactId === 'string' && body.contactId ? body.contactId : null;
    const ok = await manualMatch(body.paymentId, contactId);
    if (!ok) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    return NextResponse.json({ ok: true, paymentId: body.paymentId, contactId, matchSource: 'manual' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to match payment', detail: String(error) }, { status: 500 });
  }
}
