/**
 * Stripe steady state (2026-09-30): the hourly delta is incremental (created
 * since the high-water mark minus the overlap, subscriptions included), writes
 * a page in one statement, skips matching when nothing is new; the heavy
 * reconcile runs on its marker and resumes page by page under a budget.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, payments, syncRuns } from '@/db';
import { getSetting, setSetting, SETTING_KEYS } from '@/lib/settings';
import { STRIPE_KEYS } from '@/lib/stripe/config';
import {
  runStripeSync, runScheduledStripeSync, scheduledStripeMode, readStripeCursor, DELTA_OVERLAP_MS, RECONCILE_EVERY_HOURS,
} from '@/lib/stripe/ingest';

const T0 = 1_759_000_000; // unix seconds
const charge = (id: string, created: number, extra: Record<string, unknown> = {}) => ({
  id, amount: 10_000, amount_refunded: 0, currency: 'cad', status: 'succeeded', created,
  customer: { id: `cus_${id}`, email: `${id}@x.com` }, billing_details: {}, invoice: null, refunded: false, ...extra,
});
const sub = (id: string, created: number) => ({
  id, customer: { id: `cus_${id}`, email: `${id}@x.com` }, status: 'active', created, current_period_start: created, currency: 'cad',
  items: { data: [{ price: { unit_amount: 5000, currency: 'cad', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }] },
});

const account: { charges: ReturnType<typeof charge>[]; subscriptions: ReturnType<typeof sub>[]; refunds: Array<Record<string, unknown>> } = { charges: [], subscriptions: [], refunds: [] };
const requests: Array<{ path: string; params: URLSearchParams }> = [];
let pageSize = 100;

const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  requests.push({ path: url.pathname, params: url.searchParams });
  const src = url.pathname === '/v1/charges' ? account.charges : url.pathname === '/v1/subscriptions' ? account.subscriptions : url.pathname === '/v1/refunds' ? account.refunds : null;
  if (!src) return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  const gte = url.searchParams.get('created[gte]');
  let rows = src.filter((r) => gte === null || Number(r.created) >= Number(gte));
  const after = url.searchParams.get('starting_after');
  if (after) rows = rows.slice(rows.findIndex((r) => r.id === after) + 1);
  const page = rows.slice(0, pageSize);
  return new Response(JSON.stringify({ object: 'list', data: page, has_more: rows.length > page.length }), { status: 200 });
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  await setSetting(STRIPE_KEYS.secretKey, 'rk_test_abcdefghijklmnop', { secret: true });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  requests.length = 0;
  pageSize = 100;
});

describe('scheduledStripeMode (pure)', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  it('resumes a reconcile in progress, starts one when due or never done, else runs the delta', () => {
    const cursor = { mode: 'reconcile' as const, phase: 'subscriptions' as const, startingAfter: 'sub_9', sinceUnix: 0, cycleStartedAt: now.toISOString(), stats: {} as never };
    expect(scheduledStripeMode({ cursor, reconcileCompletedAt: now.toISOString(), now })).toBe('reconcile');
    expect(scheduledStripeMode({ cursor: null, reconcileCompletedAt: null, now })).toBe('reconcile');
    expect(scheduledStripeMode({ cursor: null, reconcileCompletedAt: new Date(now.getTime() - (RECONCILE_EVERY_HOURS + 1) * 3_600_000).toISOString(), now })).toBe('reconcile');
    expect(scheduledStripeMode({ cursor: null, reconcileCompletedAt: new Date(now.getTime() - 3_600_000).toISOString(), now })).toBe('delta');
  });
});

describe('resumable reconcile', () => {
  it('walks charges → subscriptions → refunds one page per run under a tiny budget, then completes with its marker', async () => {
    account.charges = [charge('ch_a', T0), charge('ch_b', T0 + 10)];
    account.subscriptions = [sub('sub_a', T0 - 999_999)]; // old: reconcile lists EVERY subscription
    account.refunds = [{ id: 're_a', charge: 'ch_a', amount: 4_000, created: T0 + 20, status: 'succeeded', currency: 'cad' }];
    pageSize = 1;

    const first = await runStripeSync({ mode: 'reconcile', trigger: 'cron', since: new Date((T0 - 60) * 1000).toISOString(), budgetMs: 0 });
    expect(first).toMatchObject({ ok: true, partial: true });
    expect(first.progress).toMatch(/paused at charges after ch_a/);
    expect((await readStripeCursor())).toMatchObject({ phase: 'charges', startingAfter: 'ch_a' });
    const [row1] = await db.select().from(syncRuns).where(eq(syncRuns.id, first.runId!));
    expect(row1).toMatchObject({ kind: 'stripe_reconcile', status: 'partial' });

    let last = first;
    const phases: string[] = [];
    for (let i = 0; i < 6 && last.partial; i += 1) {
      last = await runStripeSync({ mode: 'reconcile', trigger: 'cron', budgetMs: 0 });
      const c = await readStripeCursor();
      if (c) phases.push(c.phase);
    }
    expect(last).toMatchObject({ ok: true, partial: false });
    expect(phases).toContain('subscriptions');
    expect(await readStripeCursor()).toBeNull();
    // The marker is the CYCLE's start (the first, partial run), not the run that finished it.
    expect(await getSetting(SETTING_KEYS.stripeReconcileCompletedAt)).toBe(row1.startedAt.toISOString());
    // Stats accumulate across the resumed runs.
    expect(last.stats).toMatchObject({ charges: 2, subscriptions: 1, refunds: 1 });
    // Subscriptions were listed WITHOUT a created filter; the refund reached its parent charge.
    expect(requests.filter((r) => r.path === '/v1/subscriptions').every((r) => r.params.get('created[gte]') === null)).toBe(true);
    const [a] = await db.select().from(payments).where(eq(payments.stripeId, 'ch_a'));
    expect(a.refundedCents).toBe(4_000);
  });
});

describe('incremental delta', () => {
  it('lists only objects created since the high-water mark minus the overlap — subscriptions too — and advances the mark', async () => {
    const hwm = new Date((T0 + 100_000) * 1000);
    await setSetting(SETTING_KEYS.stripeDeltaSince, hwm.toISOString());
    account.charges.push(charge('ch_new', T0 + 100_500));
    account.subscriptions.push(sub('sub_new', T0 + 100_600));
    const before = (await db.select().from(payments)).length;

    const r = await runStripeSync({ mode: 'delta', trigger: 'cron' });
    expect(r).toMatchObject({ ok: true, mode: 'delta' });
    const expectedGte = String(Math.floor((hwm.getTime() - DELTA_OVERLAP_MS) / 1000));
    for (const path of ['/v1/charges', '/v1/subscriptions', '/v1/refunds']) {
      const q = requests.find((x) => x.path === path);
      expect(q?.params.get('created[gte]'), path).toBe(expectedGte);
    }
    expect(requests).toHaveLength(3); // one page each — no full re-list
    expect(r.stats).toMatchObject({ charges: 1, subscriptions: 1, refunds: 0 });
    expect((await db.select().from(payments)).length).toBe(before + 2);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, r.runId!));
    expect(run).toMatchObject({ kind: 'stripe_delta', status: 'succeeded' });
    expect(new Date((await getSetting(SETTING_KEYS.stripeDeltaSince))!).getTime()).toBeGreaterThan(hwm.getTime());
  });

  it('a quiet hour writes nothing and skips matching / classification', async () => {
    const r = await runStripeSync({ mode: 'delta', trigger: 'cron' });
    expect(r.stats).toMatchObject({ charges: 0, subscriptions: 0, refunds: 0, matched: 0, unmatched: 0, classified: 0 });
  });

  it('the scheduled entry point picks the delta while the reconcile marker is fresh', async () => {
    const r = await runScheduledStripeSync({ budgetMs: 15_000 });
    expect(r.mode).toBe('delta');
    await setSetting(SETTING_KEYS.stripeReconcileCompletedAt, new Date(Date.now() - 25 * 3_600_000).toISOString());
    expect((await runScheduledStripeSync({ budgetMs: 15_000 })).mode).toBe('reconcile');
  });

  it('writes a large page in one statement correctly (batched upsert keeps refunded_cents monotonic)', async () => {
    account.subscriptions = Array.from({ length: 150 }, (_, i) => sub(`sub_bulk_${i}`, T0 + 200_000 + i));
    const r = await runStripeSync({ mode: 'reconcile', trigger: 'manual', since: new Date((T0 - 60) * 1000).toISOString() });
    expect(r.stats.charges).toBeGreaterThanOrEqual(2); // ch_a re-listed with amount_refunded 0
    expect(r.ok).toBe(true);
    const bulk = (await db.select().from(payments)).filter((p) => p.stripeId?.startsWith('sub_bulk_'));
    expect(bulk).toHaveLength(150);
    expect(bulk.every((p) => p.amountCents === 5000 && p.currency === 'CAD')).toBe(true);
    // ch_a's refund (4,000) survives a re-list that reports amount_refunded 0.
    const [a] = await db.select().from(payments).where(eq(payments.stripeId, 'ch_a'));
    expect(a.refundedCents).toBe(4_000);
  });
});
