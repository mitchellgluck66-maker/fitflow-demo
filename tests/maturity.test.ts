/**
 * Maturing-data disclaimer: badge conditions, sunset logic, metric scoping,
 * the AI caveat, and the scorecard/email wiring.
 */
import { describe, it, expect } from 'vitest';
import { computeMaturity, isMaturingMetric, isMaturingStage, dataCaveats, maturingCaveatText, HISTORY_DEPENDENT_METRICS, MATURITY_DEFAULTS } from '@/lib/metrics/maturity';
import { computeMetricTrend, trendMetric, TREND_METRICS } from '@/lib/metrics/trendMetrics';
import { assembleScorecard } from '@/lib/scorecard/assemble';
import { renderScorecardDigest } from '@/lib/email/digests';
import { buildInsightInput } from '@/lib/metrics/insights';
import { buildAskContext } from '@/lib/metrics/ask';
import { computeScorecard, computeTrend, computeAdsKpis, computeCampaignTable, computeRevenueSummary, type MetricsInput } from '@/lib/metrics';
import { rangeFromParams, resolveComparison } from '@/lib/dates';
import type { ScorecardResult } from '@/lib/metrics/service';

const NEVER_BADGED = ['enrollments', 'initial_cash', 'paid_cac', 'blended_cac', 'roas', 'ltv_cac', 'spend', 'cost_client', 'applied', 'recurring_cash', 'consult_show_rate', 'roadmap_show_rate'];
const ALWAYS_WHEN_ACTIVE = ['consults_booked', 'roadmaps_booked', 'cpl', 'cost_consult', 'cost_roadmap'];

describe('computeMaturity — the two conditions', () => {
  const since = '2026-09-01';
  const sunset = '2026-10-15';

  it('active only when the range touches pre-history days AND today is before the sunset', () => {
    expect(computeMaturity({ range: { start: '2026-08-16', end: '2026-08-22' }, today: '2026-09-17', historyCompleteSince: since, sunset })).toMatchObject({ active: true, reason: 'active' });
    expect(computeMaturity({ range: { start: '2026-08-30', end: '2026-09-05' }, today: '2026-09-17', historyCompleteSince: since, sunset }).active).toBe(true); // straddles Sept 1
    expect(computeMaturity({ range: { start: '2026-09-01', end: '2026-09-07' }, today: '2026-09-17', historyCompleteSince: since, sunset })).toMatchObject({ active: false, reason: 'range_after_history' });
    expect(computeMaturity({ range: { start: '2026-09-06', end: '2026-09-12' }, today: '2026-09-17', historyCompleteSince: since, sunset }).active).toBe(false);
  });

  it('self-expires: on and after the sunset it never activates, whatever the range', () => {
    expect(computeMaturity({ range: { start: '2026-06-01', end: '2026-06-30' }, today: '2026-10-14', historyCompleteSince: since, sunset }).active).toBe(true);
    expect(computeMaturity({ range: { start: '2026-06-01', end: '2026-06-30' }, today: '2026-10-15', historyCompleteSince: since, sunset })).toMatchObject({ active: false, reason: 'sunset_passed' });
    expect(computeMaturity({ range: { start: '2026-06-01', end: '2026-06-30' }, today: '2027-03-01', historyCompleteSince: since, sunset }).active).toBe(false);
    expect(computeMaturity({ range: { start: '2026-11-01', end: '2026-11-07' }, today: '2026-12-01', historyCompleteSince: since, sunset }).reason).toBe('both');
  });

  it('falls back to the defaults when settings are missing, and honours edited dates', () => {
    const m = computeMaturity({ range: { start: '2026-08-01', end: '2026-08-31' }, today: '2026-09-17' });
    expect(m).toMatchObject({ active: true, historyCompleteSince: MATURITY_DEFAULTS.historyCompleteSince, sunset: MATURITY_DEFAULTS.disclaimerSunset });
    expect(computeMaturity({ range: { start: '2026-08-01', end: '2026-08-31' }, today: '2026-09-17', historyCompleteSince: '2026-07-01', sunset: '2026-12-31' }).active).toBe(false);
    expect(computeMaturity({ range: { start: '2026-08-01', end: '2026-08-31' }, today: '2026-09-17', historyCompleteSince: null, sunset: '2026-09-10' }).active).toBe(false);
  });
});

