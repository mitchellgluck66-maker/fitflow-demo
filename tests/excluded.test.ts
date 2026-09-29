/**
 * M3 — explicit `excluded` payment class; the Revenue footer reconciles to Stripe.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, payments } from '@/db';
import { computeRevenueSummary, excludedReasonOf, type MetricsInput, type PaymentRow } from '@/lib/metrics';
import { isCashPayment } from '@/lib/stripe/classify';

const R = { start: '2026-08-02', end: '2026-08-08' };
const pay = (id: string, cls: PaymentRow['paymentClass'], over: Partial<PaymentRow> = {}): PaymentRow => ({
  id,
  stripeId: id,
  contactId: null,
  kind: 'charge',
  amountCents: 100_000,
  refundedCents: 0,
  currency: 'CAD',
  status: 'succeeded',
  on: '2026-08-04',
  origin: 'stripe',
  paymentClass: cls,
  ...over,
});

describe('excluded reasons + the reconciliation identity', () => {
  const input: MetricsInput = {
    contacts: [],
    transitions: [],
    appointments: [],
    spend: [],
    payments: [
      pay('i1', 'initial'),
      pay('i2', 'initial', { refundedCents: 20_000 }), // partial refund, still cash
      pay('r1', 'recurring', { kind: 'invoice', amountCents: 19_900 }),
      pay('f1', 'excluded', { status: 'failed' }),
      pay('f2', 'excluded', { status: 'failed', amountCents: 50_000 }),
      pay('x1', 'excluded', { status: 'refunded', refundedCents: 100_000 }), // fully refunded
      pay('re1', 'excluded', { kind: 'refund', amountCents: 20_000 }), // the refund row behind i2
      pay('p1', 'excluded', { status: 'pending' }),
      pay('u1', null), // succeeded, not yet classified → data-health, still cash
    ],
  };
  const s = computeRevenueSummary(input, R);

  it('names why each excluded row is not cash', () => {
    expect(excludedReasonOf({ kind: 'refund', status: 'succeeded', amountCents: 1, refundedCents: 0 })).toBe('refund');
    expect(excludedReasonOf({ kind: 'subscription', status: 'active', amountCents: 1, refundedCents: 0 })).toBe('plan');
    expect(excludedReasonOf({ kind: 'charge', status: 'failed', amountCents: 1, refundedCents: 0 })).toBe('failed');
    expect(excludedReasonOf({ kind: 'charge', status: 'succeeded', amountCents: 1, refundedCents: 1 })).toBe('fully_refunded');
    expect(s.payments.find((p) => p.id === 'x1')!.excludedReason).toBe('fully_refunded');
    expect(s.payments.find((p) => p.id === 'i1')!.excludedReason).toBeNull();
  });

  it('counts excluded rows by reason for the footer', () => {
    expect(s.excluded).toEqual({ count: 5, byReason: { failed: 2, refund: 1, fully_refunded: 1, pending: 1, plan: 0 } });
  });

  it('every listed row is accounted for: listed = initial + recurring + unclassified + excluded', () => {
    expect(s.payments).toHaveLength(9);
    expect(s.initialCount + s.recurringCount + s.unclassifiedCount + s.excluded.count + s.notYetClassifiedCount).toBe(9);
    expect(s.notYetClassifiedCount).toBe(0);
  });

  it('money reconciles: charged − refunded = collected (initial + recurring + unclassified)', () => {
    // charged: i1 100,000 + i2 100,000 + r1 19,900 + x1 100,000 + u1 100,000 (failed / pending / refund rows are not charges kept or refunded)
    expect(s.grossCents).toBe(419_900);
    expect(s.refundedCents).toBe(120_000); // i2 20,000 + x1 100,000
    expect(s.collectedCents).toBe(299_900);
    expect(s.grossCents - s.refundedCents).toBe(s.collectedCents);
    expect(s.initialCents + s.recurringCents + s.unclassifiedCents).toBe(s.collectedCents);
  });
});

describe('migration 0010 mirrors isCashPayment', () => {
  const shapes = [
    { kind: 'charge', status: 'succeeded', amountCents: 100, refundedCents: 0 },
    { kind: 'charge', status: 'succeeded', amountCents: 100, refundedCents: 40 },
    { kind: 'charge', status: 'succeeded', amountCents: 100, refundedCents: 100 },
    { kind: 'charge', status: 'refunded', amountCents: 100, refundedCents: 100 },
    { kind: 'charge', status: 'failed', amountCents: 100, refundedCents: 0 },
    { kind: 'charge', status: 'pending', amountCents: 100, refundedCents: 0 },
    { kind: 'invoice', status: 'succeeded', amountCents: 100, refundedCents: 0 },
    { kind: 'invoice', status: 'failed', amountCents: 100, refundedCents: 0 },
    { kind: 'refund', status: 'succeeded', amountCents: 40, refundedCents: 0 },
    { kind: 'subscription', status: 'active', amountCents: 9_900, refundedCents: 0 },
  ];

  beforeAll(async () => {
    await runMigrations();
    await db.insert(payments).values(
      shapes.map((s, i) => ({ stripeId: `mig_${i}`, currency: 'CAD', source: 'stripe', origin: 'stripe', paymentClass: null, ...s })),
    );
    // Re-run the migration's statement against these legacy null rows.
    const file = readFileSync(path.join(process.cwd(), 'migrations', '0010_m3_payment_class_excluded.sql'), 'utf8');
    const statement = file
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    await db.execute(sql.raw(statement));
  });

  it("marks exactly the non-cash rows 'excluded' and leaves cash rows for the classifier", async () => {
    for (const [i, s] of shapes.entries()) {
      const [row] = await db.select({ cls: payments.paymentClass }).from(payments).where(eq(payments.stripeId, `mig_${i}`));
      expect({ shape: s, cls: row.cls }).toEqual({ shape: s, cls: isCashPayment(s) ? null : 'excluded' });
    }
  });
});
