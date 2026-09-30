/**
 * C1 — currency correctness (2026-09-29 audit). Hand-computed, mixed-currency.
 *
 * Rates (USD→CAD, effective from their date): Aug 1 = 1.36, Sep 1 = 1.40.
 * CAD→USD is never stored — it is the inverse (1 / 1.36).
 *
 * Range R = Sun 2026-08-02 … Sat 2026-08-08. Three enrolled clients, all CAD
 * contract values; Meta spend in USD; payments in both currencies.
 */
import { describe, it, expect } from 'vitest';
import {
  computeMarketing,
  computeRevenue,
  computeRevenueSummary,
  computeScorecard,
  computeSpend,
  computeAdsKpis,
  inReportingCurrency,
  type ContactRow,
  type MetricsInput,
  type PaymentRow,
} from '@/lib/metrics';
import {
  CentsTally,
  CurrencyMismatchError,
  FxRateMissingError,
  convertCents,
  formatMoney,
  fxNote,
  rateFor,
  sumCents,
  FX_SEED_2026,
  type FxRate,
  type MoneyContext,
} from '@/lib/money';
import { assembleScorecard } from '@/lib/scorecard/assemble';
import { computeMaturity } from '@/lib/metrics/maturity';
import type { ScorecardResult } from '@/lib/metrics/service';

const R = { start: '2026-08-02', end: '2026-08-08' };
const SEPT = { start: '2026-09-01', end: '2026-09-30' };
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);

const RATES: FxRate[] = [
  { date: '2026-08-01', from: 'USD', to: 'CAD', rate: 1.36 },
  { date: '2026-09-01', from: 'USD', to: 'CAD', rate: 1.4 },
];
const CAD: MoneyContext = { reporting: 'CAD', rates: RATES, contractCurrency: 'CAD' };
const USD: MoneyContext = { reporting: 'USD', rates: RATES, contractCurrency: 'CAD' };

const c = (id: string, attribution: 'paid' | 'organic', valueCents: number): ContactRow => ({
  id,
  name: id.toUpperCase(),
  email: `${id}@example.com`,
  source: attribution === 'paid' ? 'Facebook' : 'Referral',
  stageId: 'st-enrolled',
  stageName: 'Enrolled',
  role: 'enrolled',
  appliedOn: '2026-08-03',
  monetaryValueCents: valueCents,
  origin: 'ghl',
  attribution,
});
const pay = (id: string, contactId: string, cents: number, currency: 'CAD' | 'USD', cls: 'initial' | 'recurring', over: Partial<PaymentRow> = {}): PaymentRow => ({
  id,
  stripeId: id,
  contactId,
  kind: 'charge',
  amountCents: cents,
  refundedCents: 0,
  currency,
  status: 'succeeded',
  on: '2026-08-06',
  origin: 'stripe',
  paymentClass: cls,
  ...over,
});
const t = (contactId: string, toRole: 'enrolled' | 'roadmap_booked', on: string) => ({ contactId, fromRole: null, toRole, toStageId: `st-${toRole}`, on, atMs: noon(on) });

const RAW: Omit<MetricsInput, 'money'> = {
  contacts: [c('pa', 'paid', 600_000), c('pb', 'paid', 400_000), c('og', 'organic', 500_000)],
  transitions: [t('pa', 'enrolled', '2026-08-05'), t('pb', 'enrolled', '2026-08-05'), t('og', 'enrolled', '2026-08-05'), t('pa', 'roadmap_booked', '2026-08-04'), t('pb', 'roadmap_booked', '2026-08-04')],
  appointments: [],
  spend: [
    { date: '2026-08-03', platform: 'meta', spendCents: 50_000, currency: 'USD', origin: 'meta', campaignId: 'c1', campaignName: 'VSL' },
    { date: '2026-08-04', platform: 'meta', spendCents: 50_000, currency: 'USD', origin: 'meta', campaignId: 'c1', campaignName: 'VSL' },
  ],
  payments: [
    pay('p-pa', 'pa', 300_000, 'CAD', 'initial'), // CAD initial, paid contact
    pay('p-pb', 'pb', 200_000, 'USD', 'initial', { refundedCents: 50_000 }), // USD initial, partially refunded
    pay('p-og', 'og', 100_000, 'USD', 'initial'), // USD initial, organic contact — never in ROAS
    pay('p-rec', 'pa', 19_900, 'USD', 'recurring', { kind: 'invoice' }), // USD recurring
    pay('p-sep', 'pa', 100_000, 'USD', 'recurring', { on: '2026-09-02' }), // converts at the SEPTEMBER rate
  ],
};
const inCad: MetricsInput = { ...RAW, money: CAD };
const inUsd: MetricsInput = { ...RAW, money: USD };

