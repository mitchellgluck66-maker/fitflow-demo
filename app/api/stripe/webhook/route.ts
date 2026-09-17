import { NextRequest, NextResponse } from 'next/server';
import { getStripeConfig } from '@/lib/stripe/config';
import { verifyStripeSignature } from '@/lib/stripe/webhook';
import { StripeEventSchema, StripeChargeSchema, StripeSubscriptionSchema, StripeRefundSchema } from '@/lib/stripe/schemas';
import { upsertCharge, upsertSubscription, upsertRefund, fetchCharge } from '@/lib/stripe/ingest';
import { runPaymentMatching } from '@/lib/stripe/matching';
import { runPaymentClassification } from '@/lib/stripe/classify';

export const dynamic = 'force-dynamic';

/**
 * POST /api/stripe/webhook — signature-verified real-time updates.
 * Writes the same rows the reconcile sync writes; reconcile heals any gaps.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const config = await getStripeConfig();
  if (!config.webhookSecret) {
    return NextResponse.json({ error: 'Webhook secret is not configured' }, { status: 400 });
  }

  const check = verifyStripeSignature(rawBody, request.headers.get('stripe-signature'), config.webhookSecret);
  if (!check.ok) {
    return NextResponse.json({ error: `Invalid signature (${check.reason})` }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Body is not JSON' }, { status: 400 });
  }
  const event = StripeEventSchema.safeParse(raw);
  if (!event.success) return NextResponse.json({ error: 'Unrecognised event shape' }, { status: 400 });

  const meta = { syncedAt: new Date(), backfilled: false };
  const { type } = event.data;
  const object = event.data.data.object;
  let handled = false;

  try {
    if (type.startsWith('charge.')) {
      const charge = StripeChargeSchema.safeParse(object);
      if (charge.success) {
        await upsertCharge(charge.data, meta);
        handled = true;
      }
    } else if (type === 'invoice.paid' || type === 'invoice.payment_failed' || type === 'invoice.payment_succeeded') {
      const chargeId = object && typeof object === 'object' && 'charge' in object ? (object as { charge?: string | null }).charge : null;
      if (typeof chargeId === 'string') {
        const charge = await fetchCharge(chargeId);
        if (charge) {
          await upsertCharge(charge, meta);
          handled = true;
        }
      }
    } else if (type.startsWith('customer.subscription.')) {
      const sub = StripeSubscriptionSchema.safeParse(object);
      if (sub.success) {
        await upsertSubscription(sub.data, meta);
        handled = true;
      }
    } else if (type.startsWith('refund.') || type === 'charge.refund.updated') {
      const refund = StripeRefundSchema.safeParse(object);
      if (refund.success) {
        await upsertRefund(refund.data, meta);
        handled = true;
      }
    }
    if (handled) {
      await runPaymentMatching();
      await runPaymentClassification();
    }
  } catch (error) {
    console.error('stripe webhook failed:', error);
    return NextResponse.json({ received: true, error: 'processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true, handled, type });
}
