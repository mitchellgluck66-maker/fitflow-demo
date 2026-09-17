/**
 * Phase G item 3 — marketing economics, hand-computed.
 * Range R = Sun 2026-08-02 … Sat 2026-08-08. Spend in R = $1,000 (100,000¢).
 */
import { describe, it, expect } from 'vitest';
import { computeMarketing, computeAdsKpis, computeScorecard, type MetricsInput, type ContactRow, type PaymentRow } from '@/lib/metrics';

const R = { start: '2026-08-02', end: '2026-08-08' };
const P = { start: '2026-07-26', end: '2026-08-01' };
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);

const c = (id: string, attribution: 'paid' | 'organic' | null, valueCents: number, appliedOn = '2026-08-03'): ContactRow => ({
  id,
  name: id.toUpperCase(),
  email: `${id}@example.com`,
  source: attribution === 'paid' ? 'Facebook' : 'Referral',
  stageId: 'st-enrolled',
  stageName: 'Enrolled',
  role: 'enrolled',
  appliedOn,
  monetaryValueCents: valueCents,
  origin: 'ghl',
  attribution,
});
const enrolled = (contactId: string, on = '2026-08-05') => ({ contactId, fromRole: 'roadmap_showed' as const, toRole: 'enrolled' as const, toStageId: 'st-enrolled', on, atMs: noon(on) });
const roadmap = (contactId: string, on = '2026-08-04') => ({ contactId, fromRole: 'consult_booked' as const, toRole: 'roadmap_booked' as const, toStageId: 'st-rm', on, atMs: noon(on) });
const pay = (id: string, contactId: string | null, cents: number, cls: 'initial' | 'recurring' | null = 'initial', over: Partial<PaymentRow> = {}): PaymentRow => ({
  id,
  stripeId: id,
  contactId,
  kind: 'charge',
  amountCents: cents,
  refundedCents: 0,
  status: 'succeeded',
  on: '2026-08-06',
  origin: 'stripe',
  paymentClass: cls,
  ...over,
});

const BASE: MetricsInput = {
  contacts: [
    c('pa', 'paid', 600_000), // paid, $6,000 contract
    c('pb', 'paid', 400_000), // paid, $4,000 contract
    c('og', 'organic', 500_000), // organic, $5,000 contract
  ],
  transitions: [enrolled('pa'), enrolled('pb'), enrolled('og'), roadmap('pa'), roadmap('pb'), roadmap('og'), roadmap('x1')],
  appointments: [],
  spend: [{ date: '2026-08-02', platform: 'meta', spendCents: 100_000, origin: 'manual' }],
  payments: [
    pay('p-pa', 'pa', 300_000), // paid initial
    pay('p-pb', 'pb', 200_000, 'initial', { refundedCents: 50_000 }), // paid initial, net 150,000
    pay('p-og', 'og', 250_000), // organic initial — excluded from ROAS
    pay('p-pa-2', 'pa', 19_900, 'recurring', { kind: 'invoice' }), // recurring — never in ROAS
    pay('p-old', 'pa', 999_999, 'initial', { on: '2026-07-01' }), // out of range
  ],
};