describe('lib/money: rates, conversion, the tally guard', () => {
  it('uses the rate effective on the transaction date, the inverse for CAD→USD, identity for same currency', () => {
    expect(rateFor(RATES, 'USD', 'CAD', '2026-08-31')).toBe(1.36);
    expect(rateFor(RATES, 'USD', 'CAD', '2026-09-01')).toBe(1.4);
    expect(rateFor(RATES, 'CAD', 'USD', '2026-08-15')).toBeCloseTo(1 / 1.36, 12);
    expect(rateFor(RATES, 'CAD', 'CAD', '2026-08-15')).toBe(1);
    // Before the first stored row: the earliest row applies (never a silent 1:1).
    expect(rateFor(RATES, 'USD', 'CAD', '2026-01-15')).toBe(1.36);
    expect(convertCents(10_000, 'USD', 'CAD', '2026-08-15', RATES)).toBe(13_600);
    expect(convertCents(13_600, 'CAD', 'USD', '2026-08-15', RATES)).toBe(10_000);
  });

  it('refuses to guess: no rate for the pair throws', () => {
    expect(() => rateFor([], 'USD', 'CAD', '2026-08-15')).toThrow(FxRateMissingError);
  });

  it('CentsTally / sumCents refuse to add an amount in another currency', () => {
    const tally = new CentsTally('CAD').add(100, 'CAD');
    expect(() => tally.add(100, 'USD')).toThrow(CurrencyMismatchError);
    expect(sumCents([{ cents: 1, currency: 'USD' }, { cents: 2, currency: 'USD' }], 'USD')).toBe(3);
    expect(() => sumCents([{ cents: 1, currency: 'USD' }, { cents: 2, currency: 'CAD' }], 'USD')).toThrow(CurrencyMismatchError);
  });

  it('the seed is 12 flat, clearly-marked placeholder months for 2026', () => {
    expect(FX_SEED_2026).toHaveLength(12);
    expect(FX_SEED_2026.every((r) => r.rate === 1.36 && r.source === 'seed' && r.from === 'USD' && r.to === 'CAD')).toBe(true);
  });

  it('formats every amount with its code, and names the active rate', () => {
    expect(formatMoney(160_500, 'CAD')).toBe('$1,605 CAD');
    expect(formatMoney(160_550, 'USD')).toBe('$1,605.50 USD');
    expect(fxNote(CAD, '2026-08-15').text).toBe('displayed in CAD · USD converted at 1.36 (Aug 1)');
    expect(fxNote(USD, '2026-08-15').text).toBe('displayed in USD · CAD converted at 0.7353 (Aug 1)');
    expect(fxNote({ ...CAD, rates: [] }, '2026-08-15').text).toBe('displayed in CAD · no USD rate stored');
  });
});

