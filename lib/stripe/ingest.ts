/**
 * Stripe → payments ingestion (READ-ONLY, idempotent).
 *
 *   reconcile  scheduled: charges + refunds from the last 7 days, all
 *              subscriptions (status=all). Heals anything a webhook missed.
 *   backfill   one-off from settings.backfill_from (2026-06-16).
 *
 * The webhook route reuses `upsertCharge` / `upsertSubscription` /
 * `upsertRefund`, so real-time and scheduled paths write identical rows.
 * Rows are keyed by Stripe id. contactId / matchSource are NEVER touched by an
 * upsert — matching is a separate step and manual matches persist.
 */

import { eq, sql } from 'drizzle-orm';
import { db, payments, syncRuns, syncIncidents } from '@/db';
import { getDayBounds } from '../day';
import { getSetting, getTimezone, SETTING_KEYS } from '../settings';
import { normalizeEmail, normalizePhone } from '../ghl/transitions';
import { getStripeConfig } from './config';
import { listAll, stripeRequest, getStripeRequestCount } from './client';
import { runPaymentMatching } from './matching';
import {
  StripeChargeSchema,
  StripeSubscriptionSchema,
  StripeRefundSchema,
  parseMany,
  type StripeCharge,
  type StripeSubscription,
  type StripeRefund,
  type StripeCustomer,
} from './schemas';

export type StripeSyncMode = 'reconcile' | 'backfill';

export interface StripeSyncResult {
  ok: boolean;
  notConfigured?: boolean;
  runId: string | null;
  mode: StripeSyncMode;
  since: Date | null;
  stats: { charges: number; subscriptions: number; refunds: number; rejectedRows: number; matched: number; unmatched: number };
  warnings: string[];
  requestsUsed: number;
  error?: string;
  durationMs: number;
}

const RECONCILE_LOOKBACK_DAYS = 7;

function unixToDate(s: number | null | undefined): Date | null {
  return typeof s === 'number' ? new Date(s * 1000) : null;
}

function customerOf(value: string | StripeCustomer | null | undefined): { id: string | null; customer: StripeCustomer | null } {
  if (!value) return { id: null, customer: null };
  if (typeof value === 'string') return { id: value, customer: null };
  return { id: value.id, customer: value };
}

/** Monthly-normalised plan amount in cents. */
export function monthlyAmountCents(sub: StripeSubscription): { amountCents: number; intervalMonths: number | null } {
  const item = sub.items.data[0];
  const price = item?.price;
  if (!price?.unit_amount || !price.recurring) return { amountCents: 0, intervalMonths: null };
  const qty = item?.quantity ?? 1;
  const { interval, interval_count: count } = price.recurring;
  const months = interval === 'year' ? 12 * count : interval === 'month' ? count : interval === 'week' ? (7 * count) / 30.4375 : count / 30.4375;
  return { amountCents: Math.round((price.unit_amount * qty) / months), intervalMonths: interval === 'year' || interval === 'month' ? Math.round(months) : null };
}

interface UpsertMeta {
  syncedAt: Date;
  backfilled: boolean;
}

export async function upsertCharge(charge: StripeCharge, meta: UpsertMeta): Promise<void> {
  const { id: customerId, customer } = customerOf(charge.customer);
  const email = customer?.email ?? charge.billing_details?.email ?? null;
  const phone = customer?.phone ?? charge.billing_details?.phone ?? null;
  const name = customer?.name ?? charge.billing_details?.name ?? null;
  const invoiceId = typeof charge.invoice === 'string' ? charge.invoice : (charge.invoice?.id ?? null);
  const status = charge.refunded ? 'refunded' : charge.status;
  const created = unixToDate(charge.created);

  const values = {
    stripeId: charge.id,
    stripeCustomerId: customerId,
    kind: invoiceId ? 'invoice' : 'charge',
    status,
    amountCents: charge.amount,
    refundedCents: charge.amount_refunded,
    currency: charge.currency.toUpperCase(),
    email,
    emailNormalized: normalizeEmail(email),
    phoneNormalized: normalizePhone(phone),
    customerName: name,
    description: charge.description ?? charge.failure_message ?? null,
    paidAt: charge.status === 'succeeded' ? created : null,
    failedAt: charge.status === 'failed' ? created : null,
    metadata: { ...(charge.metadata ?? {}), invoice: invoiceId, failure_message: charge.failure_message ?? null },
    source: 'stripe',
    origin: 'stripe',
    syncedAt: meta.syncedAt,
    backfilled: meta.backfilled,
    updatedAt: meta.syncedAt,
  };

  await db
    .insert(payments)
    .values(values)
    .onConflictDoUpdate({
      target: payments.stripeId,
      // contactId / matchSource deliberately absent.
      set: { ...values, refundedCents: sql`greatest(${payments.refundedCents}, ${charge.amount_refunded})` },
    });
}

export async function upsertSubscription(sub: StripeSubscription, meta: UpsertMeta): Promise<void> {
  const { id: customerId, customer } = customerOf(sub.customer);
  const { amountCents, intervalMonths } = monthlyAmountCents(sub);
  const values = {
    stripeId: sub.id,
    stripeCustomerId: customerId,
    kind: 'subscription',
    status: sub.status,
    amountCents,
    refundedCents: 0,
    currency: 'USD',
    email: customer?.email ?? null,
    emailNormalized: normalizeEmail(customer?.email),
    phoneNormalized: normalizePhone(customer?.phone),
    customerName: customer?.name ?? null,
    intervalMonths,
    paidAt: unixToDate(sub.current_period_start) ?? unixToDate(sub.created),
    source: 'stripe',
    origin: 'stripe',
    syncedAt: meta.syncedAt,
    backfilled: meta.backfilled,
    updatedAt: meta.syncedAt,
  };
  await db.insert(payments).values(values).onConflictDoUpdate({ target: payments.stripeId, set: values });
}

