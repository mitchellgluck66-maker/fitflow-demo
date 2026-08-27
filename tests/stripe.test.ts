/**
 * Stripe integration: signature verification, unconfigured behaviour, a full
 * mocked reconcile against in-memory PGlite, matching persistence, webhook.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, payments, contacts } from '@/db';
import { setSetting } from '@/lib/settings';
import { STRIPE_KEYS } from '@/lib/stripe/config';
import { verifyStripeSignature, signStripePayload } from '@/lib/stripe/webhook';
import { runStripeSync, monthlyAmountCents } from '@/lib/stripe/ingest';
import { manualMatch } from '@/lib/stripe/matching';
import { POST as webhookPost } from '@/app/api/stripe/webhook/route';

const SECRET = 'whsec_test_secret';
const NOW = 1_700_000_000;

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1","type":"charge.succeeded"}';

  it('accepts a correctly signed payload within tolerance', () => {
    const header = signStripePayload(body, SECRET, NOW);
    expect(verifyStripeSignature(body, header, SECRET, 300, NOW + 10)).toMatchObject({ ok: true, timestamp: NOW });
  });

  it('rejects a tampered body', () => {
    const header = signStripePayload(body, SECRET, NOW);
    expect(verifyStripeSignature(body + ' ', header, SECRET, 300, NOW)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('rejects an expired timestamp', () => {
    const header = signStripePayload(body, SECRET, NOW);
    expect(verifyStripeSignature(body, header, SECRET, 300, NOW + 1000)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects missing / malformed headers', () => {
    expect(verifyStripeSignature(body, null, SECRET)).toMatchObject({ ok: false, reason: 'missing_header' });
    expect(verifyStripeSignature(body, `t=${NOW}`, SECRET, 300, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyStripeSignature(body, 'v1=abc', SECRET, 300, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('monthlyAmountCents', () => {
  const sub = (unit: number, interval: 'month' | 'year' | 'week', count = 1) =>
    ({ id: 's', customer: 'c', status: 'active', created: 0, items: { data: [{ price: { unit_amount: unit, recurring: { interval, interval_count: count } }, quantity: 1 }] } }) as never;
  it('normalises yearly and quarterly plans to a month', () => {
    expect(monthlyAmountCents(sub(120_000, 'year'))).toEqual({ amountCents: 10_000, intervalMonths: 12 });
    expect(monthlyAmountCents(sub(30_000, 'month', 3))).toEqual({ amountCents: 10_000, intervalMonths: 3 });
    expect(monthlyAmountCents(sub(19_900, 'month'))).toEqual({ amountCents: 19_900, intervalMonths: 1 });
  });
});

// ---------------------------------------------------------------------------
// Mocked account
// ---------------------------------------------------------------------------

const account = {
  charges: [
    {
      id: 'ch_ok',
      amount: 299_900,
      amount_refunded: 0,
      currency: 'usd',
      status: 'succeeded',
      created: 1_755_000_000,
      customer: { id: 'cus_1', email: 'Jane@Example.com', name: 'Jane Doe', phone: '(555) 000-1111' },
      billing_details: {},
      description: 'Coaching program',
      invoice: null,
      refunded: false,
    },
    {
      id: 'ch_failed',
      amount: 49_900,
      amount_refunded: 0,
      currency: 'usd',
      status: 'failed',
      created: 1_755_100_000,
      customer: null,
      billing_details: { email: 'nobody@example.com', name: 'No Body' },
      failure_message: 'card_declined',
      refunded: false,
    },
    {
      id: 'ch_refunded',
      amount: 99_900,
      amount_refunded: 99_900,
      currency: 'usd',
      status: 'succeeded',
      created: 1_755_200_000,
      customer: 'cus_2',
      billing_details: { email: 'refund@example.com' },
      invoice: 'in_1',
      refunded: true,
    },
  ] as Record<string, unknown>[],
  subscriptions: [
    {
      id: 'sub_1',
      customer: { id: 'cus_1', email: 'jane@example.com', name: 'Jane Doe' },
      status: 'active',
      created: 1_754_000_000,
      current_period_start: 1_755_000_000,
      items: { data: [{ price: { unit_amount: 1200, recurring: { interval: 'year', interval_count: 1 } }, quantity: 1 }] },
    },
  ],
  refunds: [{ id: 're_1', charge: 'ch_refunded', amount: 99_900, created: 1_755_300_000, status: 'succeeded' }],
};

const calls: string[] = [];
const fakeFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: 'list', data, has_more: false }), { status: 200 });
  if (url.pathname === '/v1/balance') return new Response(JSON.stringify({ object: 'balance', livemode: false }), { status: 200 });
  if (url.pathname === '/v1/charges') return list(account.charges);
  if (url.pathname === '/v1/subscriptions') return list(account.subscriptions);
  if (url.pathname === '/v1/refunds') return list(account.refunds);
  return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
});

let janeId: string;

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  const [jane] = await db
    .insert(contacts)
    .values({ ghlContactId: 'ct-jane', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', emailNormalized: 'jane@example.com', phoneNormalized: '15550001111', source: 'ghl', origin: 'ghl' })
    .returning({ id: contacts.id });
  janeId = jane.id;
});

afterAll(() => vi.unstubAllGlobals());

describe('runStripeSync', () => {
  it('is a clean no-op without a key (no network, no incident)', async () => {
    const r = await runStripeSync({ mode: 'reconcile', trigger: 'manual' });
    expect(r).toMatchObject({ ok: false, notConfigured: true, runId: null });
    expect(calls).toHaveLength(0);
  });

  it('reconciles charges, subscriptions and refunds into payments and auto-matches by email', async () => {
    await setSetting(STRIPE_KEYS.secretKey, 'rk_test_abcdefghijklmnop', { secret: true });
    const r = await runStripeSync({ mode: 'backfill', trigger: 'cli', since: '2026-06-16' });
    expect(r.ok).toBe(true);
    expect(r.stats).toMatchObject({ charges: 3, subscriptions: 1, refunds: 1, matched: 2 });
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);

    const rows = await db.select().from(payments);
    const by = (id: string) => rows.find((p) => p.stripeId === id)!;

    expect(by('ch_ok')).toMatchObject({
      kind: 'charge',
      status: 'succeeded',
      amountCents: 299_900,
      emailNormalized: 'jane@example.com',
      phoneNormalized: '15550001111',
      customerName: 'Jane Doe',
      contactId: janeId,
      matchSource: 'auto',
      backfilled: true,
      origin: 'stripe',
    });
    expect(by('ch_ok').paidAt?.getTime()).toBe(1_755_000_000_000);
    expect(by('ch_failed')).toMatchObject({ status: 'failed', contactId: null, description: 'card_declined' });
    expect(by('ch_failed').failedAt).not.toBeNull();
    expect(by('ch_refunded')).toMatchObject({ kind: 'invoice', status: 'refunded', refundedCents: 99_900 });
    expect(by('sub_1')).toMatchObject({ kind: 'subscription', status: 'active', amountCents: 100, intervalMonths: 12, contactId: janeId, matchSource: 'auto' });
    expect(by('re_1')).toMatchObject({ kind: 'refund', amountCents: 99_900 });
  });

  it('re-running is idempotent and keeps a manual match', async () => {
    const before = (await db.select().from(payments)).length;
    const failed = (await db.select().from(payments).where(eq(payments.stripeId, 'ch_failed')))[0];
    await manualMatch(failed.id, janeId);

    // Simulate a contact now existing for the refunded payment's email, and
    // Stripe reporting the failed charge as belonging to someone else.
    await db.insert(contacts).values({ ghlContactId: 'ct-refund', firstName: 'Re', lastName: 'Fund', emailNormalized: 'refund@example.com', source: 'ghl', origin: 'ghl' });

    const r = await runStripeSync({ mode: 'reconcile', trigger: 'cron' });
    expect(r.ok).toBe(true);
    const rows = await db.select().from(payments);
    expect(rows.length).toBe(before);
    expect(rows.find((p) => p.stripeId === 'ch_failed')).toMatchObject({ contactId: janeId, matchSource: 'manual', backfilled: false });
    expect(rows.find((p) => p.stripeId === 'ch_refunded')?.matchSource).toBe('auto');
  });

  it('manual "no match" is respected too', async () => {
    const ok = (await db.select().from(payments).where(eq(payments.stripeId, 'ch_ok')))[0];
    await manualMatch(ok.id, null);
    await runStripeSync({ mode: 'reconcile', trigger: 'cron' });
    expect((await db.select().from(payments).where(eq(payments.stripeId, 'ch_ok')))[0]).toMatchObject({ contactId: null, matchSource: 'manual' });
  });
});

describe('webhook route', () => {
  it('rejects a bad signature and accepts a signed charge event', async () => {
    await setSetting(STRIPE_KEYS.webhookSecret, SECRET, { secret: true });
    const event = {
      id: 'evt_1',
      type: 'charge.succeeded',
      created: NOW,
      data: {
        object: {
          id: 'ch_hook',
          amount: 12_345,
          amount_refunded: 0,
          currency: 'usd',
          status: 'succeeded',
          created: 1_756_000_000,
          customer: null,
          billing_details: { email: 'JANE@example.com' },
          refunded: false,
        },
      },
    };
    const body = JSON.stringify(event);

    const bad = await webhookPost(
      new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': 't=1,v1=00' } }),
    );
    expect(bad.status).toBe(400);

    const good = await webhookPost(
      new NextRequest('http://localhost/api/stripe/webhook', {
        method: 'POST',
        body,
        headers: { 'stripe-signature': signStripePayload(body, SECRET, Math.floor(Date.now() / 1000)) },
      }),
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ received: true, handled: true });
    const row = (await db.select().from(payments).where(eq(payments.stripeId, 'ch_hook')))[0];
    expect(row).toMatchObject({ amountCents: 12_345, emailNormalized: 'jane@example.com', contactId: janeId, matchSource: 'auto' });
  });
});
