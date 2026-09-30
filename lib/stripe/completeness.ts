/**
 * Stripe completeness sweep (F12, 2026-09-30) — the mirror REPAIRS ITSELF.
 *
 * The 2026-09-29 verification found 34 charges from Sep 2–11 missing entirely ($19,393.75 CAD + $4,750 USD — the
 * Phase L outage; the reconcile only ever looked back 7 days) and ch_3UAvd1 fully refunded in Stripe but not in
 * the mirror. Recency checks cannot see either. This sweep compares Stripe and the mirror PER DAY since
 * settings.backfill_from, per currency: charge count, amount sum and refunded sum. A day that differs is re-filled
 * from the charges just listed (Stripe's own amount_refunded / refunded included) plus that day's refunds, then
 * compared again; a day that STILL differs opens an incident naming it with both sides' numbers.
 *
 * One listing per 30-day chunk (charges created in the window, paged), resumable via
 * settings.stripe_completeness_cursor under a time budget; a full sweep at most every SWEEP_EVERY_HOURS.
 * Days are the business timezone's days. Read-only against Stripe (GET only).
 */

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { tsParam } from '../sqlTime';
import { db, payments, syncRuns, syncIncidents } from '@/db';
import { getDayBounds, addDays, todayInTimezone } from '../day';
import { getSetting, setSetting, getTimezone, SETTING_KEYS, BACKFILL_DEFAULTS } from '../settings';
import { getStripeConfig } from './config';
import { listPage, getStripeRequestCount } from './client';
import { StripeChargeSchema, StripeRefundSchema, parseMany, type StripeCharge } from './schemas';
import { upsertCharges, upsertRefunds } from './ingest';
import { runPaymentMatching } from './matching';
import { runPaymentClassification } from './classify';
import { writeMarker } from '../sync/markers';
import { sweepStaleRuns } from '../staleRuns';

export const DAYS_PER_CHUNK = 30;
export const SWEEP_EVERY_HOURS = 20;

export interface DayTotals {
  count: number;
  amountCents: number;
  refundedCents: number;
}
/** day → currency → totals */
export type DayBook = Map<string, Map<string, DayTotals>>;

export interface DayDiff {
  date: string;
  currency: string;
  stripe: DayTotals;
  mirror: DayTotals;
}

export interface CompletenessCursor {
  sweepStartedAt: string;
  /** First day not yet checked in this sweep (YYYY-MM-DD, business timezone). */
  nextDay: string;
  from: string;
  chargesSeen: number;
  refilledDays: number;
  runs: number;
}

export interface CompletenessSummary {
  checkedFrom: string;
  checkedThrough: string;
  lastSweepCompletedAt: string | null;
  refilledDays: number;
  stillDiffering: DayDiff[];
  runAt: string;
}

export interface CompletenessResult {
  ok: boolean;
  notConfigured?: boolean;
  skipped?: string;
  partial?: boolean;
  progress?: string;
  error?: string;
  runId?: string;
  checkedDays: number;
  refilledDays: number;
  stillDiffering: DayDiff[];
}

const zero = (): DayTotals => ({ count: 0, amountCents: 0, refundedCents: 0 });

/** Pure: the days (and currencies) whose totals differ. */
export function diffBooks(stripe: DayBook, mirror: DayBook, days: string[]): DayDiff[] {
  const out: DayDiff[] = [];
  for (const date of days) {
    const s = stripe.get(date) ?? new Map();
    const m = mirror.get(date) ?? new Map();
    for (const currency of new Set([...s.keys(), ...m.keys()])) {
      const a = s.get(currency) ?? zero();
      const b = m.get(currency) ?? zero();
      if (a.count !== b.count || a.amountCents !== b.amountCents || a.refundedCents !== b.refundedCents) out.push({ date, currency, stripe: a, mirror: b });
    }
  }
  return out;
}

function localDay(ms: number, timezone: string): string {
  return todayInTimezone(timezone, new Date(ms));
}

/** Stripe side of the book: charges bucketed by their `created` day in the business timezone. */
export function bookFromCharges(charges: StripeCharge[], timezone: string): DayBook {
  const book: DayBook = new Map();
  for (const c of charges) {
    const day = localDay(c.created * 1000, timezone);
    const ccy = c.currency.toUpperCase();
    const byCcy = book.get(day) ?? new Map<string, DayTotals>();
    const t = byCcy.get(ccy) ?? zero();
    t.count += 1;
    t.amountCents += c.amount;
    t.refundedCents += c.amount_refunded;
    byCcy.set(ccy, t);
    book.set(day, byCcy);
  }
  return book;
}

/**
 * Mirror side: stored charges/invoices bucketed the same way (created, else paid/failed time for pre-F12 rows).
 * The range bounds go through tsParam: `at` is a raw coalesce(...) with no column type, so a bare Date would reach
 * postgres-js as Date.toString() (the 2026-09-30 22007 crash). Exported so tests can replay it on real Postgres.
 */
