/**
 * The demo tenant carries every known data-quality class (design review 2026-10-03, F), so replays and the
 * acceptance tests exercise real failures. Each class is asserted THROUGH THE ENGINE on the seeded database —
 * never by counting rows — and the engine has no sample-data branches any more (the demo tenant is a tenant).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { seedDemo, demoUnderRecordedWeek } from '@/db/seed-demo';
import { db, contacts, payments, pipelines } from '@/db';
import { getScorecard } from '@/lib/metrics/service';
import { loadMetricsInput } from '@/lib/metrics/load';
import { computeAppliedCaveat, computeMarketing, inReportingCurrency } from '@/lib/metrics';
import { computeMaturity } from '@/lib/metrics/maturity';
import { getSetting, getTimezone, SETTING_KEYS } from '@/lib/settings';
import { todayInTimezone, rangeFromParams, addDays, weekStart } from '@/lib/dates';

describe('the demo tenant carries every data-quality class', () => {
  let today = '';
  let tz = '';
  beforeAll(async () => {
    await runMigrations();
    await seedDemo();
    tz = await getTimezone();
    today = todayInTimezone(tz);
  }, 120_000);

  const sinceStart = () => ({ start: '2026-06-01', end: today });

  it('class C — manual entries into a late stage: counted applications with no form record, named', async () => {
    const r = sinceStart();
    const input = await loadMetricsInput({ ...r, timezone: tz });
    const caveat = computeAppliedCaveat(input, r, 'period');
    const manual = caveat.withoutFormRecord.filter((w) => /pre-existing form contact|not an application form/.test(w.reason));
    expect(manual.length).toBeGreaterThanOrEqual(3);
    expect(caveat.text).toMatch(/have no application form record/);
    // and the rest ARE form applicants — the demo tenant is not all one class
    expect(caveat.withoutFormRecord.length).toBeLessThan(caveat.applied / 2);
  });

  it('class X — form applicants routed to the unfollowed Nurture pipeline, not counted as applied, listed by name', async () => {
    const r = sinceStart();
    const input = await loadMetricsInput({ ...r, timezone: tz });
    const caveat = computeAppliedCaveat(input, r, 'period');
    expect(caveat.otherPipelines.length).toBe(3);
    expect(caveat.otherPipelines.every((o) => o.pipeline === '[demo] Nurture' && !o.alsoInFollowed)).toBe(true);
    expect(caveat.text).toMatch(/3 applicants in other pipelines/);
    const [nurture] = await db.select({ isTracked: pipelines.isTracked }).from(pipelines).where(eq(pipelines.id, 'demo-pipeline-nurture'));
    expect(nurture.isTracked).toBe(false);
  });

  it('missing deal values — LTV:CAC is PARTIAL over the valued clients, the rest named (never withheld, never a silent number)', async () => {
    const r = sinceStart();
    const input = await loadMetricsInput({ ...r, timezone: tz });
    const m = computeMarketing(input, r);
    expect(m.ltvCoverage.partial).toBe(true);
    expect(m.ltvCoverage.missing.length).toBeGreaterThanOrEqual(2);
    expect(m.ltvCoverage.used).toBeGreaterThan(0);
    expect(m.ltvToCac).not.toBeNull();
    expect(m.ltvCoverage.note).toMatch(/^Based on \d+ of \d+ new clients · \d+ missing contract value$/);
  });

  it('attendance under-recorded — the consult show rate is withheld for that week with the coverage line', async () => {
    const week = demoUnderRecordedWeek(today);
    const res = await getScorecard({ range: 'custom', start: week.start, end: week.end, compare: 'off' });
    const consult = res.scorecard.showRates.find((s) => s.type === 'Consult')!;
    expect(consult.coverage).not.toBeNull();
    expect(consult.coverage!).toBeLessThan(0.9);
    expect(consult.rate).toBeNull();
    expect(consult.withheld).toMatch(/attendance recorded for \d+% of consults/);
    // another complete week is fully recorded
    const other = addDays(weekStart(today), -35);
    const ok = await getScorecard({ range: 'custom', start: other, end: addDays(other, 6), compare: 'off' });
    expect(ok.scorecard.showRates.find((s) => s.type === 'Consult')!.rate).not.toBeNull();
  });

  it('CAD + USD payments convert at read time; nothing is dropped as unsupported', async () => {
    const r = sinceStart();
    const input = await loadMetricsInput({ ...r, timezone: tz });
    expect(input.money!.unsupportedRows).toBe(0);
    const currencies = await db.select({ currency: payments.currency, n: sql<number>`count(*)` }).from(payments).where(eq(payments.origin, 'demo')).groupBy(payments.currency);
    expect(currencies.map((c) => c.currency).sort()).toEqual(['CAD', 'USD']);
    expect(new Set(input.payments.map((p) => p.currency)).size).toBe(2); // stored as charged
    const converted = inReportingCurrency(input);
    expect(converted.payments.every((p) => p.currency === input.money!.reporting)).toBe(true); // converted at read time
  });

  it('a full and a partial refund: the full one is excluded as cash, the partial one is initial cash net of the refund', async () => {
    const rows = await db.select({ status: payments.status, amountCents: payments.amountCents, refundedCents: payments.refundedCents, paymentClass: payments.paymentClass, description: payments.description }).from(payments).where(eq(payments.origin, 'demo'));
    const full = rows.find((p) => p.refundedCents === p.amountCents && p.status === 'refunded');
    const partial = rows.find((p) => p.refundedCents > 0 && p.refundedCents < p.amountCents);
    expect(full?.paymentClass).toBe('excluded');
    expect(partial?.paymentClass).toBe('initial');
    const r = sinceStart();
    const input = await loadMetricsInput({ ...r, timezone: tz });
    const m = computeMarketing(input, r);
    expect(m.initialCents).toBeGreaterThan(0);
  });

  it('a failed charge retried and later paid: the failures are excluded (reason: failed), the retry is the initial', async () => {
    const rows = await db.select({ customer: payments.stripeCustomerId, status: payments.status, paymentClass: payments.paymentClass, description: payments.description }).from(payments).where(eq(payments.origin, 'demo'));
    const retried = rows.filter((p) => p.description?.includes('(retried)'));
    expect(retried.length).toBe(2);
    expect(retried.every((p) => p.status === 'failed' && p.paymentClass === 'excluded')).toBe(true);
    const paid = rows.find((p) => p.customer === retried[0].customer && p.status === 'succeeded');
    expect(paid?.paymentClass).toBe('initial');
  });

  it('a maturing week: history is complete from six weeks back, so a range touching earlier weeks is maturing and the disclaimer has not sunset', async () => {
    const since = await getSetting(SETTING_KEYS.historyCompleteSince);
    expect(since).toBe(addDays(weekStart(today), -42));
    const range = rangeFromParams({ start: addDays(weekStart(today), -56), end: addDays(weekStart(today), -50) }, today);
    const maturing = computeMaturity({ range, today, historyCompleteSince: since, sunset: await getSetting(SETTING_KEYS.disclaimerSunset), comparedWith: [] });
    expect(maturing.active).toBe(true);
    const recent = rangeFromParams({ range: 'last_week' }, today);
    expect(computeMaturity({ range: recent, today, historyCompleteSince: since, sunset: await getSetting(SETTING_KEYS.disclaimerSunset), comparedWith: [] }).active).toBe(false);
  });

  it('every demo row is labelled; the engine has no sample-data branch (the demo tenant counts like any tenant)', async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(contacts).where(sql`${contacts.origin} <> 'demo'`);
    expect(Number(n)).toBe(0);
    const r = sinceStart();
    const input = await loadMetricsInput({ ...r, timezone: tz });
    expect(input.contacts.length).toBeGreaterThan(150);
    expect(input.contacts.every((c) => c.appliedOn !== null)).toBe(true); // dated from the opportunity mirror, like a real sync
  });
});