describe('the engine in CAD (the default reporting currency)', () => {
  it('spend: Meta USD × 1.36', () => {
    expect(computeSpend(inCad.spend, R, CAD)).toBe(136_000); // 100,000 USD¢ × 1.36
    expect(computeAdsKpis(inCad, R)).toMatchObject({ currency: 'CAD', spendCents: 136_000 });
  });

  it('revenue: CAD kept, USD converted per row, refunds converted with their charge', () => {
    const r = computeRevenue(inCad, R);
    expect(r.currency).toBe('CAD');
    // 300,000 + (272,000 − 68,000) + 136,000
    expect(r.initialCents).toBe(640_000);
    expect(r.recurringCents).toBe(27_064); // 19,900 × 1.36
    expect(r.collectedCents).toBe(667_064);
    expect(r.refundedCents).toBe(68_000); // 50,000 × 1.36
  });

  it('ROAS, Paid CAC, Blended CAC, cost per roadmap and LTV:CAC — exact CAD figures', () => {
    const m = computeMarketing(inCad, R);
    expect(m.currency).toBe('CAD');
    expect(m.spendCents).toBe(136_000);
    expect(m.paidInitialCents).toBe(504_000); // pa 300,000 + pb 204,000; og organic excluded
    expect(m.organicInitialCents).toBe(136_000);
    expect(m.roas).toBeCloseTo(504_000 / 136_000, 10); // 3.7059
    expect(m.paidCacCents).toBe(68_000); // 136,000 ÷ 2
    expect(m.blendedCacCents).toBe(45_333); // 136,000 ÷ 3
    expect(m.costPerRoadmapCents).toBe(68_000); // 136,000 ÷ 2 roadmaps
    expect(m.contractValueCents).toBe(1_500_000); // CAD contracts, no conversion
    expect(m.ltvToCac).toBeCloseTo(1_500_000 / 136_000, 10); // 11.03
  });

  it('each payment converts at ITS date: the September USD charge uses 1.40', () => {
    expect(computeRevenue(inCad, SEPT).recurringCents).toBe(140_000);
  });

  it('payment rows carry original currency + converted value', () => {
    const s = computeRevenueSummary(inCad, R);
    const pb = s.payments.find((p) => p.id === 'p-pb')!;
    expect(pb).toMatchObject({ currency: 'CAD', amountCents: 272_000, refundedCents: 68_000, originalCurrency: 'USD', originalAmountCents: 200_000, originalRefundedCents: 50_000, fxRate: 1.36 });
    const pa = s.payments.find((p) => p.id === 'p-pa')!;
    expect(pa).toMatchObject({ currency: 'CAD', amountCents: 300_000, originalCurrency: 'CAD', originalAmountCents: 300_000, fxRate: 1 });
  });
});

describe('the same fixture in USD (the toggle)', () => {
  it('USD rows are untouched; CAD rows divide by 1.36; contract values convert too', () => {
    const m = computeMarketing(inUsd, R);
    expect(m.currency).toBe('USD');
    expect(m.spendCents).toBe(100_000);
    // pa 300,000 CAD ÷ 1.36 = 220,588.2 → 220,588; pb 150,000 USD
    expect(m.paidInitialCents).toBe(370_588);
    expect(m.organicInitialCents).toBe(100_000);
    expect(m.roas).toBeCloseTo(3.70588, 10);
    expect(m.paidCacCents).toBe(50_000);
    expect(m.blendedCacCents).toBe(33_333);
    // 600,000 → 441,176 · 400,000 → 294,118 · 500,000 → 367,647 (each ÷ 1.36, rounded)
    expect(m.contractValueCents).toBe(1_102_941);
    expect(m.ltvToCac).toBeCloseTo(11.02941, 10);
    const r = computeRevenue(inUsd, R);
    expect(r).toMatchObject({ currency: 'USD', initialCents: 470_588, recurringCents: 19_900, refundedCents: 50_000 });
  });

  it('ROAS barely moves between modes (it is a ratio of converted amounts, not a double conversion)', () => {
    expect(computeMarketing(inCad, R).roas! - computeMarketing(inUsd, R).roas!).toBeLessThan(0.0001);
  });
});