export function mirrorBookQuery(startMs: number, endMs: number, timezone: string) {
  const at = sql`coalesce(${payments.stripeCreatedAt}, ${payments.paidAt}, ${payments.failedAt})`;
  return db
    .select({
      day: sql<string>`to_char(${at} at time zone ${timezone}, 'YYYY-MM-DD')`,
      currency: payments.currency,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
      refunded: sql<number>`coalesce(sum(${payments.refundedCents}), 0)::int`,
    })
    .from(payments)
    .where(and(eq(payments.origin, 'stripe'), inArray(payments.kind, ['charge', 'invoice']), gte(at, tsParam(new Date(startMs))), lt(at, tsParam(new Date(endMs)))))
    .groupBy(sql`1`, payments.currency);
}

async function mirrorBook(startMs: number, endMs: number, timezone: string): Promise<DayBook> {
  const rows = await mirrorBookQuery(startMs, endMs, timezone);
  const book: DayBook = new Map();
  for (const r of rows) {
    const byCcy = book.get(r.day) ?? new Map<string, DayTotals>();
    byCcy.set(r.currency.toUpperCase(), { count: Number(r.count), amountCents: Number(r.amount), refundedCents: Number(r.refunded) });
    book.set(r.day, byCcy);
  }
  return book;
}

export async function readCompletenessSummary(): Promise<CompletenessSummary | null> {
  const raw = await getSetting(SETTING_KEYS.stripeCompleteness);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CompletenessSummary;
  } catch {
    return null;
  }
}

