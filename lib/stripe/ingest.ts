/**
 * Stripe → payments ingestion (READ-ONLY, idempotent).
 *
 *   delta      hourly steady state: charges / subscriptions / refunds CREATED
 *              since the last delta (minus DELTA_OVERLAP_MS). A few requests,
 *              one INSERT per page; matching/classification only when rows
 *              were written. Typically well under 5 s.
 *   reconcile  heavy, once per RECONCILE_EVERY_HOURS (marker
 *              stripe_reconcile_completed_at): charges + refunds from the
 *              last 7 days and EVERY subscription (status=all — catches
 *              cancellations / status changes a delta cannot see), then
 *              matching + classification. Resumable: stripe_sync_cursor after
 *              every page, stops starting pages at `budgetMs` → 'partial'.
 *   backfill   one-off from settings.backfill_from (2026-06-01); resumable too.
 *
 * `runScheduledStripeSync` (the dispatch) picks delta vs reconcile.
 *
 * The webhook route reuses `upsertCharge` / `upsertSubscription` /
 * `upsertRefund`, so real-time and scheduled paths write identical rows.
 * Rows are keyed by Stripe id. contactId / matchSource / paymentClass are NEVER
 * touched by an upsert — matching and classification are separate steps that
 * run after every sync; manual matches persist.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, payments, syncRuns, syncIncidents } from '@/db';
import { getDayBounds } from '../day';
import { getSetting, setSetting, getTimezone, SETTING_KEYS, BACKFILL_DEFAULTS } from '../settings';
import { normalizeEmail, normalizePhone } from '../ghl/transitions';
import { getStripeConfig } from './config';
import { listPage, stripeRequest, getStripeRequestCount, type StripeQuery } from './client';
import { runPaymentMatching } from './matching';
import { runPaymentClassification } from './classify';
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
import { captureException } from '../sentry';
import { sweepStaleRuns } from '../staleRuns';
import { writeMarker } from '../sync/markers';

export type StripeSyncMode = 'delta' | 'reconcile' | 'backfill';

export interface StripeSyncResult {
  ok: boolean;
  /** A reconcile/backfill stopped at its time budget; `stripe_sync_cursor` resumes it next run. */
  partial?: boolean;
  progress?: string | null;
  notConfigured?: boolean;
  runId: string | null;
  mode: StripeSyncMode;
  since: Date | null;
  stats: { charges: number; subscriptions: number; refunds: number; rejectedRows: number; matched: number; unmatched: number; classified: number };
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

type PaymentInsert = typeof payments.$inferInsert;

// ---- Row builders (pure) — the webhook and both sync modes write identical rows ----

export function chargeRow(charge: StripeCharge, meta: UpsertMeta): PaymentInsert {
  const { id: customerId, customer } = customerOf(charge.customer);
  const email = customer?.email ?? charge.billing_details?.email ?? null;
  const phone = customer?.phone ?? charge.billing_details?.phone ?? null;
  const name = customer?.name ?? charge.billing_details?.name ?? null;
  const invoiceId = typeof charge.invoice === 'string' ? charge.invoice : (charge.invoice?.id ?? null);
  const status = charge.refunded ? 'refunded' : charge.status;
  const created = unixToDate(charge.created);
  return {
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
    stripeCreatedAt: created,
    metadata: { ...(charge.metadata ?? {}), invoice: invoiceId, failure_message: charge.failure_message ?? null },
    source: 'stripe',
    origin: 'stripe',
    syncedAt: meta.syncedAt,
    backfilled: meta.backfilled,
    updatedAt: meta.syncedAt,
  };
}

export function subscriptionRow(sub: StripeSubscription, meta: UpsertMeta): PaymentInsert {
  const { id: customerId, customer } = customerOf(sub.customer);
  const { amountCents, intervalMonths } = monthlyAmountCents(sub);
  return {
    stripeId: sub.id,
    stripeCustomerId: customerId,
    kind: 'subscription',
    status: sub.status,
    amountCents,
    refundedCents: 0,
    // Stripe's own code (was hard-coded USD until 2026-09-29 — C1).
    currency: (sub.currency ?? sub.items.data[0]?.price?.currency ?? 'usd').toUpperCase(),
    email: customer?.email ?? null,
    emailNormalized: normalizeEmail(customer?.email),
    phoneNormalized: normalizePhone(customer?.phone),
    customerName: customer?.name ?? null,
    intervalMonths,
    paidAt: unixToDate(sub.current_period_start) ?? unixToDate(sub.created),
    stripeCreatedAt: unixToDate(sub.created),
    source: 'stripe',
    origin: 'stripe',
    syncedAt: meta.syncedAt,
    backfilled: meta.backfilled,
    updatedAt: meta.syncedAt,
  };
}

