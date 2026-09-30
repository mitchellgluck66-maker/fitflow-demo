/** KPI trend drop-down (A1, 2026-09-30): one window rule for every metric; header + highlight values from the engine. */
import { describe, it, expect } from 'vitest';
import { TREND_METRICS, TREND_WINDOWS, TREND_WINDOW_META, trendMetric, trendSpans, trendWindow, computeMetricTrend } from '@/lib/metrics/trendMetrics';
import { computeAdsKpis, computeMarketing, computeRevenue, computeRevenueSummary, computeScorecard, type MetricsInput } from '@/lib/metrics';
import { PRESETS, resolvePreset, addDays } from '@/lib/dates';

// 2026-09-17 is a Thursday; this week = Sep 13–19.
const TODAY = '2026-09-17';
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);

const INPUT: MetricsInput = {
  contacts: [
    { id: 'a', name: 'A', email: null, source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: '2026-09-01', monetaryValueCents: 500_000, origin: 'ghl', attribution: 'paid' },
    { id: 'b', name: 'B', email: null, source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: '2026-09-10', monetaryValueCents: 500_000, origin: 'ghl', attribution: 'paid' },
    { id: 'c', name: 'C', email: null, source: 'Referral', stageId: null, stageName: null, role: 'applied', appliedOn: '2026-08-05', monetaryValueCents: 0, origin: 'ghl', attribution: 'organic' },
  ],
  transitions: [
    { contactId: 'a', fromRole: null, toRole: 'enrolled', toStageId: null, on: '2026-09-03', atMs: noon('2026-09-03') },
    { contactId: 'b', fromRole: null, toRole: 'enrolled', toStageId: null, on: '2026-09-15', atMs: noon('2026-09-15') },
  ],
  appointments: [
    { contactId: 'a', type: 'Consult', outcome: 'showed', on: '2026-09-02', atMs: noon('2026-09-02') },
    { contactId: 'b', type: 'Consult', outcome: 'no_show', on: '2026-09-12', atMs: noon('2026-09-12') },
  ],
  spend: [
    { date: '2026-08-30', platform: 'meta', currency: 'CAD' as const, spendCents: 70_000, origin: 'manual' }, // week Aug 30 – Sep 5
    { date: '2026-09-13', platform: 'meta', currency: 'CAD' as const, spendCents: 140_000, origin: 'manual' }, // week Sep 13–19
  ],
  payments: [
    { id: 'p1', stripeId: 'ch_1', contactId: 'a', kind: 'charge', currency: 'CAD' as const, amountCents: 200_000, refundedCents: 0, status: 'succeeded', on: '2026-09-03', origin: 'stripe', paymentClass: 'initial' },
    { id: 'p2', stripeId: 'ch_2', contactId: 'b', kind: 'charge', currency: 'CAD' as const, amountCents: 100_000, refundedCents: 0, status: 'succeeded', on: '2026-09-15', origin: 'stripe', paymentClass: 'initial' },
  ],
};

describe('registry', () => {
  it('every tile metric is registered once; no metric carries its own grain any more', () => {
    expect(trendMetric('nope')).toBeNull();
    expect(new Set(TREND_METRICS.map((m) => m.key)).size).toBe(TREND_METRICS.length);
    for (const m of TREND_METRICS) expect('grain' in m, m.key).toBe(false);
    for (const k of ['initial_cash', 'enrollments', 'paid_cac', 'blended_cac', 'roas', 'ltv_cac', 'applied', 'consults_booked', 'consult_show_rate', 'roadmaps_booked', 'roadmap_show_rate', 'spend', 'cpl', 'cost_consult', 'cost_roadmap', 'cost_client']) {
      expect(trendMetric(k), k).not.toBeNull();
    }
  });
});

