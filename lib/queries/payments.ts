/**
 * Payment lists — ONE query for `/api/payments` and the Analyst's `get_payments`
 * (plan item 4). Names and Stripe ids only when the caller asks; the Analyst
 * never receives emails.
 */

import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db, payments } from '@/db';

export interface PaymentListRow {
  id: string;
  stripeId: string | null;
  kind: string;
  status: string;
  amountCents: number;
  refundedCents: number;
  currency: string;
  email: string | null;
  customerName: string | null;
  contactId: string | null;
  matchSource: string | null;
  paymentClass: string | null;
  on: string | null;
}

/** Stripe payments, newest first; `unmatched` = succeeded cash with no contact (for the review list). */
export async function listStripePayments(opts: { unmatched?: boolean; limit?: number } = {}): Promise<PaymentListRow[]> {
  const rows = await db
    .select({
      id: payments.id,
      stripeId: payments.stripeId,
      kind: payments.kind,
      status: payments.status,
      amountCents: payments.amountCents,
      refundedCents: payments.refundedCents,
      currency: payments.currency,
      email: payments.email,
      customerName: payments.customerName,
      paidAt: payments.paidAt,
      failedAt: payments.failedAt,
      contactId: payments.contactId,
      matchSource: payments.matchSource,
      paymentClass: payments.paymentClass,
    })
    .from(payments)
    .where(
      opts.unmatched
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
    .limit(opts.limit ?? 200);
  return rows.map(({ paidAt, failedAt, ...r }) => ({ ...r, on: (paidAt ?? failedAt)?.toISOString() ?? null }));
}
