/** KPI trend popover registry: grains, spans and per-bucket values from the engine. */
import { describe, it, expect } from 'vitest';
import { TREND_METRICS, trendMetric, trendSpans, computeMetricTrend } from '@/lib/metrics/trendMetrics';
import { computeMarketing, computeRevenue, type MetricsInput } from '@/lib/metrics';

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
    { date: '2026-08-30', platform: 'meta', spendCents: 70_000, origin: 'manual' }, // week Aug 30 – Sep 5
    { date: '2026-09-13', platform: 'meta', spendCents: 140_000, origin: 'manual' }, // week Sep 13–19
  ],
  payments: [
    { id: 'p1', stripeId: 'ch_1', contactId: 'a', kind: 'charge', amountCents: 200_000, refundedCents: 0, status: 'succeeded', on: '2026-09-03', origin: 'stripe', paymentClass: 'initial' },
    { id: 'p2', stripeId: 'ch_2', contactId: 'b', kind: 'charge', amountCents: 100_000, refundedCents: 0, status: 'succeeded', on: '2026-09-15', origin: 'stripe', paymentClass: 'initial' },
  ],
};

describe('registry', () => {
  it('volume and cash metrics are daily; rates and CAC are weekly', () => {
    for (const k of ['initial_cash', 'enrollments', 'applied', 'consults_booked', 'spend']) expect(trendMetric(k)?.grain, k).toBe('day');
    for (const k of ['paid_cac', 'blended_cac', 'roas', 'ltv_cac', 'consult_show_rate', 'cpl', 'cost_roadmap']) expect(trendMetric(k)?.grain, k).toBe('week');
    expect(trendMetric('nope')).toBeNull();
    expect(new Set(TREND_METRICS.map((m) => m.key)).size).toBe(TREND_METRICS.length);
    // Every scorecard stat key has a trend.
    for (const k of ['initial_cash', 'enrollments', 'paid_cac', 'blended_cac', 'roas', 'ltv_cac', 'applied', 'consults_booked', 'consult_show_rate', 'roadmaps_booked', 'roadmap_show_rate', 'spend', 'cpl', 'cost_consult', 'cost_roadmap', 'cost_client']) {
      expect(trendMetric(k), k).not.toBeNull();
    }
  });
});

describe('spans', () => {
  it('daily: 30 days ending today, and the 30 before them', () => {
    const s = trendSpans('day', TODAY);
    expect(s.current).toHaveLength(30);
    expect(s.previous).toHaveLength(30);
    expect(s.current[29].start).toBe(TODAY);
    expect(s.current[0].start).toBe('2026-08-19');
    expect(s.previous[29].start).toBe('2026-08-18');
    expect(s.previous[0].start).toBe('2026-07-20');
    expect(s.window).toEqual({ start: '2026-07-20', end: TODAY });
  });

  it('weekly: 12 Sun–Sat weeks ending with the current week, and the 12 before', () => {
    const s = trendSpans('week', TODAY);
    expect(s.current).toHaveLength(12);
    expect(s.previous).toHaveLength(12);
    expect(s.current[11]).toMatchObject({ start: '2026-09-13', end: '2026-09-19' });
    expect(s.current[0]).toMatchObject({ start: '2026-06-28', end: '2026-07-04' });
    expect(s.previous[11]).toMatchObject({ start: '2026-06-21', end: '2026-06-27' });
    expect(s.previous[0]).toMatchObject({ start: '2026-04-05', end: '2026-04-11' });
    expect(s.window).toEqual({ start: '2026-04-05', end: '2026-09-19' });
  });
});

describe('computeMetricTrend', () => {
  it('daily enrollments: one point per day with the engine count', () => {
    const t = computeMetricTrend(trendMetric('enrollments')!, INPUT, TODAY);
    expect(t.grain).toBe('day');
    expect(t.current.filter((p) => p.value)).toEqual([
      { start: '2026-09-03', end: '2026-09-03', label: 'Sep 3', value: 1 },
      { start: '2026-09-15', end: '2026-09-15', label: 'Sep 15', value: 1 },
    ]);
    expect(t.spanValue).toBe(2);
    expect(t.previousSpanValue).toBe(0);
    expect(t.span.label).toBe('Aug 19 – Sep 17');
  });

  it('weekly paid CAC: null in weeks without enrollments, engine value otherwise — never a zero', () => {
    const t = computeMetricTrend(trendMetric('paid_cac')!, INPUT, TODAY);
    expect(t.grain).toBe('week');
    const wk = (start: string) => t.current.find((p) => p.start === start)!;
    expect(wk('2026-08-30').value).toBe(70_000); // 70,000 ÷ 1 paid enrollment
    expect(wk('2026-09-13').value).toBe(140_000);
    expect(wk('2026-09-06').value).toBeNull(); // no enrollments, no spend
    expect(t.spanValue).toBe(computeMarketing(INPUT, { start: t.span.start, end: t.span.end }).paidCacCents);
    expect(t.spanValue).toBe(105_000); // 210,000 ÷ 2 over the 12 weeks
  });

  it('weekly consult show rate as a ratio; daily initial cash null while awaiting Stripe', () => {
    const rate = computeMetricTrend(trendMetric('consult_show_rate')!, INPUT, TODAY);
    expect(rate.current.find((p) => p.start === '2026-08-30')!.value).toBe(1);
    expect(rate.current.find((p) => p.start === '2026-09-06')!.value).toBe(0);
    expect(rate.kind).toBe('pct');

    const cash = computeMetricTrend(trendMetric('initial_cash')!, INPUT, TODAY);
    expect(cash.current.find((p) => p.start === '2026-09-15')!.value).toBe(100_000);
    expect(cash.spanValue).toBe(computeRevenue(INPUT, { start: cash.span.start, end: cash.span.end }).initialCents);

    const noStripe = computeMetricTrend(trendMetric('initial_cash')!, { ...INPUT, payments: [] }, TODAY);
    expect(noStripe.current.every((p) => p.value === null)).toBe(true);
    expect(noStripe.spanValue).toBeNull();
  });
});
