/**
 * Bank of Canada Valet USD→CAD feed (2026-09-30, Mitchell's decision — supersedes "no external FX feed").
 *
 * Every figure mixing CAD and USD depended on a flat 1.36 PLACEHOLDER (all 12 fx_rates rows were `seed`).
 * The dispatch step `fx` now:
 *   - backfills EVERY business day from the earliest money row (payments / ad spend) to today from the BoC
 *     Valet series FXUSDCAD (one GET), then keeps it current daily — no manual backfill;
 *   - never overwrites a MANUAL rate for the same date (Setup → Currency still wins);
 *   - deletes the `seed` placeholders once BoC rows cover their dates;
 *   - opens ONE warning incident `fx_stale` while the newest rate is more than one business day old, resolved
 *     when it is fresh; a feed error fails the step (conversions keep the last real rate, and the footer names
 *     its date).
 * GET only; no credentials.
 */
import { and, asc, eq, gte, inArray, isNull, min, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, fxRates, payments, adSpend, syncIncidents, syncRuns } from '@/db';
import { addDays, todayInTimezone } from '../day';
import { getTimezone } from '../settings';
import { writeMarker } from '../sync/markers';

export const BOC_SERIES = 'FXUSDCAD';
export const BOC_URL = 'https://www.bankofcanada.ca/valet/observations';

const ValetSchema = z.object({
  observations: z.array(z.object({ d: z.string(), FXUSDCAD: z.object({ v: z.union([z.string(), z.number()]) }).nullish() })).default([]),
});

export interface BocObservation {
  date: string;
  rate: number;
}

