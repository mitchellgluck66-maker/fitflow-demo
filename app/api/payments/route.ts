import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db, payments } from '@/db';
import { manualMatch } from '@/lib/stripe/matching';

export const dynamic = 'force-dynamic';

/** GET /api/payments?unmatched=1 — Stripe payments with no contact, for the review list. */
export async function GET(request: NextRequest) {
  try {
    const unmatched = request.nextUrl.searchParams.get('unmatched') === '1';
    const rows = await db
      .select({
        id: payments.id,
        stripeId: payments.stripeId,
        kind: payments.kind,
        status: payments.status,
        amountCents: payments.amountCents,
        refundedCents: payments.refundedCents,
        email: payments.email,
        customerName: payments.customerName,
        paidAt: payments.paidAt,
        failedAt: payments.failedAt,
        contactId: payments.contactId,
        matchSource: payments.matchSource,
      })
      .from(payments)
      .where(
        unmatched
          ? and(
              eq(payments.origin, 'stripe'),
              isNull(payments.contactId),
              or(isNull(payments.matchSource), ne(payments.matchSource, 'manual')),
              inArray(payments.status, ['succeeded', 'refunded']),
              ne(payments.kind, 'refund'),
            )
          : eq(payments.origin, 'stripe'),
      )
      .orderBy(desc(payments.paidAt))
      .limit(200);

    return NextResponse.json({
      count: rows.length,
      payments: rows.map((r) => ({ ...r, on: (r.paidAt ?? r.failedAt)?.toISOString() ?? null, paidAt: undefined, failedAt: undefined })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to load payments', detail: String(error) }, { status: 500 });
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