export function refundRow(refund: StripeRefund, meta: UpsertMeta): PaymentInsert & { metadata: { charge: string | null } } {
  const chargeId = typeof refund.charge === 'string' ? refund.charge : (refund.charge?.id ?? null);
  return {
    stripeId: refund.id,
    kind: 'refund',
    status: refund.status ?? 'succeeded',
    amountCents: refund.amount,
    refundedCents: 0,
    currency: (refund.currency ?? 'usd').toUpperCase(),
    description: refund.reason ?? null,
    paidAt: unixToDate(refund.created),
    stripeCreatedAt: unixToDate(refund.created),
    metadata: { charge: chargeId },
    source: 'stripe',
    origin: 'stripe',
    syncedAt: meta.syncedAt,
    backfilled: meta.backfilled,
    updatedAt: meta.syncedAt,
  };
}

// ---- Batched upserts: ONE statement per page ----
//
// 2026-09-30 production finding: the scheduled reconcile took ~49 s for 5
// Stripe requests — it upserted ~330 rows (every subscription, every 7-day
// charge) one round trip each (~145 ms apiece from the function to Supabase).
// A page is now one INSERT … ON CONFLICT with the new values read from
// `excluded`. contactId / matchSource / paymentClass are never in the set.

const excluded = (col: { name: string }) => sql.raw(`excluded."${col.name}"`);

/** Columns an upsert overwrites (conflict target stripe_id). refunded_cents only ever grows. */
function conflictSet(keys: Array<keyof PaymentInsert>) {
  const set: Record<string, unknown> = {};
  for (const k of keys) {
    const col = (payments as unknown as Record<string, { name: string }>)[k as string];
    set[k as string] = k === 'refundedCents' ? sql`greatest(${payments.refundedCents}, ${excluded(col)})` : excluded(col);
  }
  return set;
}

/** Last row per stripe id — Postgres refuses to update the same row twice in one statement. */
function dedupe<T extends { stripeId?: string | null }>(rows: T[]): T[] {
  return Array.from(new Map(rows.map((r) => [r.stripeId, r])).values());
}

async function upsertRows(rows: PaymentInsert[], refundedGrowsOnly: boolean): Promise<number> {
  const unique = dedupe(rows);
  if (unique.length === 0) return 0;
  const keys = Object.keys(unique[0]).filter((k) => k !== 'stripeId') as Array<keyof PaymentInsert>;
  const set = conflictSet(keys);
  if (!refundedGrowsOnly && 'refundedCents' in set) set.refundedCents = excluded(payments.refundedCents);
  await db.insert(payments).values(unique).onConflictDoUpdate({ target: payments.stripeId, set });
  return unique.length;
}

export async function upsertCharges(charges: StripeCharge[], meta: UpsertMeta): Promise<number> {
  return upsertRows(charges.map((c) => chargeRow(c, meta)), true);
}

export async function upsertSubscriptions(subs: StripeSubscription[], meta: UpsertMeta): Promise<number> {
  return upsertRows(subs.map((s) => subscriptionRow(s, meta)), false);
}

export async function upsertRefunds(refunds: StripeRefund[], meta: UpsertMeta): Promise<number> {
  const rows = refunds.map((r) => refundRow(r, meta));
  const n = await upsertRows(rows, false);
  const parents = Array.from(new Set(rows.map((r) => r.metadata.charge).filter((c): c is string => Boolean(c))));
  await applyRefundsToParents(parents, meta);
  return n;
}

/**
 * Reflect refunds on their parent charges — the F12 bug class (2026-09-30: ch_3UAvd1, $1,000 USD, fully refunded
 * in Stripe, refunded_cents 0 in the mirror, counted as cash). The parent's refunded amount is the SUM of its
 * refund rows (several partial refunds used to keep only one), `status` becomes 'refunded' when it covers the
 * amount, and a parent we have never stored is FETCHED and stored — an UPDATE of a missing row was a silent no-op.
 */