/** GET the series for [start, end] (or the most recent `recent` observations). Never throws. */
export async function fetchBocRates(p: { start?: string; end?: string; recent?: number }): Promise<{ rates: BocObservation[]; error?: string }> {
  const q = new URLSearchParams();
  if (p.recent) q.set('recent', String(p.recent));
  if (p.start) q.set('start_date', p.start);
  if (p.end) q.set('end_date', p.end);
  try {
    const res = await fetch(`${BOC_URL}/${BOC_SERIES}/json?${q.toString()}`, { method: 'GET', headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) return { rates: [], error: `Bank of Canada ${res.status}: ${text.slice(0, 200)}` };
    const parsed = ValetSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { rates: [], error: `Bank of Canada response failed validation: ${parsed.error.issues[0]?.message}` };
    const rates = parsed.data.observations
      .map((o) => ({ date: o.d, rate: Number(o.FXUSDCAD?.v) }))
      .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && o.rate > 0.5 && o.rate < 3);
    return { rates };
  } catch (err) {
    return { rates: [], error: `Bank of Canada request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Mon–Fri before `date` (pure). BoC publishes business days only; holidays are not modelled (a warning at worst). */
export function previousBusinessDay(date: string): string {
  let d = addDays(date, -1);
  for (;;) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDays(d, -1);
  }
}

/** Stale = the newest usable rate is older than the previous business day (pure). */
export function isFxStale(latestRateDate: string | null, today: string): boolean {
  return !latestRateDate || latestRateDate < previousBusinessDay(today);
}

export interface FxSyncResult {
  ok: boolean;
  skipped?: string;
  error?: string;
  from: string | null;
  fetched: number;
  written: number;
  keptManual: number;
  seedRemoved: number;
  latest: string | null;
  stale: boolean;
}

/** The earliest date any money row carries — the start of what must be convertible. */
async function earliestMoneyDate(timezone: string): Promise<string | null> {
  const [p] = await db.select({ d: min(payments.paidAt) }).from(payments).where(ne(payments.origin, 'demo'));
  const [s] = await db.select({ d: min(adSpend.date) }).from(adSpend).where(ne(adSpend.origin, 'demo'));
  const candidates = [p?.d ? todayInTimezone(timezone, new Date(p.d)) : null, s?.d ? String(s.d) : null].filter((x): x is string => Boolean(x));
  return candidates.length ? candidates.sort()[0] : null;
}

export async function runFxSync(opts: { trigger: 'cron' | 'manual' | 'cli'; now?: Date } = { trigger: 'cron' }): Promise<FxSyncResult> {
  const now = opts.now ?? new Date();
  const timezone = await getTimezone();
  const today = todayInTimezone(timezone, now);
  const out: FxSyncResult = { ok: true, from: null, fetched: 0, written: 0, keptManual: 0, seedRemoved: 0, latest: null, stale: false };

  const earliest = await earliestMoneyDate(timezone);
  const from = earliest ?? addDays(today, -30);
  out.from = from;

  // Which BoC business days are missing? Fetch only when something is (one request covers the whole range).
  // A day is covered by a BoC row OR a manual rate (a human's rate for that day is final — never re-fetched for).
  const boc = await db.select({ date: fxRates.date }).from(fxRates).where(and(eq(fxRates.fromCcy, 'USD'), eq(fxRates.toCcy, 'CAD'), inArray(fxRates.source, ['boc', 'manual']), gte(fxRates.date, from))).orderBy(asc(fxRates.date));
  const have = new Set(boc.map((r) => String(r.date)));
  const lastBusiness = previousBusinessDay(addDays(today, 1)); // today if a weekday, else the Friday before
  let missing = false;
  for (let d = from; d <= lastBusiness && !missing; d = addDays(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && !have.has(d) && d < today) missing = true; // today's rate may not be published yet
  }

  const [run] = await db.insert(syncRuns).values({ kind: 'fx_boc', trigger: opts.trigger, status: 'running', startedAt: now }).returning({ id: syncRuns.id });
  const finish = async (status: 'succeeded' | 'failed', reason: string) => {
    await db.update(syncRuns).set({ status, finishedAt: new Date(), stats: { fetched: out.fetched, written: out.written, keptManual: out.keptManual, seedRemoved: out.seedRemoved, reason }, error: status === 'failed' ? (out.error ?? reason) : null }).where(eq(syncRuns.id, run.id));
    return out;
  };

  if (missing) {
    const res = await fetchBocRates({ start: from, end: today });
    if (res.error) {
      out.ok = false;
      out.error = res.error;
      await db.insert(syncIncidents).values({ syncRunId: run.id, kind: 'error', severity: 'warning', message: `FX feed: ${res.error}` });
      await refreshStaleIncident(today, run.id);
      return finish('failed', res.error);
    }
    out.fetched = res.rates.length;
    const manual = new Set(
      (await db.select({ date: fxRates.date }).from(fxRates).where(and(eq(fxRates.fromCcy, 'USD'), eq(fxRates.toCcy, 'CAD'), eq(fxRates.source, 'manual')))).map((r) => String(r.date)),
    );
    for (const r of res.rates) {
      if (manual.has(r.date)) {
        out.keptManual += 1; // a human's rate for that date wins
        continue;
      }
      await db
        .insert(fxRates)
        .values({ date: r.date, fromCcy: 'USD', toCcy: 'CAD', rate: r.rate, source: 'boc', updatedAt: now })
        .onConflictDoUpdate({ target: [fxRates.date, fxRates.fromCcy, fxRates.toCcy], set: { rate: r.rate, source: 'boc', updatedAt: now }, setWhere: ne(fxRates.source, 'manual') });
      out.written += 1;
    }
  }

  // Placeholders go once BoC covers their dates (the first BoC row on or before a seed date's month makes it moot).
  const [firstBoc] = await db.select({ d: min(fxRates.date) }).from(fxRates).where(and(eq(fxRates.source, 'boc'), eq(fxRates.fromCcy, 'USD')));
  if (firstBoc?.d) {
    const removed = await db.delete(fxRates).where(and(eq(fxRates.source, 'seed'), gte(fxRates.date, String(firstBoc.d)))).returning({ id: fxRates.id });
    // A seed row dated BEFORE the first BoC row still covers earlier money only if nothing else does — keep it.
    out.seedRemoved = removed.length;
  }

  const [latest] = await db.select({ d: sql<string>`max(${fxRates.date})::text` }).from(fxRates).where(and(eq(fxRates.fromCcy, 'USD'), eq(fxRates.toCcy, 'CAD'), ne(fxRates.source, 'seed')));
  out.latest = latest?.d ?? null;
  out.stale = isFxStale(out.latest, today);
  await refreshStaleIncident(today, run.id);
  if (!missing) out.skipped = `USD→CAD up to date through ${out.latest} (Bank of Canada) — nothing missing since ${from}`;
  await writeMarker({ family: 'fx.rates', runId: run.id, fetched: out.fetched, detail: `USD→CAD through ${out.latest ?? 'none'} · ${out.written} written${out.keptManual ? `, ${out.keptManual} manual kept` : ''}` });
  return finish('succeeded', out.skipped ?? `wrote ${out.written} BoC day(s) from ${from}; kept ${out.keptManual} manual; removed ${out.seedRemoved} placeholder(s); latest ${out.latest}`);
}

/** ONE open `fx_stale` warning while the newest non-seed rate is older than the previous business day. */
async function refreshStaleIncident(today: string, runId: string): Promise<void> {
  const [latest] = await db.select({ d: sql<string>`max(${fxRates.date})::text` }).from(fxRates).where(and(eq(fxRates.fromCcy, 'USD'), eq(fxRates.toCcy, 'CAD'), ne(fxRates.source, 'seed')));
  const latestDate = latest?.d ?? null;
  const [open] = await db.select({ id: syncIncidents.id }).from(syncIncidents).where(and(eq(syncIncidents.kind, 'fx_stale'), isNull(syncIncidents.resolvedAt))).limit(1);
  if (isFxStale(latestDate, today)) {
    const message = latestDate
      ? `USD→CAD rate is stale: newest is ${latestDate} (expected ${previousBusinessDay(today)} or later). Conversions use ${latestDate}'s rate.`
      : 'No USD→CAD rate from the Bank of Canada or a manual entry — conversions use the placeholder.';
    if (open) await db.update(syncIncidents).set({ message }).where(eq(syncIncidents.id, open.id));
    else await db.insert(syncIncidents).values({ syncRunId: runId, kind: 'fx_stale', severity: 'warning', message });
  } else if (open) {
    await db.update(syncIncidents).set({ resolvedAt: new Date() }).where(eq(syncIncidents.id, open.id));
  }
}