// Expected windows for TODAY = Thu 2026-09-17 (hand-computed).
const EXPECTED = {
  '30d': { grain: 'day', start: '2026-08-19', buckets: 30, first: { start: '2026-08-19', end: '2026-08-19' }, last: { start: '2026-09-17', end: '2026-09-17' }, prev: { start: '2026-07-20', end: '2026-08-18' } },
  // Jun 17 + 1 = Thu Jun 18 → its week starts Sun Jun 14; 14 weeks, the last one to date (Sep 13–17).
  '3m': { grain: 'week', start: '2026-06-14', buckets: 14, first: { start: '2026-06-14', end: '2026-06-20' }, last: { start: '2026-09-13', end: '2026-09-17' }, prev: { start: '2026-03-08', end: '2026-06-13' } },
  // Mar 17 + 1 = Wed Mar 18 → week of Sun Mar 15; 27 weeks.
  '6m': { grain: 'week', start: '2026-03-15', buckets: 27, first: { start: '2026-03-15', end: '2026-03-21' }, last: { start: '2026-09-13', end: '2026-09-17' }, prev: { start: '2025-09-07', end: '2026-03-14' } },
  // 11 months back → Oct 2025; 12 calendar months, September to date.
  '12m': { grain: 'month', start: '2025-10-01', buckets: 12, first: { start: '2025-10-01', end: '2025-10-31' }, last: { start: '2026-09-01', end: '2026-09-17' }, prev: { start: '2024-10-01', end: '2025-09-30' } },
} as const;

describe('windows: one rule for every metric × every toggle', () => {
  it('default is 3 months, weekly', () => {
    const t = computeMetricTrend(trendMetric('enrollments')!, INPUT, TODAY);
    expect(t).toMatchObject({ window: '3m', windowLabel: 'Last 3 months', grain: 'week' });
  });

  for (const w of TREND_WINDOWS) {
    it(`${w}: grain, window dates and the header value from engine totals — for every metric`, () => {
      const e = EXPECTED[w];
      const s = trendSpans(w, TODAY);
      expect(s.grain).toBe(e.grain);
      expect(TREND_WINDOW_META[w].grain).toBe(e.grain);
      expect(s.current).toHaveLength(e.buckets);
      expect(s.previous).toHaveLength(e.buckets);
      expect(s.current[0]).toMatchObject(e.first);
      expect(s.current.at(-1)).toMatchObject(e.last);
      expect(s.span).toEqual({ start: e.start, end: TODAY });
      expect(s.previousSpan).toEqual(e.prev);
      // Buckets tile the window with no gap or overlap.
      for (let i = 1; i < s.current.length; i += 1) expect(s.current[i].start).toBe(addDays(s.current[i - 1].end, 1));
      for (let i = 1; i < s.previous.length; i += 1) expect(s.previous[i].start).toBe(addDays(s.previous[i - 1].end, 1));
      expect(addDays(s.previous.at(-1)!.end, 1)).toBe(s.current[0].start);

      for (const m of TREND_METRICS) {
        const t = computeMetricTrend(m, INPUT, TODAY, w);
        expect(t.grain, m.key).toBe(e.grain);
        expect(t.span, m.key).toMatchObject({ start: e.start, end: TODAY });
        // The header value is the metric over the whole window — never a sum/average of bucket ratios.
        expect(t.spanValue, m.key).toBe(m.compute(INPUT, { start: e.start, end: TODAY }));
        expect(t.previousSpanValue, m.key).toBe(m.compute(INPUT, e.prev));
        expect(t.current.map((p) => p.value), m.key).toEqual(s.current.map((b) => m.compute(INPUT, b)));
      }
    });
  }

  it('ratios are recomputed from window totals: 3-month paid CAC = total spend ÷ total paid enrollments', () => {
    const t = computeMetricTrend(trendMetric('paid_cac')!, INPUT, TODAY, '3m');
    expect(t.current.find((p) => p.start === '2026-08-30')!.value).toBe(70_000);
    // The current week is to date (Sep 13–17): a manual weekly row is spread over its 7 days → 5/7 of 140,000.
    expect(t.current.find((p) => p.start === '2026-09-13')!.value).toBe(100_000);
    expect(t.current.find((p) => p.start === '2026-09-06')!.value).toBeNull(); // nothing that week — never a zero
    expect(t.spanValue).toBe(85_000); // (70,000 + 100,000) ÷ 2 paid enrollments — not the mean of weekly CACs
    expect(t.spanValue).toBe(computeMarketing(INPUT, { start: '2026-06-14', end: TODAY }).paidCacCents);
  });

  it('sums for counts / cash; monthly buckets add up to the window', () => {
    const t = computeMetricTrend(trendMetric('initial_cash')!, INPUT, TODAY, '12m');
    expect(t.current.at(-1)).toMatchObject({ label: 'Sep ’26', value: 300_000 });
    expect(t.spanValue).toBe(computeRevenue(INPUT, { start: '2025-10-01', end: TODAY }).initialCents);
    const noStripe = computeMetricTrend(trendMetric('initial_cash')!, { ...INPUT, payments: [] }, TODAY, '30d');
    expect(noStripe.current.every((p) => p.value === null)).toBe(true);
    expect(noStripe.spanValue).toBeNull();
  });

  it('the load window covers the prior span and the card range', () => {
    expect(trendWindow('3m', TODAY)).toEqual({ start: '2026-03-08', end: TODAY });
    expect(trendWindow('30d', TODAY, { start: '2026-05-01', end: '2026-05-31' })).toEqual({ start: '2026-05-01', end: TODAY });
  });
});

