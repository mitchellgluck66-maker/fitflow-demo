/**
 * 1b — the reporting currency is ONE business-wide setting. Flipping it
 * re-renders every money figure through the same read-time conversion, via
 * the one call path the dashboard, the digests and the AI context share
 * (getScorecard). Stored rows are never rewritten, so a round trip is exact.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, payments, adSpend, fxRates } from '@/db';
import { getScorecard } from '@/lib/metrics/service';
import { assembleScorecard } from '@/lib/scorecard/assemble';
import { buildInsightInput } from '@/lib/metrics/insights';
import { buildAskContext } from '@/lib/metrics/ask';
import { getReportingCurrency, setReportingCurrency, setUsdCadRate, listFxRates } from '@/lib/money/store';
import { GET as getCurrency, POST as postCurrency } from '@/app/api/currency/route';
import { eq } from 'drizzle-orm';

const RANGE = { range: 'custom', start: '2026-08-02', end: '2026-08-08', compare: 'off' };
const prov = { source: 'stripe', origin: 'stripe', syncedAt: new Date(), backfilled: false } as const;
const post = (body: unknown) => postCurrency(new NextRequest('http://localhost/api/currency', { method: 'POST', body: JSON.stringify(body) }));

beforeAll(async () => {
  await runMigrations();
  await db.insert(payments).values([
    { stripeId: 'ch_cad', kind: 'charge', status: 'succeeded', amountCents: 136_000, currency: 'CAD', paidAt: new Date('2026-08-05T18:00:00Z'), paymentClass: 'recurring', ...prov },
    { stripeId: 'ch_usd', kind: 'charge', status: 'succeeded', amountCents: 50_000, currency: 'USD', paidAt: new Date('2026-08-06T18:00:00Z'), paymentClass: 'recurring', ...prov },
  ]);
  await db.insert(adSpend).values({ platform: 'meta', externalId: 'meta:ad1:2026-08-04', level: 'ad', campaignId: 'c1', campaignName: 'VSL', date: '2026-08-04', spendCents: 25_000, currency: 'USD', source: 'meta', origin: 'meta' });
});

describe('the reporting-currency setting', () => {
  it('defaults to CAD, and migration 0008 seeded the 2026 placeholder rates', async () => {
    expect(await getReportingCurrency()).toBe('CAD');
    const seed = (await listFxRates()).filter((r) => r.source === 'seed');
    expect(seed).toHaveLength(12);
    expect(seed.every((r) => r.rate === 1.36)).toBe(true);
  });

  it('CAD: USD rows × 1.36 (the seeded August rate)', async () => {
    const r = await getScorecard(RANGE);
    expect(r.money.currency).toBe('CAD');
    expect(r.money.fx.text).toMatch(/^displayed in CAD · USD converted at /);
    expect(r.revenue).toMatchObject({ currency: 'CAD', recurringCents: 136_000 + 68_000 });
    expect(r.ads.kpis).toMatchObject({ currency: 'CAD', spendCents: 34_000 });
  });

  it('USD: the same stored rows, CAD ÷ 1.36 — and emails + AI context follow the setting', async () => {
    await setReportingCurrency('USD');
    const r = await getScorecard(RANGE);
    expect(r.money.currency).toBe('USD');
    expect(r.revenue).toMatchObject({ currency: 'USD', recurringCents: 100_000 + 50_000 });
    expect(r.ads.kpis).toMatchObject({ currency: 'USD', spendCents: 25_000 });
    const view = assembleScorecard(r, null); // the email renders this model
    expect(view.currency).toBe('USD');
    expect(view.sections.ads.find((s) => s.key === 'spend')!.value).toBe('$250 USD');
    expect(buildInsightInput(r).money.currency).toBe('USD');
    const ask = buildAskContext(r);
    expect(ask.currency).toBe('USD');
    expect(ask.note).toContain('$1,605 USD');
  });

  it('toggling back never double-converts: stored rows are untouched and CAD figures are exact again', async () => {
    await setReportingCurrency('CAD');
    const r = await getScorecard(RANGE);
    expect(r.revenue.recurringCents).toBe(204_000);
    const rows = await db.select({ amountCents: payments.amountCents, currency: payments.currency }).from(payments).where(eq(payments.stripeId, 'ch_usd'));
    expect(rows[0]).toEqual({ amountCents: 50_000, currency: 'USD' });
  });

  it('a manual rate applies from its date forward; past periods keep their own rate', async () => {
    await setUsdCadRate(1.4, '2026-08-06');
    const r = await getScorecard(RANGE);
    // spend on Aug 4 still 1.36; the USD payment on Aug 6 now 1.40
    expect(r.ads.kpis.spendCents).toBe(34_000);
    expect(r.revenue.recurringCents).toBe(136_000 + 70_000);
    await db.delete(fxRates).where(eq(fxRates.date, '2026-08-06'));
  });
});

describe('/api/currency', () => {
  it('GET reports the active note; POST validates and flips the business-wide value', async () => {
    const g = await (await getCurrency()).json();
    expect(g.reporting).toBe('CAD');
    expect(g.note).toMatch(/^displayed in CAD · USD converted at /);
    expect((await post({ reportingCurrency: 'EUR' })).status).toBe(400);
    expect((await post({ usdCadRate: 13.6 })).status).toBe(400);
    const flipped = await (await post({ reportingCurrency: 'USD' })).json();
    expect(flipped.reporting).toBe('USD');
    expect(flipped.note).toMatch(/^displayed in USD · CAD converted at /);
    await post({ reportingCurrency: 'CAD' });
  });
});
