/**
 * Bank of Canada USD→CAD feed (2026-09-30): the fx step backfills every missing business day since the earliest
 * money row, keeps a manual rate, removes the seed placeholders it covers, names the rate + date in the footer,
 * and a stale rate (> 1 business day) is a warning incident.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, fxRates, payments, adSpend, syncIncidents } from '@/db';
import { runFxSync, previousBusinessDay, isFxStale } from '@/lib/fx/boc';
import { setUsdCadRate, loadMoneyContext } from '@/lib/money/store';
import { fxNote } from '@/lib/money';

/** Valet's shape; the fake serves business days in [start_date, end_date] with a rate derived from the day. */
let calls = 0;
let down = false;
const rateOf = (d: string) => Math.round((1.38 + Number(d.slice(8, 10)) / 1000) * 10_000) / 10_000;
const fakeFetch = vi.fn(async (input: string | URL) => {
  calls += 1;
  const url = new URL(String(input));
  if (down) return new Response('Service Unavailable', { status: 503 });
  const start = url.searchParams.get('start_date')!;
  const end = url.searchParams.get('end_date')!;
  const observations: Array<{ d: string; FXUSDCAD: { v: string } }> = [];
  for (let d = new Date(`${start}T12:00:00Z`); d <= new Date(`${end}T12:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    const day = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && day <= publishedThrough) observations.push({ d: day, FXUSDCAD: { v: rateOf(day).toFixed(4) } });
  }
  return new Response(JSON.stringify({ seriesDetail: {}, observations }), { status: 200, headers: { 'content-type': 'application/json' } });
});
let publishedThrough = '2026-09-29';

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations(); // migration 0008 seeded 12 monthly placeholders at 1.36
  await db.insert(payments).values({ stripeId: 'ch_1', kind: 'charge', status: 'succeeded', amountCents: 100, currency: 'USD', paidAt: new Date('2026-09-01T18:00:00Z'), source: 'stripe', origin: 'stripe' });
  await db.insert(adSpend).values({ platform: 'meta', externalId: 'meta:a:2026-08-25', date: '2026-08-25', spendCents: 100, currency: 'CAD', source: 'meta', origin: 'meta' });
  await setUsdCadRate(1.5, '2026-09-15'); // a human's rate for one day
});
afterAll(() => vi.unstubAllGlobals());

describe('business days (pure)', () => {
  it('previous business day skips weekends; stale = newest rate older than it', () => {
    expect(previousBusinessDay('2026-09-30')).toBe('2026-09-29'); // Wed → Tue
    expect(previousBusinessDay('2026-10-05')).toBe('2026-10-02'); // Mon → Fri
    expect(isFxStale('2026-10-02', '2026-10-05')).toBe(false);
    expect(isFxStale('2026-10-01', '2026-10-05')).toBe(true);
    expect(isFxStale(null, '2026-10-05')).toBe(true);
  });
});

describe('runFxSync', () => {
  it('backfills every business day from the earliest money row, keeps the manual rate, removes the placeholders it covers', async () => {
    const r = await runFxSync({ trigger: 'cron', now: new Date('2026-09-30T18:00:00Z') });
    expect(r).toMatchObject({ ok: true, from: '2026-08-25', keptManual: 1, latest: '2026-09-29', stale: false });
    expect(r.written).toBe(25); // 26 business days Aug 25 – Sep 29, minus the manual Sep 15
    const [manual] = await db.select().from(fxRates).where(eq(fxRates.date, '2026-09-15'));
    expect(manual).toMatchObject({ rate: 1.5, source: 'manual' });
    const seeds = (await db.select().from(fxRates).where(eq(fxRates.source, 'seed'))).map((x) => String(x.date)).sort();
    expect(seeds).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01']);
    // Sep 1 was a business day: its seed row was overwritten by the BoC rate (upsert); Oct–Dec are deleted.
    expect(r.seedRemoved).toBe(3);
    expect((await db.select().from(fxRates).where(eq(fxRates.date, '2026-09-01')))[0]).toMatchObject({ source: 'boc', rate: rateOf('2026-09-01') });
    const note = fxNote(await loadMoneyContext(), '2026-09-30');
    expect(note.text).toBe(`displayed in CAD · USD converted at ${rateOf('2026-09-29')} (Bank of Canada, Sep 29)`);
  });

  it('a second run with nothing missing fetches nothing and says so', async () => {
    const before = calls;
    const r = await runFxSync({ trigger: 'cron', now: new Date('2026-09-30T19:00:00Z') });
    expect(calls).toBe(before);
    expect(r.skipped).toBe('USD→CAD up to date through 2026-09-29 (Bank of Canada) — nothing missing since 2026-08-25');
  });

  it('feed down + rate older than one business day → the step FAILS and ONE fx_stale warning opens; recovery resolves it', async () => {
    down = true;
    const r = await runFxSync({ trigger: 'cron', now: new Date('2026-10-05T18:00:00Z') }); // Mon; newest Sep 29
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Bank of Canada 503/);
    const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'fx_stale'), isNull(syncIncidents.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: 'warning', message: "USD→CAD rate is stale: newest is 2026-09-29 (expected 2026-10-02 or later). Conversions use 2026-09-29's rate." });
    down = false;
    publishedThrough = '2026-10-02';
    const ok = await runFxSync({ trigger: 'cron', now: new Date('2026-10-05T19:00:00Z') });
    expect(ok).toMatchObject({ ok: true, latest: '2026-10-02', stale: false });
    expect(await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'fx_stale'), isNull(syncIncidents.resolvedAt)))).toHaveLength(0);
  });
});