describe('which metrics carry the badge', () => {
  const active = computeMaturity({ range: { start: '2026-08-16', end: '2026-08-22' }, today: '2026-09-17' });
  const inactive = computeMaturity({ range: { start: '2026-09-06', end: '2026-09-12' }, today: '2026-09-17' });

  it('history-dependent metrics: badge iff active', () => {
    for (const k of ALWAYS_WHEN_ACTIVE) {
      expect(isMaturingMetric(k, active), k).toBe(true);
      expect(isMaturingMetric(k, inactive), k).toBe(false);
      expect(HISTORY_DEPENDENT_METRICS.has(k)).toBe(true);
    }
  });

  it('enrollments, initial cash, Paid/Blended CAC, ROAS, LTV:CAC, spend NEVER carry it — even while active', () => {
    for (const k of NEVER_BADGED) {
      expect(isMaturingMetric(k, active), k).toBe(false);
      expect(isMaturingMetric(k, inactive), k).toBe(false);
    }
    expect(isMaturingMetric('cpl', null)).toBe(false);
    expect(isMaturingMetric('cpl', undefined)).toBe(false);
  });

  it('funnel stages: only consult_booked and roadmap_booked counts', () => {
    for (const st of ['consult_booked', 'roadmap_booked']) expect(isMaturingStage(st, active), st).toBe(true);
    for (const st of ['applied', 'consult_showed', 'roadmap_showed', 'enrolled']) expect(isMaturingStage(st, active), st).toBe(false);
    expect(isMaturingStage('consult_booked', inactive)).toBe(false);
  });

  it('every history-dependent key is a registered trend metric (the popover can badge it)', () => {
    for (const k of HISTORY_DEPENDENT_METRICS) expect(trendMetric(k), k).not.toBeNull();
    expect(TREND_METRICS.length).toBeGreaterThan(0);
  });
});

describe('wording and the AI caveat', () => {
  const active = computeMaturity({ range: { start: '2026-08-16', end: '2026-08-22' }, today: '2026-09-17' });

  it('is worded once, from the settings dates', () => {
    expect(maturingCaveatText(active)).toBe(
      "Stage history before Sep 1 is partial (GHL kept only each person's latest stage), so this number runs low/high. Accuracy improves daily; this notice retires Oct 15.",
    );
    expect(maturingCaveatText({ historyCompleteSince: '2026-10-01', sunset: '2027-01-15' })).toContain('before Oct 1');
    expect(maturingCaveatText({ historyCompleteSince: '2026-10-01', sunset: '2027-01-15' })).toContain('retires Jan 15');
  });

  it('dataCaveats carries the fact while active and is empty after sunset', () => {
    const c = dataCaveats(active);
    expect(c).toHaveLength(1);
    expect(c[0]).toContain(maturingCaveatText(active));
    expect(c[0]).toContain('NOT affected: enrollments, initial cash, Paid CAC, Blended CAC, ROAS, LTV:CAC, spend');
    expect(dataCaveats(computeMaturity({ range: { start: '2026-06-01', end: '2026-06-30' }, today: '2026-10-15' }))).toEqual([]);
    expect(dataCaveats(null)).toEqual([]);
  });
});

// ---- scorecard / email / AI wiring ------------------------------------------
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const INPUT: MetricsInput = {
  contacts: [{ id: 'a', name: 'A', email: null, source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: '2026-08-17', monetaryValueCents: 500_000, origin: 'ghl', attribution: 'paid' }],
  transitions: [
    { contactId: 'a', fromRole: null, toRole: 'consult_booked', toStageId: null, on: '2026-08-18', atMs: noon('2026-08-18') },
    { contactId: 'a', fromRole: 'consult_booked', toRole: 'enrolled', toStageId: null, on: '2026-08-21', atMs: noon('2026-08-21') },
  ],
  appointments: [],
  spend: [{ date: '2026-08-16', platform: 'meta', spendCents: 50_000, origin: 'manual' }],
  payments: [{ id: 'p', stripeId: 'ch', contactId: 'a', kind: 'charge', amountCents: 200_000, refundedCents: 0, status: 'succeeded', on: '2026-08-21', origin: 'stripe', paymentClass: 'initial' }],
};