describe('computeMarketing', () => {
  const m = computeMarketing(BASE, R);

  it('Paid CAC counts only paid-attributed enrollments; Blended CAC counts everyone', () => {
    expect(m.enrollments).toBe(3);
    expect(m.paidEnrollments).toBe(2);
    expect(m.organicEnrollments).toBe(1);
    expect(m.unattributedEnrollments).toBe(0);
    expect(m.paidCacCents).toBe(50_000); // 100,000 ÷ 2
    expect(m.blendedCacCents).toBe(Math.round(100_000 / 3));
  });

  it('ROAS = paid-attributed initial cash ÷ spend; organic and recurring never leak in', () => {
    expect(m.paidInitialCents).toBe(450_000); // 300,000 + (200,000 − 50,000)
    expect(m.organicInitialCents).toBe(250_000);
    expect(m.initialCents).toBe(700_000);
    expect(m.unattributedInitialCents).toBe(0);
    expect(m.roas).toBeCloseTo(4.5);
  });

  it('cost per roadmap booked = spend ÷ roadmap_booked reached in range', () => {
    expect(m.costPerRoadmapCents).toBe(25_000); // 4 roadmaps booked incl. x1
  });

  it('LTV:CAC = total contract value ÷ spend (= avg contract ÷ blended CAC) when every new client has a value', () => {
    expect(m.contractValueCents).toBe(1_500_000);
    expect(m.contractValueMissing).toEqual([]);
    expect(m.ltvToCac).toBeCloseTo(15); // 1,500,000 ÷ 100,000; avg 500,000 ÷ blended 33,333 ≈ 15
  });

  it('LTV:CAC is withheld and the missing clients listed when any new client has no contract value', () => {
    const input: MetricsInput = { ...BASE, contacts: [c('pa', 'paid', 600_000), c('pb', 'paid', 0), c('og', 'organic', 500_000)] };
    const mm = computeMarketing(input, R);
    expect(mm.ltvToCac).toBeNull();
    expect(mm.contractValueMissing).toEqual([{ contactId: 'pb', name: 'PB' }]);
    expect(mm.contractValueCents).toBe(1_100_000); // still reported for the warning text
  });

  it('unclassified contacts and unmatched initial cash are surfaced as data-health, excluded from paid math', () => {
    const input: MetricsInput = {
      ...BASE,
      contacts: [...BASE.contacts, c('nx', null, 100_000)],
      transitions: [...BASE.transitions, enrolled('nx')],
      payments: [...BASE.payments, pay('p-nx', 'nx', 100_000), pay('p-unmatched', null, 80_000)],
    };
    const mm = computeMarketing(input, R);
    expect(mm.enrollments).toBe(4);
    expect(mm.paidEnrollments).toBe(2); // nx does not become paid
    expect(mm.unattributedEnrollments).toBe(1);
    expect(mm.paidCacCents).toBe(50_000);
    expect(mm.blendedCacCents).toBe(25_000);
    expect(mm.paidInitialCents).toBe(450_000); // unchanged
    expect(mm.unattributedInitialCents).toBe(180_000);
    expect(mm.unattributedInitialCount).toBe(2);
    expect(mm.roas).toBeCloseTo(4.5);
  });

  it('nulls, not zeros, when spend / enrollments / Stripe are missing', () => {
    const noSpend = computeMarketing({ ...BASE, spend: [] }, R);
    expect(noSpend).toMatchObject({ noSpendData: true, paidCacCents: null, blendedCacCents: null, roas: null, ltvToCac: null, costPerRoadmapCents: null });

    const noStripe = computeMarketing({ ...BASE, payments: [] }, R);
    expect(noStripe).toMatchObject({ awaitingStripe: true, roas: null, paidInitialCents: 0 });
    expect(noStripe.paidCacCents).toBe(50_000); // CAC does not need Stripe

    const nobody = computeMarketing(BASE, P);
    expect(nobody).toMatchObject({ enrollments: 0, paidCacCents: null, blendedCacCents: null, ltvToCac: null });
  });

  it('a paid client whose only in-range cash is recurring contributes to Paid CAC but not ROAS', () => {
    const input: MetricsInput = { ...BASE, payments: [pay('r', 'pa', 50_000, 'recurring', { kind: 'invoice' })] };
    const mm = computeMarketing(input, R);
    expect(mm.paidEnrollments).toBe(2);
    expect(mm.paidInitialCents).toBe(0);
    expect(mm.roas).toBe(0);
  });
});

describe('scorecard + ads KPIs carry the new metrics', () => {
  it('scorecard KPI deltas: paid/blended CAC invert, ROAS and LTV:CAC do not', () => {
    const s = computeScorecard(BASE, R, P, null);
    expect(s.marketing.paidCacCents).toBe(50_000);
    expect(s.kpis.paidCacCents).toMatchObject({ current: 50_000, previous: null, direction: 'none' });
    expect(s.kpis.blendedCacCents.current).toBe(33_333);
    expect(s.kpis.roas.current).toBeCloseTo(4.5);
    expect(s.kpis.ltvToCac.current).toBeCloseTo(15);
    expect(s.kpis.costPerRoadmapCents.current).toBe(25_000);
    expect(s.kpis.roadmapsBooked.current).toBe(4);
    expect(s.cac.cacCents).toBe(s.marketing.blendedCacCents);
  });

  it('ads KPIs expose cost per roadmap alongside lead / consult / client, and the paid ROAS', () => {
    const k = computeAdsKpis(BASE, R);
    expect(k.costPerRoadmapCents).toBe(25_000);
    expect(k.paidCacCents).toBe(50_000);
    expect(k.blendedCacCents).toBe(33_333);
    expect(k.cacCents).toBe(33_333);
    expect(k.roas).toBeCloseTo(4.5);
  });
});