export async function applyRefundsToParents(chargeIds: string[], meta: UpsertMeta): Promise<{ fetchedParents: number; missingParents: string[] }> {
  const out = { fetchedParents: 0, missingParents: [] as string[] };
  for (const chargeId of chargeIds) {
    const [parent] = await db.select({ id: payments.id }).from(payments).where(eq(payments.stripeId, chargeId)).limit(1);
    if (!parent) {
      const charge = await fetchCharge(chargeId);
      if (!charge) {
        out.missingParents.push(chargeId);
        continue;
      }
      await upsertCharges([charge], meta); // carries Stripe's own amount_refunded / refunded
      out.fetchedParents += 1;
    }
    const [{ refunded }] = await db
      .select({ refunded: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.kind, 'refund'), inArray(payments.status, ['succeeded', 'pending']), sql`${payments.metadata}->>'charge' = ${chargeId}`));
    await db
      .update(payments)
      .set({
        refundedCents: sql`greatest(${payments.refundedCents}, ${Number(refunded)})`,
        status: sql`case when greatest(${payments.refundedCents}, ${Number(refunded)}) >= ${payments.amountCents} and ${payments.amountCents} > 0 then 'refunded' else ${payments.status} end`,
        updatedAt: meta.syncedAt,
      })
      .where(eq(payments.stripeId, chargeId));
  }
  return out;
}

/** Single-row forms for the webhook. */
export async function upsertCharge(charge: StripeCharge, meta: UpsertMeta): Promise<void> {
  await upsertCharges([charge], meta);
}
export async function upsertSubscription(sub: StripeSubscription, meta: UpsertMeta): Promise<void> {
  await upsertSubscriptions([sub], meta);
}
export async function upsertRefund(refund: StripeRefund, meta: UpsertMeta): Promise<void> {
  await upsertRefunds([refund], meta);
}

// ---- Sync: incremental delta (hourly) and resumable reconcile (daily) ----

/** The delta re-reads this much before its high-water mark (clock skew, late-settling objects). */
export const DELTA_OVERLAP_MS = 60 * 60 * 1000;
/** A scheduled run does the heavy reconcile when the last completed one is older than this. */
export const RECONCILE_EVERY_HOURS = 20;

type Phase = 'charges' | 'subscriptions' | 'refunds';
const PHASES: Phase[] = ['charges', 'subscriptions', 'refunds'];

export interface StripeSyncCursor {
  mode: 'reconcile' | 'backfill';
  phase: Phase;
  startingAfter: string | null;
  sinceUnix: number;
  cycleStartedAt: string;
  stats: StripeSyncResult['stats'];
}

export async function readStripeCursor(): Promise<StripeSyncCursor | null> {
  const raw = await getSetting(SETTING_KEYS.stripeSyncCursor);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as StripeSyncCursor;
    return c && PHASES.includes(c.phase) && (c.mode === 'reconcile' || c.mode === 'backfill') ? c : null;
  } catch {
    return null;
  }
}

async function writeStripeCursor(c: StripeSyncCursor | null): Promise<void> {
  await setSetting(SETTING_KEYS.stripeSyncCursor, c ? JSON.stringify(c) : '');
}

/** Which scheduled mode is due (pure): a reconcile in progress resumes; one older than its cadence starts; else delta. */
export function scheduledStripeMode(input: { cursor: StripeSyncCursor | null; reconcileCompletedAt: string | null; now: Date }): 'delta' | 'reconcile' {
  if (input.cursor) return 'reconcile';
  if (!input.reconcileCompletedAt) return 'reconcile';
  const age = input.now.getTime() - new Date(input.reconcileCompletedAt).getTime();
  return !Number.isFinite(age) || age >= RECONCILE_EVERY_HOURS * 3_600_000 ? 'reconcile' : 'delta';
}

/** The dispatch entry point: delta normally, the heavy reconcile when its marker says so (budgeted, resumable). */
export async function runScheduledStripeSync(opts: { budgetMs: number; now?: Date }): Promise<StripeSyncResult> {
  const [cursor, reconcileCompletedAt] = await Promise.all([readStripeCursor(), getSetting(SETTING_KEYS.stripeReconcileCompletedAt)]);
  const mode = scheduledStripeMode({ cursor, reconcileCompletedAt: reconcileCompletedAt || null, now: opts.now ?? new Date() });
  return runStripeSync({ mode, trigger: 'cron', budgetMs: opts.budgetMs });
}

const PHASE_QUERY: Record<Phase, { path: string; query: (sinceUnix: number, mode: StripeSyncMode) => StripeQuery }> = {
  charges: { path: '/v1/charges', query: (since) => ({ created: { gte: since }, expand: ['data.customer'] }) },
  // Reconcile/backfill: EVERY subscription (status changes, cancellations). Delta: only newly created ones.
  subscriptions: { path: '/v1/subscriptions', query: (since, mode) => (mode === 'delta' ? { status: 'all', created: { gte: since }, expand: ['data.customer'] } : { status: 'all', expand: ['data.customer'] }) },
  refunds: { path: '/v1/refunds', query: (since) => ({ created: { gte: since } }) },
};

