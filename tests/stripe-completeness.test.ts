/**
 * F12 (2026-09-30): the Stripe mirror repairs itself. The per-day completeness sweep finds a hole (the Sep 2–11
 * shape: charges missing entirely) and a fully refunded invoice charge the mirror still counts as cash
 * (ch_3UAvd1), re-fills them from Stripe, and proves the day matches. The refund bug class: partial refunds sum
 * onto the parent, a missing parent is fetched, a failed refunds listing fails the run, and a charge.refund.*
 * webhook is stored as a refund — never as a cash charge.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, payments, syncRuns, syncIncidents } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from '@/lib/settings';
import { STRIPE_KEYS } from '@/lib/stripe/config';
import { runStripeCompleteness, diffBooks } from '@/lib/stripe/completeness';
import { upsertCharges, upsertRefunds, runStripeSync } from '@/lib/stripe/ingest';
import { signStripePayload } from '@/lib/stripe/webhook';
import { POST as webhookPost } from '@/app/api/stripe/webhook/route';

const NOW = new Date('2026-09-30T18:00:00Z'); // Edmonton: yesterday = 2026-09-29
const noonUtc = (d: string) => Math.floor(Date.parse(`${d}T18:00:00Z`) / 1000); // 12:00 Edmonton, same day
type C = { id: string; object: 'charge'; amount: number; amount_refunded: number; currency: string; status: string; created: number; refunded: boolean; customer: null; billing_details: Record<string, never>; invoice: string | null };
const charge = (id: string, day: string, extra: Partial<C> = {}): C => ({ id, object: 'charge', amount: 50_000, amount_refunded: 0, currency: 'cad', status: 'succeeded', created: noonUtc(day), refunded: false, customer: null, billing_details: {}, invoice: null, ...extra });

// Stripe's truth: one charge a day from Aug 20 to Sep 29, plus the refunded invoice charge.
const stripe = { charges: [] as C[], refunds: [] as Array<Record<string, unknown>> };
for (let d = new Date('2026-08-20T00:00:00Z'); d <= new Date('2026-09-29T00:00:00Z'); d = new Date(d.getTime() + 86_400_000)) {
  const day = d.toISOString().slice(0, 10);
  stripe.charges.push(charge(`ch_${day}`, day));
}
stripe.charges.push(charge('ch_3UAvd1', '2026-09-01', { amount: 100_000, amount_refunded: 100_000, refunded: true, currency: 'usd', invoice: 'in_1' }));
stripe.refunds.push({ id: 're_vd1', object: 'refund', charge: 'ch_3UAvd1', amount: 100_000, currency: 'usd', status: 'succeeded', created: noonUtc('2026-09-03') });

let failRefunds = false;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  const gte = Number(url.searchParams.get('created[gte]') ?? 0);
  const lt = Number(url.searchParams.get('created[lt]') ?? Infinity);
  const after = url.searchParams.get('starting_after');
  const list = (rows: Array<{ id: string; created: number }>) => {
    let r = rows.filter((x) => x.created >= gte && x.created < lt).sort((a, b) => b.created - a.created);
    if (after) r = r.slice(r.findIndex((x) => x.id === after) + 1);
    const page = r.slice(0, 20); // small pages → paging exercised
    return json({ object: 'list', data: page, has_more: r.length > page.length });
  };
  if (url.pathname === '/v1/charges') return list(stripe.charges);
  if (url.pathname === '/v1/refunds') return failRefunds ? json({ error: { message: 'Stripe is down' } }, 500) : list(stripe.refunds as Array<{ id: string; created: number }>);
  if (url.pathname === '/v1/subscriptions') return json({ object: 'list', data: [], has_more: false });
  const m = url.pathname.match(/^\/v1\/charges\/([^/]+)$/);
  if (m) {
    const c = stripe.charges.find((x) => x.id === m[1]);
    return c ? json(c) : json({ error: { message: 'No such charge' } }, 404);
  }
  return json({ error: { message: 'not found' } }, 404);
});

const meta = { syncedAt: NOW, backfilled: false };
const row = async (id: string) => (await db.select().from(payments).where(eq(payments.stripeId, id)))[0];

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  await setSetting(STRIPE_KEYS.secretKey, 'rk_test_abcdefghijklmnop', { secret: true });
  await setSetting(SETTING_KEYS.backfillFrom, '2026-08-20');
  // The mirror as production had it: everything EXCEPT a Sep 2–11 hole, and ch_3UAvd1 without its refund.
  const hole = (c: C) => c.id >= 'ch_2026-09-02' && c.id <= 'ch_2026-09-11';
  await upsertCharges(
    stripe.charges.filter((c) => !hole(c)).map((c) => (c.id === 'ch_3UAvd1' ? { ...c, amount_refunded: 0, refunded: false } : c)) as never,
    meta,
  );
});
afterAll(() => vi.unstubAllGlobals());

describe('diffBooks (pure)', () => {
  it('flags a day whose count, amount or refunded sum differs, per currency', () => {
    const t = (count: number, amountCents: number, refundedCents = 0) => ({ count, amountCents, refundedCents });
    const s = new Map([['2026-09-01', new Map([['CAD', t(1, 100)], ['USD', t(1, 50, 50)]])]]);
    const m = new Map([['2026-09-01', new Map([['CAD', t(1, 100)], ['USD', t(1, 50, 0)]])]]);
    expect(diffBooks(s, m, ['2026-09-01', '2026-09-02'])).toEqual([{ date: '2026-09-01', currency: 'USD', stripe: t(1, 50, 50), mirror: t(1, 50, 0) }]);
  });
});

describe('runStripeCompleteness', () => {
  it('resumable: a tiny budget checks one 30-day chunk per run and continues next run', async () => {
    const first = await runStripeCompleteness({ trigger: 'cron', budgetMs: 0, now: NOW });
    expect(first).toMatchObject({ ok: true, partial: true, checkedDays: 30 });
    expect(first.progress).toMatch(/checked through 2026-09-18 — the sweep continues from 2026-09-19 next run/);
  });

  it('finds the Sep 2–11 hole and the unrefunded invoice charge, re-fills them from Stripe, and proves every day matches', async () => {
    // The first (partial) run already re-filled its chunk (Aug 20 – Sep 18 holds the hole and ch_3UAvd1).
    expect(await row('ch_2026-09-05')).toBeTruthy();
    const vd1 = await row('ch_3UAvd1');
    expect(vd1).toMatchObject({ refundedCents: 100_000, status: 'refunded', paymentClass: 'excluded' }); // no longer cash
    const second = await runStripeCompleteness({ trigger: 'cron', now: NOW });
    expect(second).toMatchObject({ ok: true, stillDiffering: [] });
    expect(second.progress).toMatch(/^sweep 2026-08-20 – 2026-09-29 complete in 2 run\(s\): 11 day\(s\) re-filled, 0 differ$/); // 10 hole days + Sep 1
    expect(JSON.parse((await getSetting(SETTING_KEYS.stripeCompleteness))!)).toMatchObject({ checkedFrom: '2026-08-20', checkedThrough: '2026-09-29', refilledDays: 11, stillDiffering: [] });
    expect(JSON.parse((await getSetting('marker:stripe.completeness'))!)).toMatchObject({ runId: second.runId, fetched: 42 });
  });

  it('is not repeated within 20 h — the next sweep says when it starts', async () => {
    const r = await runStripeCompleteness({ trigger: 'cron', now: NOW });
    expect(r.skipped).toMatch(/last full sweep completed .* — the next starts 20 h after it/);
  });

  it('a day that still differs after re-fill (a mirror row Stripe does not have) FAILS with a named incident', async () => {
    await db.insert(payments).values({ stripeId: 'ch_ghost', kind: 'charge', status: 'succeeded', amountCents: 999, currency: 'CAD', stripeCreatedAt: new Date(noonUtc('2026-09-15') * 1000), paidAt: new Date(noonUtc('2026-09-15') * 1000), source: 'stripe', origin: 'stripe' });
    const r = await runStripeCompleteness({ trigger: 'cron', force: true, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.stillDiffering).toMatchObject([{ date: '2026-09-15', currency: 'CAD', stripe: { count: 1 }, mirror: { count: 2 } }]);
    const inc = (await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'stripe_completeness'))).at(-1)!;
    expect(inc.message).toBe('Stripe 2026-09-15 CAD still differs after re-fill: Stripe 1 charges / 50000¢ / refunded 0¢ vs mirror 2 / 50999¢ / 0¢');
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, r.runId!));
    expect(run.status).toBe('failed');
    await db.delete(payments).where(eq(payments.stripeId, 'ch_ghost'));
  });
});

describe('the refund bug class', () => {
  it('two partial refunds SUM onto the parent; covering the amount sets status refunded', async () => {
    await upsertCharges([charge('ch_partial', '2026-09-20', { amount: 10_000 })] as never, meta);
    await upsertRefunds([{ id: 're_p1', charge: 'ch_partial', amount: 3_000, currency: 'cad', status: 'succeeded', created: noonUtc('2026-09-21') }] as never, meta);
    await upsertRefunds([{ id: 're_p2', charge: 'ch_partial', amount: 2_000, currency: 'cad', status: 'succeeded', created: noonUtc('2026-09-22') }] as never, meta);
    expect(await row('ch_partial')).toMatchObject({ refundedCents: 5_000, status: 'succeeded' });
    await upsertRefunds([{ id: 're_p3', charge: 'ch_partial', amount: 5_000, currency: 'cad', status: 'succeeded', created: noonUtc('2026-09-23') }] as never, meta);
    expect(await row('ch_partial')).toMatchObject({ refundedCents: 10_000, status: 'refunded' });
  });

  it('a refund whose parent charge is not mirrored FETCHES the parent (an UPDATE of a missing row was a silent no-op)', async () => {
    stripe.charges.push(charge('ch_late', '2026-09-25', { amount: 7_000, amount_refunded: 7_000, refunded: true }));
    await upsertRefunds([{ id: 're_late', charge: 'ch_late', amount: 7_000, currency: 'cad', status: 'succeeded', created: noonUtc('2026-09-26') }] as never, meta);
    expect(await row('ch_late')).toMatchObject({ refundedCents: 7_000, status: 'refunded' });
  });

  it('a failed /v1/refunds read FAILS the delta and the high-water mark does not move', async () => {
    await setSetting(SETTING_KEYS.stripeDeltaSince, '2026-09-29T00:00:00.000Z');
    failRefunds = true;
    const r = await runStripeSync({ mode: 'delta', trigger: 'cron' });
    failRefunds = false;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^refunds: Stripe 500/);
    expect(await getSetting(SETTING_KEYS.stripeDeltaSince)).toBe('2026-09-29T00:00:00.000Z');
  });

  it('webhook charge.refund.updated is stored as a REFUND, never as a cash charge', async () => {
    await setSetting(STRIPE_KEYS.webhookSecret, 'whsec_test', { secret: true });
    const body = JSON.stringify({ id: 'evt_r', type: 'charge.refund.updated', created: 1, data: { object: { id: 're_hook', object: 'refund', charge: 'ch_partial', amount: 1_000, currency: 'cad', status: 'succeeded', created: noonUtc('2026-09-27') } } });
    const res = await webhookPost(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': signStripePayload(body, 'whsec_test', Math.floor(Date.now() / 1000)) } }));
    expect(res.status).toBe(200);
    expect(await row('re_hook')).toMatchObject({ kind: 'refund', amountCents: 1_000 });
  });
});
