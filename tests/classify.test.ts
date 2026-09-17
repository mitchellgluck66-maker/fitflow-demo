/**
 * Payment classifier (Phase G item 1): initial vs recurring, hand-computed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { classifyPayments, customerKeyOf, isCashPayment, runPaymentClassification, type ClassifiablePayment } from '@/lib/stripe/classify';
import { computeRevenue, computeRevenueSummary, type MetricsInput } from '@/lib/metrics';
import { runMigrations } from '@/db/migrate';
import { db, payments } from '@/db';

const ms = (d: string) => Date.parse(`${d}T12:00:00Z`);
const pay = (id: string, over: Partial<ClassifiablePayment> = {}): ClassifiablePayment => ({
  id,
  stripeCustomerId: 'cus_a',
  emailNormalized: 'a@example.com',
  kind: 'charge',
  status: 'succeeded',
  amountCents: 100_000,
  refundedCents: 0,
  paidAtMs: ms('2026-08-01'),
  ...over,
});
const classOf = (rows: ClassifiablePayment[]) => Object.fromEntries(classifyPayments(rows).map((r) => [r.id, r.paymentClass]));

describe('classifyPayments', () => {
  it('one charge per customer is initial', () => {
    expect(classOf([pay('p1')])).toEqual({ p1: 'initial' });
  });

  it('multiple charges for the same customer: earliest kept charge is initial, the rest recurring', () => {
    const rows = [
      pay('late', { paidAtMs: ms('2026-08-20') }),
      pay('first', { paidAtMs: ms('2026-08-01') }),
      pay('mid', { paidAtMs: ms('2026-08-10'), kind: 'invoice' }),
    ];
    expect(classOf(rows)).toEqual({ first: 'initial', mid: 'recurring', late: 'recurring' });
  });

  it('a fully refunded first charge is not cash; the next successful charge becomes initial', () => {
    const rows = [
      pay('refunded', { paidAtMs: ms('2026-08-01'), status: 'refunded', refundedCents: 100_000 }),
      pay('second', { paidAtMs: ms('2026-08-05') }),
      pay('third', { paidAtMs: ms('2026-08-09') }),
    ];
    expect(classOf(rows)).toEqual({ refunded: null, second: 'initial', third: 'recurring' });
  });

  it('a partially refunded first charge stays initial', () => {
    const rows = [pay('p1', { refundedCents: 40_000 }), pay('p2', { paidAtMs: ms('2026-08-02') })];
    expect(classOf(rows)).toEqual({ p1: 'initial', p2: 'recurring' });
  });

  it('subscription-only customer: first invoice is the new-client cash, later invoices recurring', () => {
    const rows = [
      pay('in_1', { kind: 'invoice', paidAtMs: ms('2026-07-01'), amountCents: 19_900 }),
      pay('in_2', { kind: 'invoice', paidAtMs: ms('2026-08-01'), amountCents: 19_900 }),
      pay('in_3', { kind: 'invoice', paidAtMs: ms('2026-09-01'), amountCents: 19_900 }),
      pay('sub_1', { kind: 'subscription', status: 'active', amountCents: 19_900 }),
    ];
    expect(classOf(rows)).toEqual({ in_1: 'initial', in_2: 'recurring', in_3: 'recurring', sub_1: null });
  });

  it('failed and pending charges are never classed and never steal the initial slot', () => {
    const rows = [
      pay('failed', { status: 'failed', paidAtMs: null }),
      pay('pending', { status: 'pending', paidAtMs: ms('2026-07-30') }),
      pay('ok', { paidAtMs: ms('2026-08-01') }),
    ];
    expect(classOf(rows)).toEqual({ failed: null, pending: null, ok: 'initial' });
  });

  it('refund rows are never classed', () => {
    expect(classOf([pay('re_1', { kind: 'refund', amountCents: 5_000 })])).toEqual({ re_1: null });
  });

  it('customers are independent; a second customer gets its own initial', () => {
    const rows = [pay('a1'), pay('b1', { stripeCustomerId: 'cus_b', emailNormalized: 'b@example.com' }), pay('a2', { paidAtMs: ms('2026-08-03') })];
    expect(classOf(rows)).toEqual({ a1: 'initial', b1: 'initial', a2: 'recurring' });
  });

  it('falls back to email, then to the row itself, when there is no Stripe customer', () => {
    expect(customerKeyOf({ id: 'x', stripeCustomerId: 'cus_1', emailNormalized: 'e' })).toBe('cus:cus_1');
    expect(customerKeyOf({ id: 'x', stripeCustomerId: null, emailNormalized: 'e@x.com' })).toBe('email:e@x.com');
    expect(customerKeyOf({ id: 'x', stripeCustomerId: null, emailNormalized: null })).toBe('solo:x');
    const rows = [
      pay('e1', { stripeCustomerId: null, emailNormalized: 'same@x.com' }),
      pay('e2', { stripeCustomerId: null, emailNormalized: 'same@x.com', paidAtMs: ms('2026-08-02') }),
      pay('solo', { stripeCustomerId: null, emailNormalized: null }),
    ];
    expect(classOf(rows)).toEqual({ e1: 'initial', e2: 'recurring', solo: 'initial' });
  });

  it('ties on paid time break deterministically by id', () => {
    expect(classOf([pay('b'), pay('a')])).toEqual({ a: 'initial', b: 'recurring' });
  });

  it('isCashPayment', () => {
    expect(isCashPayment({ kind: 'charge', status: 'succeeded', amountCents: 10, refundedCents: 0 })).toBe(true);
    expect(isCashPayment({ kind: 'charge', status: 'succeeded', amountCents: 10, refundedCents: 10 })).toBe(false);
    expect(isCashPayment({ kind: 'invoice', status: 'succeeded', amountCents: 10, refundedCents: 3 })).toBe(true);
    expect(isCashPayment({ kind: 'subscription', status: 'active', amountCents: 10, refundedCents: 0 })).toBe(false);
    expect(isCashPayment({ kind: 'charge', status: 'failed', amountCents: 10, refundedCents: 0 })).toBe(false);
  });
});

describe('engine: initial vs recurring cash', () => {
  const R = { start: '2026-08-02', end: '2026-08-08' };
  const base: MetricsInput = { contacts: [], transitions: [], appointments: [], spend: [{ date: '2026-08-02', platform: 'meta', spendCents: 100_000, origin: 'manual' }], payments: [] };
  const p = (id: string, cls: 'initial' | 'recurring' | null, over: Partial<MetricsInput['payments'][number]> = {}) => ({
    id,
    stripeId: id,
    contactId: null,
    kind: 'charge',
    amountCents: 100_000,
    refundedCents: 0,
    status: 'succeeded',
    on: '2026-08-04',
    origin: 'stripe',
    paymentClass: cls,
    ...over,
  });

  it('ROAS and the Command Center revenue use ONLY initial cash, net of refunds, excluding failed', () => {
    const input = {
      ...base,
      payments: [
        p('i1', 'initial'),
        p('i2', 'initial', { refundedCents: 25_000 }), // partial refund → 75,000 kept
        p('r1', 'recurring', { kind: 'invoice', amountCents: 19_900 }),
        p('f1', null, { status: 'failed' }),
        p('x1', null, { status: 'refunded', refundedCents: 100_000 }), // fully refunded → nets to 0, no double subtraction
        p('re', null, { kind: 'refund', amountCents: 25_000 }),
      ],
    };
    const r = computeRevenue(input, R);
    expect(r).toMatchObject({
      initialCents: 175_000,
      initialCount: 2,
      recurringCents: 19_900,
      recurringCount: 1,
      collectedCents: 194_900,
      unclassifiedCents: 0,
      unclassifiedCount: 0,
      failedCount: 1,
      refundedCents: 125_000,
      awaitingStripe: false,
    });
    expect(r.roas).toBeCloseTo(1.75);
  });

  it('succeeded cash with no class is surfaced, not silently counted as initial', () => {
    const r = computeRevenue({ ...base, payments: [p('legacy', null)] }, R);
    expect(r).toMatchObject({ initialCents: 0, recurringCents: 0, unclassifiedCents: 100_000, unclassifiedCount: 1, collectedCents: 100_000 });
    expect(r.roas).toBe(0); // 0 initial ÷ spend — the UI shows the data-health warning alongside
  });

  it('revenue summary carries the split and the class on each row', () => {
    const s = computeRevenueSummary({ ...base, payments: [p('i1', 'initial'), p('r1', 'recurring', { kind: 'invoice', amountCents: 19_900 })] }, R);
    expect(s).toMatchObject({ initialCents: 100_000, initialCount: 1, recurringCents: 19_900, recurringCount: 1, mrrCents: 0 });
    expect(s.payments.map((x) => [x.id, x.paymentClass])).toEqual([
      ['i1', 'initial'],
      ['r1', 'recurring'],
    ]);
  });
});

describe('runPaymentClassification (DB)', () => {
  beforeAll(async () => {
    await runMigrations();
    const row = (over: Partial<typeof payments.$inferInsert>): typeof payments.$inferInsert => ({
      stripeId: 'x',
      stripeCustomerId: 'cus_db',
      kind: 'charge',
      status: 'succeeded',
      amountCents: 50_000,
      refundedCents: 0,
      paidAt: new Date('2026-08-01T12:00:00Z'),
      source: 'stripe',
      origin: 'stripe',
      ...over,
    });
    await db.insert(payments).values([
      row({ stripeId: 'db_first' }),
      row({ stripeId: 'db_second', paidAt: new Date('2026-08-05T12:00:00Z'), kind: 'invoice' }),
      row({ stripeId: 'db_failed', status: 'failed', paidAt: null, failedAt: new Date('2026-08-02T12:00:00Z') }),
      row({ stripeId: 'db_other', stripeCustomerId: 'cus_other', paidAt: new Date('2026-08-06T12:00:00Z') }),
    ]);
  });

  it('writes classes and is idempotent', async () => {
    const first = await runPaymentClassification();
    expect(first).toMatchObject({ scanned: 4, initial: 2, recurring: 1, unclassed: 1, updated: 3 });
    const by = async (id: string) => (await db.select().from(payments).where(eq(payments.stripeId, id)))[0].paymentClass;
    expect(await by('db_first')).toBe('initial');
    expect(await by('db_second')).toBe('recurring');
    expect(await by('db_failed')).toBeNull();
    expect(await by('db_other')).toBe('initial');

    const again = await runPaymentClassification();
    expect(again.updated).toBe(0);
  });

  it('a refund of the first charge moves the initial slot on the next run', async () => {
    await db.update(payments).set({ status: 'refunded', refundedCents: 50_000 }).where(eq(payments.stripeId, 'db_first'));
    const r = await runPaymentClassification();
    expect(r.updated).toBe(2);
    const rows = await db.select({ id: payments.stripeId, cls: payments.paymentClass }).from(payments);
    expect(Object.fromEntries(rows.map((x) => [x.id, x.cls]))).toMatchObject({ db_first: null, db_second: 'initial', db_other: 'initial', db_failed: null });
  });
});