export async function runStripeSync(options: {
  mode: StripeSyncMode;
  trigger: 'cron' | 'manual' | 'cli' | 'webhook';
  since?: string;
  /** Stop starting new pages after this long; a reconcile/backfill resumes from its cursor next run. */
  budgetMs?: number;
}): Promise<StripeSyncResult> {
  const startedAt = new Date();
  const budgetMs = options.budgetMs ?? Infinity;
  const overBudget = () => Date.now() - startedAt.getTime() >= budgetMs;
  let stats = { charges: 0, subscriptions: 0, refunds: 0, rejectedRows: 0, matched: 0, unmatched: 0, classified: 0 };
  const warnings: string[] = [];
  const requestsBefore = getStripeRequestCount();

  const config = await getStripeConfig();
  if (!config.configured) {
    return { ok: false, notConfigured: true, runId: null, mode: options.mode, since: null, stats, warnings, requestsUsed: 0, error: 'Stripe is not connected.', durationMs: 0 };
  }

  await sweepStaleRuns(startedAt);

  // Resume a reconcile/backfill in progress (an explicit `since` or a delta never resumes one).
  const existing = options.mode !== 'delta' && !options.since ? await readStripeCursor() : null;
  const mode: StripeSyncMode = existing?.mode ?? options.mode;
  const backfilled = mode === 'backfill';
  const kind = mode === 'backfill' ? 'stripe_backfill' : mode === 'delta' ? 'stripe_delta' : 'stripe_reconcile';

  const [run] = await db.insert(syncRuns).values({ kind, trigger: options.trigger, status: 'running', startedAt }).returning({ id: syncRuns.id });

  let since: Date;
  let cursor: StripeSyncCursor | null = existing;
  if (cursor) {
    since = new Date(cursor.sinceUnix * 1000);
    stats = { ...cursor.stats };
  } else if (options.since) {
    since = new Date(options.since);
  } else if (mode === 'backfill') {
    const from = (await getSetting(SETTING_KEYS.backfillFrom)) ?? BACKFILL_DEFAULTS.ghl;
    since = new Date(getDayBounds(from, await getTimezone()).startMs);
  } else if (mode === 'delta') {
    const hwm = await getSetting(SETTING_KEYS.stripeDeltaSince);
    const hwmMs = hwm ? new Date(hwm).getTime() : NaN;
    since = Number.isFinite(hwmMs) ? new Date(hwmMs - DELTA_OVERLAP_MS) : new Date(startedAt.getTime() - RECONCILE_LOOKBACK_DAYS * 86_400_000);
  } else {
    since = new Date(startedAt.getTime() - RECONCILE_LOOKBACK_DAYS * 86_400_000);
  }
  const sinceUnix = Math.floor(since.getTime() / 1000);
  if (!cursor && mode !== 'delta') {
    cursor = { mode, phase: 'charges', startingAfter: null, sinceUnix, cycleStartedAt: startedAt.toISOString(), stats };
  }

  const finish = async (status: 'succeeded' | 'partial' | 'failed', error?: string, progress?: string): Promise<StripeSyncResult> => {
    const finishedAt = new Date();
    const requestsUsed = getStripeRequestCount() - requestsBefore;
    const recorded: Record<string, number | string> = { ...stats };
    if (progress) recorded.reason = progress;
    await db
      .update(syncRuns)
      .set({ status, finishedAt, since, requestsUsed, stats: recorded, warnings, error: error ?? null })
      .where(eq(syncRuns.id, run.id));
    if (status === 'failed' && error) {
      await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Stripe sync failed: ${error}` });
    }
    return {
      ok: status !== 'failed', partial: status === 'partial', progress: progress ?? null, runId: run.id, mode, since, stats, warnings, requestsUsed, error,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  };

  const meta = { syncedAt: startedAt, backfilled };
  let written = 0;

  const ingestPage = async (phase: Phase, items: unknown[]) => {
    if (phase === 'charges') {
      const parsed = parseMany(StripeChargeSchema, items, 'charge');
      stats.rejectedRows += parsed.rejected;
      warnings.push(...parsed.warnings);
      stats.charges += await upsertCharges(parsed.valid, meta);
      written += parsed.valid.length;
    } else if (phase === 'subscriptions') {
      const parsed = parseMany(StripeSubscriptionSchema, items, 'subscription');
      stats.rejectedRows += parsed.rejected;
      warnings.push(...parsed.warnings);
      stats.subscriptions += await upsertSubscriptions(parsed.valid, meta);
      written += parsed.valid.length;
    } else {
      const parsed = parseMany(StripeRefundSchema, items, 'refund');
      stats.rejectedRows += parsed.rejected;
      warnings.push(...parsed.warnings);
      stats.refunds += await upsertRefunds(parsed.valid, meta);
      written += parsed.valid.length;
    }
  };

  try {
    if (mode === 'delta') {
      // Small by construction: only objects created since the last delta (minus the overlap).
      for (const phase of PHASES) {
        let after: string | null = null;
        do {
          const page = await listPage(PHASE_QUERY[phase].path, PHASE_QUERY[phase].query(sinceUnix, mode), after, config);
          if (page.error) {
            // F12: a failed refunds (or subscriptions) read is a FAILED run — the high-water mark must not move past
            // data we never saw (a swallowed /v1/refunds error left refunds out of the mirror for good).
            return finish('failed', `${phase}: ${page.error}`);
          }
          await ingestPage(phase, page.items);
          after = page.lastId;
        } while (after);
      }
    } else {
      // Reconcile / backfill: page by page, cursor persisted after each, stops STARTING pages at the budget.
      let c = cursor!;
      let pages = 0;
      while (true) {
        // At least one page per run, so any budget makes progress.
        if (pages > 0 && overBudget()) {
          c = { ...c, stats };
          await writeStripeCursor(c);
          return finish('partial', undefined, `paused at ${c.phase}${c.startingAfter ? ` after ${c.startingAfter}` : ''} — resumes next run`);
        }
        const q = PHASE_QUERY[c.phase];
        const page = await listPage(q.path, q.query(c.sinceUnix, mode), c.startingAfter, config);
        pages += 1;
        if (page.error) {
          // Any phase: keep the cursor on this page, fail the run with the reason (F12 — never skip a phase silently).
          await writeStripeCursor({ ...c, stats });
          return finish('failed', `${c.phase}: ${page.error}`);
        } else {
          await ingestPage(c.phase, page.items);
        }
        if (page.lastId) {
          c = { ...c, startingAfter: page.lastId, stats };
        } else {
          const next = PHASES[PHASES.indexOf(c.phase) + 1];
          if (!next) break;
          c = { ...c, phase: next, startingAfter: null, stats };
        }
        await writeStripeCursor(c);
      }
    }

    // Matching + classification read the whole table: only worth it when rows were written.
    if (written > 0 || mode !== 'delta') {
      const matching = await runPaymentMatching();
      stats.matched += matching.matched;
      stats.unmatched = matching.unmatched;
      // Initial vs recurring is a property of the customer's whole history (idempotent; only changes written).
      const classification = await runPaymentClassification();
      stats.classified += classification.updated;
    }

    if (mode === 'delta') {
      await setSetting(SETTING_KEYS.stripeDeltaSince, startedAt.toISOString());
    } else {
      await writeStripeCursor(null);
      // A reconcile also covers everything a delta would have read.
      const cycleStart = cursor?.cycleStartedAt ?? startedAt.toISOString();
      await setSetting(SETTING_KEYS.stripeReconcileCompletedAt, cycleStart);
      const prior = await getSetting(SETTING_KEYS.stripeDeltaSince);
      if (!prior || new Date(prior).getTime() < new Date(cycleStart).getTime()) await setSetting(SETTING_KEYS.stripeDeltaSince, cycleStart);
    }
    // Freshness marker (Ingestion v2): written only here, after this run read Stripe to completion.
    await writeMarker({ family: 'stripe.payments', runId: run.id, fetched: stats.charges + stats.subscriptions + stats.refunds, detail: `${mode} · ${stats.charges} charges, ${stats.refunds} refunds, ${stats.subscriptions} subscriptions` });
    return finish('succeeded');
  } catch (err) {
    captureException(err, { source: 'stripe' });
    return finish('failed', err instanceof Error ? err.message : String(err));
  }
}

/** Used by the webhook when an invoice event carries only a charge id. */
export async function fetchCharge(chargeId: string): Promise<StripeCharge | null> {
  const res = await stripeRequest(`/v1/charges/${chargeId}`, { expand: ['customer'] }, StripeChargeSchema);
  return res.ok ? res.data : null;
}