function build(rangeKey: string, today: string): ScorecardResult {
  const range = rangeFromParams({ range: rangeKey }, today);
  const comparison = resolveComparison(range, 'previous_period', today);
  const P = comparison.range!;
  return {
    timezone: 'America/New_York',
    today,
    range,
    comparison,
    baseline: { start: '2026-06-21', end: '2026-08-15' },
    scorecard: computeScorecard(INPUT, range, P, null),
    trend: { grain: 'day', current: [], comparison: null },
    trendWeekly: { current: computeTrend(INPUT, [{ ...range, label: range.resolvedLabel }]), comparison: null },
    trendWeeklyCohort: { current: [], comparison: null },
    trailingWeeks: [],
    ads: { kpis: computeAdsKpis(INPUT, range), previousKpis: computeAdsKpis(INPUT, P), campaigns: computeCampaignTable(INPUT, range), previousCampaigns: null },
    revenue: computeRevenueSummary(INPUT, range),
    maturity: computeMaturity({ range, today }),
  };
}

describe('scorecard, email and AI inputs carry the caveat only while active', () => {
  const activeResult = build('last_week', '2026-08-26'); // Aug 16–22, before Sept 1
  const retiredResult = build('last_week', '2026-10-20'); // after sunset

  it('scorecard stats: only history-dependent stats are flagged, and none after sunset', () => {
    const v = assembleScorecard(activeResult, null);
    const flagged = [...v.sections.money, ...v.sections.pipeline, ...v.sections.ads].filter((s) => s.maturing).map((s) => s.key).sort();
    expect(flagged).toEqual([...ALWAYS_WHEN_ACTIVE].sort());
    expect(v.notes.some((n) => n.text.startsWith('Maturing data'))).toBe(true);

    const r = assembleScorecard(retiredResult, null);
    expect([...r.sections.money, ...r.sections.pipeline, ...r.sections.ads].some((s) => s.maturing)).toBe(false);
    expect(r.notes.some((n) => n.text.startsWith('Maturing data'))).toBe(false);
  });

  it('email marks affected stats with † and explains once', () => {
    const d = renderScorecardDigest('weekly', assembleScorecard(activeResult, null), activeResult.range);
    expect(d.html).toContain('Consults booked †');
    expect(d.html).toContain('Cost per lead †');
    expect(d.html).not.toContain('Enrollments †');
    expect(d.html).toContain('Stage history before Sep 1 is partial');
    const retired = renderScorecardDigest('weekly', assembleScorecard(retiredResult, null), retiredResult.range);
    expect(retired.html).not.toContain('†');
    expect(retired.html).not.toContain('Stage history before');
  });

  it('insight and Ask contexts get dataCaveats while active, an empty array after', () => {
    expect(buildInsightInput(activeResult).dataCaveats).toHaveLength(1);
    expect(buildAskContext(activeResult).dataCaveats[0]).toContain('consults booked, roadmaps booked');
    expect(buildInsightInput(retiredResult).dataCaveats).toEqual([]);
    expect(buildAskContext(retiredResult).dataCaveats).toEqual([]);
  });

  it('trend computation is pure (no maturity) and the service decides per span', () => {
    const t = computeMetricTrend(trendMetric('cpl')!, INPUT, '2026-09-17');
    expect(t.maturity).toBeNull();
    expect(t.maturing).toBe(false);
    // The 12-week span starts Jun 28 → before Sept 1 → badge while today < sunset.
    const m = computeMaturity({ range: t.span, today: '2026-09-17' });
    expect(isMaturingMetric('cpl', m)).toBe(true);
    expect(isMaturingMetric('paid_cac', m)).toBe(false);
  });
});