export async function upsertRefund(refund: StripeRefund, meta: UpsertMeta): Promise<void> {
  const chargeId = typeof refund.charge === 'string' ? refund.charge : (refund.charge?.id ?? null);
  const values = {
    stripeId: refund.id,
    kind: 'refund',
    status: refund.status ?? 'succeeded',
    amountCents: refund.amount,
    refundedCents: 0,
    currency: 'USD',
    description: refund.reason ?? null,
    paidAt: unixToDate(refund.created),
    metadata: { charge: chargeId },
    source: 'stripe',
    origin: 'stripe',
    syncedAt: meta.syncedAt,
    backfilled: meta.backfilled,
    updatedAt: meta.syncedAt,
  };
  await db.insert(payments).values(values).onConflictDoUpdate({ target: payments.stripeId, set: values });

  // Reflect the refund on the parent charge (the engine subtracts refundedCents).
  if (chargeId) {
    await db
      .update(payments)
      .set({ refundedCents: sql`greatest(${payments.refundedCents}, ${refund.amount})`, updatedAt: meta.syncedAt })
      .where(eq(payments.stripeId, chargeId));
  }
}

export async function runStripeSync(options: { mode: StripeSyncMode; trigger: 'cron' | 'manual' | 'cli' | 'webhook'; since?: string }): Promise<StripeSyncResult> {
  const startedAt = new Date();
  const stats = { charges: 0, subscriptions: 0, refunds: 0, rejectedRows: 0, matched: 0, unmatched: 0 };
  const warnings: string[] = [];
  const requestsBefore = getStripeRequestCount();
  const backfilled = options.mode === 'backfill';

  const config = await getStripeConfig();
  if (!config.configured) {
    return { ok: false, notConfigured: true, runId: null, mode: options.mode, since: null, stats, warnings, requestsUsed: 0, error: 'Stripe is not connected.', durationMs: 0 };
  }

  const [run] = await db
    .insert(syncRuns)
    .values({ kind: backfilled ? 'stripe_backfill' : 'stripe_reconcile', trigger: options.trigger, status: 'running', startedAt })
    .returning({ id: syncRuns.id });

  const finish = async (ok: boolean, since: Date | null, error?: string): Promise<StripeSyncResult> => {
    const finishedAt = new Date();
    const requestsUsed = getStripeRequestCount() - requestsBefore;
    await db
      .update(syncRuns)
      .set({ status: ok ? 'succeeded' : 'failed', finishedAt, since, requestsUsed, stats, warnings, error: error ?? null })
      .where(eq(syncRuns.id, run.id));
    if (!ok && error) {
      await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Stripe sync failed: ${error}` });
    }
    return { ok, runId: run.id, mode: options.mode, since, stats, warnings, requestsUsed, error, durationMs: finishedAt.getTime() - startedAt.getTime() };
  };

  // Window
  let since: Date;
  if (options.since) {
    since = new Date(options.since);
  } else if (backfilled) {
    const from = (await getSetting(SETTING_KEYS.backfillFrom)) ?? '2026-06-16';
    since = new Date(getDayBounds(from, await getTimezone()).startMs);
  } else {
    since = new Date(startedAt.getTime() - RECONCILE_LOOKBACK_DAYS * 86_400_000);
  }
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const meta = { syncedAt: startedAt, backfilled };

  try {
    const charges = await listAll('/v1/charges', { created: { gte: sinceUnix }, expand: ['data.customer'] });
    if (charges.error) return finish(false, since, charges.error);
    const parsedCharges = parseMany(StripeChargeSchema, charges.items, 'charge');
    stats.rejectedRows += parsedCharges.rejected;
    warnings.push(...parsedCharges.warnings);
    for (const c of parsedCharges.valid) {
      await upsertCharge(c, meta);
      stats.charges += 1;
    }

    const subs = await listAll('/v1/subscriptions', { status: 'all', expand: ['data.customer'] });
    if (subs.error) warnings.push(`Subscriptions: ${subs.error}`);
    const parsedSubs = parseMany(StripeSubscriptionSchema, subs.items, 'subscription');
    stats.rejectedRows += parsedSubs.rejected;
    warnings.push(...parsedSubs.warnings);
    for (const s of parsedSubs.valid) {
      await upsertSubscription(s, meta);
      stats.subscriptions += 1;
    }

    const refunds = await listAll('/v1/refunds', { created: { gte: sinceUnix } });
    if (refunds.error) warnings.push(`Refunds: ${refunds.error}`);
    const parsedRefunds = parseMany(StripeRefundSchema, refunds.items, 'refund');
    stats.rejectedRows += parsedRefunds.rejected;
    warnings.push(...parsedRefunds.warnings);
    for (const r of parsedRefunds.valid) {
      await upsertRefund(r, meta);
      stats.refunds += 1;
    }

    const matching = await runPaymentMatching();
    stats.matched = matching.matched;
    stats.unmatched = matching.unmatched;

    return finish(true, since);
  } catch (err) {
    return finish(false, since, err instanceof Error ? err.message : String(err));
  }
}

/** Used by the webhook when an invoice event carries only a charge id. */
export async function fetchCharge(chargeId: string): Promise<StripeCharge | null> {
  const res = await stripeRequest(`/v1/charges/${chargeId}`, { expand: ['customer'] }, StripeChargeSchema);
  return res.ok ? res.data : null;
}
