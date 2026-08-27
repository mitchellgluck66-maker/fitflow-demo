/**
 * Phase C fixture tests: spend precedence, campaign aggregation, revenue
 * summary and payment matching. Hand-computed expectations.
 */
import { describe, it, expect } from 'vitest';
import {
  expandSpend,
  computeSpend,
  computeAdsKpis,
  computeCampaignTable,
  computeRevenueSummary,
  matchPayments,
  type MetricsInput,
  type SpendRow,
} from '@/lib/metrics';

const R = { start: '2026-08-02', end: '2026-08-08' }; // Sun–Sat

const manualMeta: SpendRow = { date: '2026-08-02', platform: 'meta', spendCents: 70_010, origin: 'manual' };
const manualGoogle: SpendRow = { date: '2026-08-02', platform: 'google', spendCents: 7_000, origin: 'manual' };

describe('spend precedence (manual weekly fallback vs API daily rows)', () => {
  it('spreads a manual week over 7 days with the remainder on Sunday', () => {
    const days = expandSpend([manualMeta]);
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.spendCents)).toEqual([10_004, 10_001, 10_001, 10_001, 10_001, 10_001, 10_001]);
    expect(days[0].date).toBe('2026-08-02');
    expect(days[6].date).toBe('2026-08-08');
    expect(days.every((d) => d.from === 'manual')).toBe(true);
    expect(computeSpend([manualMeta], R)).toBe(70_010);
  });

  it('API rows replace manual for their platform + date, manual stays for uncovered dates', () => {
    const spend: SpendRow[] = [
      manualMeta,
      manualGoogle,
      { date: '2026-08-03', platform: 'meta', spendCents: 50_000, origin: 'meta', campaignId: 'c1', campaignName: 'Summer Shred' },
      { date: '2026-08-04', platform: 'meta', spendCents: 60_000, origin: 'meta', campaignId: 'c1', campaignName: 'Summer Shred' },
    ];
    const days = expandSpend(spend).filter((d) => d.platform === 'meta').sort((a, b) => a.date.localeCompare(b.date));
    expect(days.map((d) => [d.date, d.from, d.spendCents])).toEqual([
      ['2026-08-02', 'manual', 10_004],
      ['2026-08-03', 'api', 50_000],
      ['2026-08-04', 'api', 60_000],
      ['2026-08-05', 'manual', 10_001],
      ['2026-08-06', 'manual', 10_001],
      ['2026-08-07', 'manual', 10_001],
      ['2026-08-08', 'manual', 10_001],
    ]);
    // meta 110,000 + 5 manual days (10,004 + 4 × 10,001 = 50,008) + google 7,000
    expect(computeSpend(spend, R)).toBe(167_008);
  });

  it('two API rows on the same date (two campaigns) both count and both suppress manual', () => {
    const spend: SpendRow[] = [
      manualMeta,
      { date: '2026-08-03', platform: 'meta', spendCents: 1_000, origin: 'meta', campaignId: 'a', campaignName: 'A' },
      { date: '2026-08-03', platform: 'meta', spendCents: 2_000, origin: 'meta', campaignId: 'b', campaignName: 'B' },
    ];
    expect(computeSpend(spend, R)).toBe(3_000 + 70_010 - 10_001);
  });

  it('API rows for one platform never suppress manual rows for another', () => {
    const spend: SpendRow[] = [manualGoogle, { date: '2026-08-03', platform: 'meta', spendCents: 1_000, origin: 'meta' }];
    expect(computeSpend(spend, R)).toBe(8_000);
  });

  it('a full week of API rows makes the manual row contribute nothing', () => {
    const api: SpendRow[] = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-08-0${2 + i}`,
      platform: 'meta',
      spendCents: 1_000,
      origin: 'meta',
    }));
    expect(computeSpend([manualMeta, ...api], R)).toBe(7_000);
  });

  it('range edges: only in-range days count, across a manual week that straddles the range', () => {
    // Manual week Aug 2–8, range Aug 6–10 → only Aug 6,7,8 of the manual week
    expect(computeSpend([manualMeta], { start: '2026-08-06', end: '2026-08-10' })).toBe(30_003);
  });

  it('demo rows behave like manual rows', () => {
    const spend: SpendRow[] = [{ ...manualMeta, origin: 'demo' }, { date: '2026-08-03', platform: 'meta', spendCents: 500, origin: 'meta' }];
    expect(computeSpend(spend, R)).toBe(500 + 70_010 - 10_001);
  });
});

const c = (id: string, source: string, appliedOn: string, role: string, campaign: string | null) => ({
  id,
  name: id.toUpperCase(),
  email: `${id}@example.com`,
  source,
  stageId: null,
  stageName: null,
  role: role as never,
  appliedOn,
  monetaryValueCents: 0,
  origin: 'ghl',
  campaign,
});
const t = (contactId: string, toRole: string, on: string) => ({
  contactId,
  fromRole: null,
  toRole: toRole as never,
  toStageId: null,
  on,
  atMs: Date.parse(`${on}T12:00:00Z`),
});

const ADS: MetricsInput = {
  contacts: [
    c('p1', 'Facebook', '2026-08-03', 'enrolled', 'Summer Shred'),
    c('p2', 'Facebook', '2026-08-04', 'consult_booked', 'summer-shred'), // normalises to the same campaign
    c('p3', 'Facebook', '2026-08-05', 'applied', 'Retarget'),
    c('p4', 'Referral', '2026-08-05', 'applied', null),
  ],
  transitions: [t('p1', 'consult_booked', '2026-08-04'), t('p1', 'enrolled', '2026-08-07'), t('p2', 'consult_booked', '2026-08-05')],
  appointments: [],
  spend: [
    manualGoogle,
    { date: '2026-08-03', platform: 'meta', spendCents: 30_000, origin: 'meta', campaignId: 'c1', campaignName: 'Summer Shred', impressions: 1000, clicks: 50, leads: 3 },
    { date: '2026-08-04', platform: 'meta', spendCents: 30_000, origin: 'meta', campaignId: 'c1', campaignName: 'Summer Shred', impressions: 1200, clicks: 40, leads: 1 },
    { date: '2026-08-04', platform: 'meta', spendCents: 10_000, origin: 'meta', campaignId: 'c2', campaignName: 'Retarget', impressions: 300, clicks: 10, leads: 0 },
  ],
  payments: [],
};

describe('campaign table', () => {
  const rows = computeCampaignTable(ADS, R);

  it('aggregates spend/impressions/clicks/platform leads per campaign, sorted by spend', () => {
    expect(rows.map((r) => [r.campaignName, r.spendCents, r.impressions, r.clicks, r.platformLeads])).toEqual([
      ['Summer Shred', 60_000, 2200, 90, 4],
      ['Retarget', 10_000, 300, 10, 0],
      ['Manual entry (google)', 7_000, 0, 0, 0],
    ]);
  });

  it('joins FitFlow-tracked funnel counts by normalised utm_campaign and prices each stage', () => {
    const shred = rows[0];
    expect(shred.tracked).toEqual({ applied: 2, consult_booked: 2, consult_showed: 0, roadmap_booked: 0, roadmap_showed: 0, enrolled: 1 });
    expect(shred.costPer.applied).toBe(30_000);
    expect(shred.costPer.consult_booked).toBe(30_000);
    expect(shred.costPer.enrolled).toBe(60_000);
    expect(shred.costPer.consult_showed).toBeNull();
    expect(shred.contactIds.enrolled).toEqual(['p1']);
    expect(rows[1].tracked.applied).toBe(1); // p3 → Retarget
    expect(rows[2].tracked.applied).toBe(0); // manual rows have no campaign join
  });
});

describe('ads KPIs', () => {
  it('cost per lead / consult / client from total spend, with platform split and connection flags', () => {
    const k = computeAdsKpis(ADS, R);
    expect(k.spendCents).toBe(77_000);
    expect(k.costPerLeadCents).toBe(Math.round(77_000 / 4));
    expect(k.costPerConsultCents).toBe(Math.round(77_000 / 2));
    expect(k.cacCents).toBe(77_000);
    expect(k.apiConnected).toBe(true);
    expect(k.awaitingStripe).toBe(true);
    expect(k.roas).toBeNull();
    expect(k.byPlatform).toEqual([
      { platform: 'meta', spendCents: 70_000, apiCents: 70_000, manualCents: 0 },
      { platform: 'google', spendCents: 7_000, apiCents: 0, manualCents: 7_000 },
    ]);
  });

  it('reports not-connected when only manual spend exists', () => {
    const k = computeAdsKpis({ ...ADS, spend: [manualGoogle] }, R);
    expect(k.apiConnected).toBe(false);
    expect(k.spendCents).toBe(7_000);
  });
});

describe('revenue summary', () => {
  const REV: MetricsInput = {
    ...ADS,
    payments: [
      { id: 'pay1', stripeId: 'ch_1', contactId: 'p1', kind: 'charge', amountCents: 299_900, refundedCents: 0, status: 'succeeded', on: '2026-08-07', origin: 'stripe', email: 'p1@example.com' },
      { id: 'pay2', stripeId: 'ch_2', contactId: null, kind: 'charge', amountCents: 99_900, refundedCents: 99_900, status: 'refunded', on: '2026-08-05', origin: 'stripe', email: 'x@example.com' },
      { id: 'pay3', stripeId: 'ch_3', contactId: null, kind: 'charge', amountCents: 49_900, refundedCents: 0, status: 'failed', on: '2026-08-03', origin: 'stripe', email: 'y@example.com' },
      { id: 'pay4', stripeId: 'in_1', contactId: 'p1', kind: 'invoice', amountCents: 19_900, refundedCents: 0, status: 'succeeded', on: '2026-08-08', origin: 'stripe' },
      { id: 'sub1', stripeId: 'sub_1', contactId: 'p1', kind: 'subscription', amountCents: 19_900, refundedCents: 0, status: 'active', on: '2026-08-01', origin: 'stripe' },
      { id: 'sub2', stripeId: 'sub_2', contactId: null, kind: 'subscription', amountCents: 9_900, refundedCents: 0, status: 'canceled', on: '2026-07-01', origin: 'stripe' },
      { id: 'old', stripeId: 'ch_0', contactId: null, kind: 'charge', amountCents: 500_000, refundedCents: 0, status: 'succeeded', on: '2026-07-01', origin: 'stripe' },
    ],
  };

  it('collected = succeeded − refunds; recurring = active subscriptions; failed pinned first', () => {
    const r = computeRevenueSummary(REV, R);
    expect(r.awaitingStripe).toBe(false);
    expect(r.collectedCents).toBe(299_900 + 19_900 - 99_900);
    expect(r.recurringCents).toBe(19_900);
    expect(r.activeSubscriptions).toBe(1);
    expect(r.failedCount).toBe(1);
    expect(r.failedCents).toBe(49_900);
    expect(r.refundedCents).toBe(99_900);
    expect(r.refundCount).toBe(1);
    expect(r.payments.map((p) => p.id)).toEqual(['pay3', 'pay4', 'pay1', 'pay2']);
    expect(r.unmatchedCount).toBe(0); // the refunded one is not 'succeeded'
  });

  it('attaches contact name, source and Sun–Sat cohort week to matched payments', () => {
    const r = computeRevenueSummary(REV, R);
    const p1 = r.payments.find((p) => p.id === 'pay1')!;
    expect(p1).toMatchObject({ contactName: 'P1', source: 'Facebook', cohortWeek: '2026-08-02' });
    expect(r.payments.find((p) => p.id === 'pay2')!.cohortWeek).toBeNull();
  });

  it('awaiting Stripe when no stripe rows exist', () => {
    expect(computeRevenueSummary(ADS, R)).toMatchObject({ awaitingStripe: true, collectedCents: 0, payments: [] });
  });
});

describe('payment matching', () => {
  const contacts = [
    { id: 'c1', emailNormalized: 'ann@example.com', phoneNormalized: '15550001111' },
    { id: 'c2', emailNormalized: 'bob@example.com', phoneNormalized: null },
    { id: 'c3', emailNormalized: null, phoneNormalized: '15550002222' },
  ];

  it('matches by email first, then phone; skips manual matches and unmatched', () => {
    const matches = matchPayments(
      [
        { id: 'p1', emailNormalized: 'ann@example.com', phoneNormalized: null, contactId: null, matchSource: null },
        { id: 'p2', emailNormalized: 'nobody@example.com', phoneNormalized: '15550002222', contactId: null, matchSource: null },
        { id: 'p3', emailNormalized: 'ann@example.com', phoneNormalized: null, contactId: 'c9', matchSource: 'manual' }, // never overwritten
        { id: 'p4', emailNormalized: null, phoneNormalized: null, contactId: null, matchSource: null },
        { id: 'p5', emailNormalized: 'bob@example.com', phoneNormalized: null, contactId: 'c2', matchSource: 'auto' }, // already right
        { id: 'p6', emailNormalized: 'ann@example.com', phoneNormalized: '15550002222', contactId: null, matchSource: null }, // email wins
      ],
      contacts,
    );
    expect(matches).toEqual([
      { paymentId: 'p1', contactId: 'c1', by: 'email' },
      { paymentId: 'p2', contactId: 'c3', by: 'phone' },
      { paymentId: 'p6', contactId: 'c1', by: 'email' },
    ]);
  });
});