export async function runStripeCompleteness(opts: { trigger: 'cron' | 'manual' | 'cli'; budgetMs?: number; force?: boolean; now?: Date } = { trigger: 'cron' }): Promise<CompletenessResult> {
  const startedAt = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? 75_000;
  const clockStart = Date.now(); // the budget is wall-clock time, whatever `now` the caller pinned the days to
  const overBudget = () => Date.now() - clockStart >= budgetMs;
  const out: CompletenessResult = { ok: true, checkedDays: 0, refilledDays: 0, stillDiffering: [] };

  const config = await getStripeConfig();
  if (!config.configured) return { ...out, ok: false, notConfigured: true, error: 'Stripe is not connected.' };

  const timezone = await getTimezone();
  const yesterday = addDays(todayInTimezone(timezone, startedAt), -1);
  const summary = await readCompletenessSummary();
  let cursor = await readCursor();
  if (!cursor) {
    const last = summary?.lastSweepCompletedAt ? Date.parse(summary.lastSweepCompletedAt) : NaN;
    if (!opts.force && Number.isFinite(last) && startedAt.getTime() - last < SWEEP_EVERY_HOURS * 3_600_000) {
      return { ...out, skipped: `last full sweep completed ${summary!.lastSweepCompletedAt} — the next starts ${SWEEP_EVERY_HOURS} h after it` };
    }
    const from = (await getSetting(SETTING_KEYS.backfillFrom)) ?? BACKFILL_DEFAULTS.ghl;
    cursor = { sweepStartedAt: startedAt.toISOString(), nextDay: from, from, chargesSeen: 0, refilledDays: 0, runs: 0 };
  }
  cursor.runs += 1;

  await sweepStaleRuns(startedAt);
  const requestsBefore = getStripeRequestCount();
  const [run] = await db.insert(syncRuns).values({ kind: 'stripe_completeness', trigger: opts.trigger, status: 'running', startedAt }).returning({ id: syncRuns.id });
  out.runId = run.id;
  const finish = async (status: 'succeeded' | 'partial' | 'failed', reason: string, error?: string): Promise<CompletenessResult> => {
    await db
      .update(syncRuns)
      .set({ status, finishedAt: new Date(), requestsUsed: getStripeRequestCount() - requestsBefore, stats: { checkedDays: out.checkedDays, refilledDays: out.refilledDays, stillDiffering: out.stillDiffering.length, reason }, error: error ?? null })
      .where(eq(syncRuns.id, run.id));
    return { ...out, ok: status !== 'failed', partial: status === 'partial', progress: reason, error };
  };

  const meta = { syncedAt: startedAt, backfilled: false };
  try {
    while (cursor.nextDay <= yesterday) {
      if (out.checkedDays > 0 && overBudget()) {
        await writeCursor(cursor);
        return finish('partial', `checked through ${addDays(cursor.nextDay, -1)} — the sweep continues from ${cursor.nextDay} next run`);
      }
      const chunkEnd = addDays(cursor.nextDay, DAYS_PER_CHUNK - 1) < yesterday ? addDays(cursor.nextDay, DAYS_PER_CHUNK - 1) : yesterday;
      const startMs = getDayBounds(cursor.nextDay, timezone).startMs;
      const endMs = getDayBounds(chunkEnd, timezone).endMs + 1; // exclusive: next local midnight
      const days: string[] = [];
      for (let d = cursor.nextDay; d <= chunkEnd; d = addDays(d, 1)) days.push(d);

      // Stripe: every charge created in the window.
      const charges: StripeCharge[] = [];
      let after: string | null = null;
      do {
        const page = await listPage('/v1/charges', { created: { gte: Math.floor(startMs / 1000), lt: Math.floor(endMs / 1000) }, expand: ['data.customer'] }, after, config);
        if (page.error) {
          await writeCursor(cursor);
          await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'critical', message: `Stripe completeness: charge listing failed for ${cursor.nextDay} – ${chunkEnd}: ${page.error}` });
          return finish('failed', `charge listing failed for ${cursor.nextDay} – ${chunkEnd}`, page.error);
        }
        const parsed = parseMany(StripeChargeSchema, page.items, 'charge');
        charges.push(...parsed.valid);
        after = page.lastId;
      } while (after);
      cursor.chargesSeen += charges.length;

      const diffs = diffBooks(bookFromCharges(charges, timezone), await mirrorBook(startMs, endMs, timezone), days);
      const badDays = Array.from(new Set(diffs.map((d) => d.date)));
      for (const day of badDays) {
        // Re-fill the day from what Stripe just said (amount_refunded / refunded included), plus its refunds.
        const dayCharges = charges.filter((c) => localDay(c.created * 1000, timezone) === day);
        await upsertCharges(dayCharges, meta);
        const b = getDayBounds(day, timezone);
        let rAfter: string | null = null;
        do {
          const rp = await listPage('/v1/refunds', { created: { gte: Math.floor(b.startMs / 1000), lt: Math.floor((b.endMs + 1) / 1000) } }, rAfter, config);
          if (rp.error) {
            await writeCursor(cursor);
            return finish('failed', `refund listing failed for ${day}`, rp.error);
          }
          await upsertRefunds(parseMany(StripeRefundSchema, rp.items, 'refund').valid, meta);
          rAfter = rp.lastId;
        } while (rAfter);
        out.refilledDays += 1;
        cursor.refilledDays += 1;
      }
      if (badDays.length > 0) {
        const again = diffBooks(bookFromCharges(charges, timezone), await mirrorBook(startMs, endMs, timezone), badDays);
        out.stillDiffering.push(...again);
        // Re-filled rows are matched and classified now, not at the end of a sweep that may span several runs —
        // a refunded charge stops counting as cash in the same run that fixed it.
        await runPaymentMatching();
        await runPaymentClassification();
      }
      out.checkedDays += days.length;
      cursor.nextDay = addDays(chunkEnd, 1);
      await writeCursor(cursor);
    }

    const newSummary: CompletenessSummary = {
      checkedFrom: cursor.from,
      checkedThrough: yesterday,
      lastSweepCompletedAt: new Date().toISOString(),
      refilledDays: cursor.refilledDays,
      stillDiffering: out.stillDiffering,
      runAt: startedAt.toISOString(),
    };
    await setSetting(SETTING_KEYS.stripeCompleteness, JSON.stringify(newSummary));
    await writeCursor(null);

    if (out.stillDiffering.length > 0) {
      for (const d of out.stillDiffering) {
        await db.insert(syncIncidents).values({
          syncRunId: run.id,
          kind: 'stripe_completeness',
          severity: 'critical',
          message: `Stripe ${d.date} ${d.currency} still differs after re-fill: Stripe ${d.stripe.count} charges / ${d.stripe.amountCents}¢ / refunded ${d.stripe.refundedCents}¢ vs mirror ${d.mirror.count} / ${d.mirror.amountCents}¢ / ${d.mirror.refundedCents}¢`,
          details: d as unknown as Record<string, unknown>,
        });
      }
      return finish('failed', `${out.stillDiffering.length} day/currency total(s) still differ after re-fill`, 'Stripe mirror incomplete');
    }
    await writeMarker({ family: 'stripe.completeness', runId: run.id, fetched: cursor.chargesSeen, detail: `complete ${cursor.from} – ${yesterday} · ${cursor.refilledDays} day(s) re-filled` });
    return finish('succeeded', `sweep ${cursor.from} – ${yesterday} complete in ${cursor.runs} run(s): ${cursor.refilledDays} day(s) re-filled, 0 differ`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeCursor(cursor);
    return finish('failed', 'crashed', message);
  }
}

async function readCursor(): Promise<CompletenessCursor | null> {
  const raw = await getSetting(SETTING_KEYS.stripeCompletenessCursor);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as CompletenessCursor;
    return c && typeof c.nextDay === 'string' ? c : null;
  } catch {
    return null;
  }
}

async function writeCursor(c: CompletenessCursor | null): Promise<void> {
  await setSetting(SETTING_KEYS.stripeCompletenessCursor, c ? JSON.stringify(c) : '');
}