describe('never double-converts', () => {
  it('re-running the engine on an already-converted input changes nothing', () => {
    const once = inReportingCurrency(inCad);
    // A fresh object (so the per-input cache cannot help) built from converted rows:
    const again: MetricsInput = { ...once, contacts: [...once.contacts], spend: [...once.spend], payments: [...once.payments] };
    expect(computeMarketing(again, R)).toEqual(computeMarketing(inCad, R));
    expect(computeRevenue(again, R)).toEqual(computeRevenue(inCad, R));
  });

  it('toggling CAD → USD → CAD from the stored originals returns the exact CAD figures', () => {
    const before = computeMarketing(inCad, R);
    computeMarketing(inUsd, R);
    const after = computeMarketing({ ...RAW, money: CAD }, R);
    expect(after).toEqual(before);
  });

  it('a converted row is labelled with the reporting currency and keeps its original', () => {
    const p = inReportingCurrency(inCad).payments.find((x) => x.id === 'p-pb')!;
    expect(p).toMatchObject({ currency: 'CAD', amountCents: 272_000, original: { amountCents: 200_000, currency: 'USD', rate: 1.36 } });
  });

  it('the engine refuses to sum USD without a rate rather than treating it as CAD', () => {
    expect(() => computeRevenue({ ...RAW, money: { ...CAD, rates: [] } }, R)).toThrow(FxRateMissingError);
  });
});

describe('scorecard assembly labels every money value with the active currency', () => {
  const fake = (money: MoneyContext): ScorecardResult => {
    const input: MetricsInput = { ...RAW, money };
    const scorecard = computeScorecard(input, R, null, null);
    return {
      timezone: 'America/Edmonton',
      today: '2026-08-10',
      range: { ...R, preset: 'last_week', presetLabel: 'Last week', resolvedLabel: 'Aug 2–8' },
      comparison: { mode: 'off', range: null, label: 'No comparison' },
      baseline: { start: '2026-06-07', end: '2026-08-01' },
      scorecard,
      trend: { grain: 'day', current: [], comparison: null },
      trendWeekly: { current: [], comparison: null },
      trendWeeklyCohort: { current: [], comparison: null },
      trailingWeeks: [],
      ads: { kpis: computeAdsKpis(input, R), previousKpis: null, campaigns: [], previousCampaigns: null },
      revenue: computeRevenueSummary(input, R),
      maturity: computeMaturity({ range: R, today: '2026-08-10', historyCompleteSince: '2026-09-01', sunset: '2026-10-15' }),
      money: { currency: money.reporting, fx: fxNote(money, '2026-08-10'), unsupportedRows: 0 },
    } as ScorecardResult;
  };

  it('CAD mode', () => {
    const v = assembleScorecard(fake(CAD), null);
    expect(v.currency).toBe('CAD');
    expect(v.sections.money.find((s) => s.key === 'initial_cash')!.value).toBe('$6,400 CAD');
    expect(v.sections.money.find((s) => s.key === 'paid_cac')!.value).toBe('$680 CAD');
    expect(v.sections.ads.find((s) => s.key === 'spend')!.value).toBe('$1,360 CAD');
    expect(v.notes.map((n) => n.text)).toContain('Money displayed in CAD · USD converted at 1.36 (Aug 1).');
  });

  it('USD mode — same fixture, no CAD value leaks through', () => {
    const v = assembleScorecard(fake(USD), null);
    expect(v.currency).toBe('USD');
    expect(v.sections.money.find((s) => s.key === 'initial_cash')!.value).toBe('$4,705.88 USD');
    expect(v.sections.money.find((s) => s.key === 'paid_cac')!.value).toBe('$500 USD');
    expect(v.sections.ads.find((s) => s.key === 'spend')!.value).toBe('$1,000 USD');
    expect(v.notes.map((n) => n.text)).toContain('Money displayed in USD · CAD converted at 0.7353 (Aug 1).');
    const everyMoney = [...v.sections.money, ...v.sections.ads].filter((s) => s.deltaKind === 'cents' && s.value !== '—');
    expect(everyMoney.every((s) => s.value.endsWith(' USD'))).toBe(true);
  });
});