describe('highlight = the card', () => {
  // What each tile renders, straight from the same engine outputs the pages use.
  const tiles = (r: { start: string; end: string }): Record<string, number | null> => {
    const sc = computeScorecard(INPUT, r, null, null);
    const ads = computeAdsKpis(INPUT, r);
    const rev = computeRevenueSummary(INPUT, r);
    const rate = (type: string) => sc.showRates.find((x) => x.type === type)?.rate ?? null;
    return {
      initial_cash: sc.kpis.initialCents.current,
      enrollments: sc.kpis.enrollments.current,
      paid_cac: sc.kpis.paidCacCents.current,
      blended_cac: sc.kpis.blendedCacCents.current,
      roas: sc.kpis.roas.current,
      ltv_cac: sc.kpis.ltvToCac.current,
      consults_booked: sc.kpis.consultsBooked.current,
      roadmaps_booked: sc.kpis.roadmapsBooked.current,
      applied: sc.kpis.applied.current,
      cost_roadmap: sc.kpis.costPerRoadmapCents.current,
      consult_show_rate: rate('Consult'),
      roadmap_show_rate: rate('Roadmap'),
      spend: ads.spendCents,
      cpl: ads.costPerLeadCents,
      cost_consult: ads.costPerConsultCents,
      cost_client: ads.blendedCacCents,
      recurring_cash: rev.recurringCents,
      collected: rev.collectedCents,
      failed: rev.failedCount,
      refunds: rev.refundedCents,
    };
  };

  for (const p of PRESETS.filter((x) => x.value !== 'custom')) {
    it(`${p.label}: the highlighted span's value equals the tile, for every metric and window`, () => {
      const r = resolvePreset(p.value, TODAY);
      const expected = tiles(r);
      expect(Object.keys(expected).sort()).toEqual(TREND_METRICS.map((m) => m.key).sort());
      for (const w of TREND_WINDOWS) {
        for (const m of TREND_METRICS) {
          const t = computeMetricTrend(m, INPUT, TODAY, w, r);
          expect(t.highlight, `${p.value} ${w} ${m.key}`).toMatchObject({ start: r.start, end: r.end, value: expected[m.key], inWindow: true });
          // The band marks exactly the buckets that overlap the card.
          const marked = t.current.filter((b) => b.inCard);
          expect(marked.length, `${p.value} ${w}`).toBeGreaterThan(0);
          expect(marked[0].start <= r.start || marked[0].start === t.span.start).toBe(true);
          expect(marked.at(-1)!.end >= r.end || marked.at(-1)!.end === TODAY).toBe(true);
          expect(t.previous.some((b) => b.inCard)).toBe(false);
        }
      }
    });
  }

  it('a card range outside the window is flagged, not drawn', () => {
    const t = computeMetricTrend(trendMetric('enrollments')!, INPUT, TODAY, '30d', { start: '2026-06-01', end: '2026-06-30' });
    expect(t.highlight).toMatchObject({ inWindow: false });
    expect(t.current.some((b) => b.inCard)).toBe(false);
  });
});
