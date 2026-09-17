/**
 * The shared scorecard assembly (page + email) and its email rendering.
 * Fixture from tests/ask.test.ts' shape: last week vs the week before.
 */
import { describe, it, expect } from 'vitest';
import { assembleScorecard, scorecardKindOf } from '@/lib/scorecard/assemble';
import { renderScorecardDigest } from '@/lib/email/digests';
import { computeScorecard, computeTrend, computeAdsKpis, computeCampaignTable, computeRevenueSummary, type MetricsInput } from '@/lib/metrics';
import { resolveComparison, rangeFromParams } from '@/lib/dates';
import type { ScorecardResult } from '@/lib/metrics/service';

const TODAY = '2026-08-26';
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const INPUT: MetricsInput = {
  contacts: [
    { id: 'a1', name: 'Ann', email: 'ann@x.com', source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: '2026-08-17', monetaryValueCents: 600_000, origin: 'ghl', campaign: 'Broad', attribution: 'paid' },
    { id: 'a2', name: 'Bob', email: 'bob@x.com', source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: '2026-08-18', monetaryValueCents: 400_000, origin: 'ghl', campaign: 'Retarget', attribution: 'paid' },
    { id: 'a3', name: 'Cy', email: 'cy@x.com', source: 'Referral', stageId: null, stageName: null, role: 'consult_booked', appliedOn: '2026-08-19', monetaryValueCents: 0, origin: 'ghl', attribution: 'organic' },
    { id: 'p1', name: 'Pat', email: 'pat@x.com', source: 'Facebook', stageId: null, stageName: null, role: 'enrolled', appliedOn: '2026-08-10', monetaryValueCents: 500_000, origin: 'ghl', campaign: 'Broad', attribution: 'paid' },
  ],
  transitions: [
    { contactId: 'a1', fromRole: null, toRole: 'consult_booked', toStageId: null, on: '2026-08-18', atMs: noon('2026-08-18') },
    { contactId: 'a1', fromRole: 'consult_booked', toRole: 'roadmap_booked', toStageId: null, on: '2026-08-19', atMs: noon('2026-08-19') },
    { contactId: 'a1', fromRole: 'roadmap_booked', toRole: 'enrolled', toStageId: null, on: '2026-08-21', atMs: noon('2026-08-21') },
    { contactId: 'a2', fromRole: null, toRole: 'consult_booked', toStageId: null, on: '2026-08-19', atMs: noon('2026-08-19') },
    { contactId: 'a2', fromRole: 'consult_booked', toRole: 'enrolled', toStageId: null, on: '2026-08-22', atMs: noon('2026-08-22') },
    { contactId: 'a3', fromRole: null, toRole: 'consult_booked', toStageId: null, on: '2026-08-20', atMs: noon('2026-08-20') },
    { contactId: 'p1', fromRole: null, toRole: 'consult_booked', toStageId: null, on: '2026-08-11', atMs: noon('2026-08-11') },
    { contactId: 'p1', fromRole: 'consult_booked', toRole: 'enrolled', toStageId: null, on: '2026-08-14', atMs: noon('2026-08-14') },
  ],
  appointments: [
    { contactId: 'a1', type: 'Consult', outcome: 'showed', on: '2026-08-19', atMs: noon('2026-08-19') },
    { contactId: 'a2', type: 'Consult', outcome: 'showed', on: '2026-08-20', atMs: noon('2026-08-20') },
    { contactId: 'a3', type: 'Consult', outcome: 'no_show', on: '2026-08-21', atMs: noon('2026-08-21') },
    { contactId: 'a1', type: 'Roadmap', outcome: 'showed', on: '2026-08-20', atMs: noon('2026-08-20') },
    { contactId: 'p1', type: 'Consult', outcome: 'showed', on: '2026-08-12', atMs: noon('2026-08-12') },
    { contactId: 'p1', type: 'Consult', outcome: 'no_show', on: '2026-08-13', atMs: noon('2026-08-13') },
  ],
  spend: [
    { date: '2026-08-16', platform: 'meta', spendCents: 60_000, origin: 'meta', campaignId: 'c1', campaignName: 'Broad', impressions: 4000, clicks: 100 },
    { date: '2026-08-17', platform: 'meta', spendCents: 40_000, origin: 'meta', campaignId: 'c2', campaignName: 'Retarget', impressions: 1000, clicks: 50 },
    { date: '2026-08-10', platform: 'meta', spendCents: 50_000, origin: 'meta', campaignId: 'c1', campaignName: 'Broad', impressions: 3000, clicks: 80 },
  ],
  payments: [
    { id: 'p-a1', stripeId: 'ch_a1', contactId: 'a1', kind: 'charge', amountCents: 300_000, refundedCents: 0, status: 'succeeded', on: '2026-08-21', origin: 'stripe', paymentClass: 'initial' },
    { id: 'p-a2', stripeId: 'ch_a2', contactId: 'a2', kind: 'charge', amountCents: 200_000, refundedCents: 0, status: 'succeeded', on: '2026-08-22', origin: 'stripe', paymentClass: 'initial' },
    { id: 'p-p1', stripeId: 'ch_p1', contactId: 'p1', kind: 'charge', amountCents: 250_000, refundedCents: 0, status: 'succeeded', on: '2026-08-14', origin: 'stripe', paymentClass: 'initial' },
  ],
};

function build(rangeParams: { range: string; start?: string }): ScorecardResult {
  const range = rangeFromParams({ range: rangeParams.range, start: rangeParams.start ?? null }, TODAY);
  const comparison = resolveComparison(range, 'previous_period', TODAY);
  const P = comparison.range!;
  const scorecard = computeScorecard(INPUT, range, P, null);
  return {
    timezone: 'America/New_York',
    today: TODAY,
    range,
    comparison,
    baseline: { start: '2026-06-21', end: '2026-08-15' },
    scorecard,
    trend: { grain: 'day', current: [], comparison: null },
    trendWeekly: { current: computeTrend(INPUT, [{ ...range, label: range.resolvedLabel }]), comparison: null },
    trendWeeklyCohort: { current: [], comparison: null },
    trailingWeeks: [],
    ads: { kpis: computeAdsKpis(INPUT, range), previousKpis: computeAdsKpis(INPUT, P), campaigns: computeCampaignTable(INPUT, range), previousCampaigns: computeCampaignTable(INPUT, P) },
    revenue: computeRevenueSummary(INPUT, range),
  };
}

describe('assembleScorecard (pure, shared by /scorecard and the email)', () => {
  const result = build({ range: 'last_week' }); // Aug 16–22 vs Aug 9–15
  const view = assembleScorecard(result, 'A solid week.');
  const byKey = (section: keyof typeof view.sections, key: string) => view.sections[section].find((s) => s.key === key)!;

  it('names the period, kind and comparison', () => {
    expect(scorecardKindOf(result)).toBe('weekly');
    expect(view.kind).toBe('weekly');
    expect(view.title).toBe('Week of Aug 16–22');
    expect(view.subtitle).toBe('vs Aug 9–15');
    expect(view.narrative).toBe('A solid week.');
    expect(view.narrativeTitle).toBe('This week in one paragraph');
    expect(view.subject).toBe('FitFlow weekly scorecard — Aug 16–22: 2 enrolled, 3 consults booked');
  });

  it('Money: every stat is the engine value formatted, with the engine delta', () => {
    expect(view.sections.money.map((s) => s.key)).toEqual(['initial_cash', 'enrollments', 'paid_cac', 'blended_cac', 'roas', 'ltv_cac']);
    expect(byKey('money', 'initial_cash')).toMatchObject({ value: '$5,000', sub: '+$2,500 (+100%)', tone: 'good' });
    expect(byKey('money', 'enrollments')).toMatchObject({ value: '2', sub: '+1 (+100%)', tone: 'good' });
    // Spend Aug 16–22 = 100,000; 2 paid enrollments → $500; previous $500 (50,000 ÷ 1) → flat
    expect(byKey('money', 'paid_cac')).toMatchObject({ value: '$500', tone: 'neutral' });
    expect(byKey('money', 'blended_cac').value).toBe('$500');
    expect(byKey('money', 'roas')).toMatchObject({ value: '5.00×', tone: 'neutral' }); // 500,000 ÷ 100,000 vs 250,000 ÷ 50,000
    expect(byKey('money', 'ltv_cac')).toMatchObject({ value: '10.0×' }); // 1,000,000 contract ÷ 100,000 spend
    expect(byKey('money', 'ltv_cac').delta.current).toBe(10);
  });

  it('Pipeline: counts and show rates with deltas vs the previous period', () => {
    expect(view.sections.pipeline.map((s) => s.key)).toEqual(['applied', 'consults_booked', 'consult_show_rate', 'roadmaps_booked', 'roadmap_show_rate']);
    expect(byKey('pipeline', 'applied')).toMatchObject({ value: '3', sub: '+2 (+200%)' });
    expect(byKey('pipeline', 'consults_booked').value).toBe('3');
    // Consult show rate: 2 showed / (2 + 1 no-show) = 67%; previous 1/(1+1) = 50%
    expect(byKey('pipeline', 'consult_show_rate')).toMatchObject({ value: '67%', deltaKind: 'pct', tone: 'good' });
    expect(byKey('pipeline', 'consult_show_rate').delta.previous).toBe(0.5);
    expect(byKey('pipeline', 'roadmaps_booked').value).toBe('1');
    expect(byKey('pipeline', 'roadmap_show_rate')).toMatchObject({ value: '100%' });
  });

  it('Ads: spend and cost per stage (lower is better), top and worst campaign by cost per client', () => {
    expect(view.sections.ads.map((s) => s.key)).toEqual(['spend', 'cpl', 'cost_consult', 'cost_roadmap', 'cost_client']);
    expect(byKey('ads', 'spend')).toMatchObject({ value: '$1,000', sub: '+$500 (+100%)', tone: 'bad' });
    expect(byKey('ads', 'cpl').value).toBe(formatCentsLike(100_000 / 3));
    expect(byKey('ads', 'cost_client').value).toBe('$500');
    expect(view.campaigns.top).toMatchObject({ campaignName: 'Retarget', costPerEnrollmentCents: 40_000, enrolled: 1 });
    expect(view.campaigns.worst).toMatchObject({ campaignName: 'Broad', costPerEnrollmentCents: 60_000, enrolled: 1 });
    expect(view.campaigns.note).toBe('');
  });

  it('funnel / show / source tables and the CAC line are the email’s tables', () => {
    expect(view.funnelRows[0]).toEqual(['Applied', '3', '100%', '—', '$333.33']);
    expect(view.funnelRows[5]).toEqual(['Enrolled', '2', '67%', '200%', '$500']);
    expect(view.showRows).toEqual([
      ['Consult', '2', '1', '0', '67%'],
      ['Roadmap', '1', '0', '0', '100%'],
    ]);
    expect(view.sourceRows[0]).toEqual(['Facebook', '2', '2', '2', '100%']);
    expect(view.cacLine).toContain('Paid CAC: $1,000 spend ÷ 2 paid-attributed enrollments = $500.');
    expect(view.cacLine).toContain('LTV:CAC: $10,000 contract value ÷ $1,000 spend = 10.0×.');
    expect(view.empty).toBe(false);
  });

  it('withholds numbers whose inputs are missing (never a silent zero)', () => {
    const noStripe = assembleScorecard({ ...result, scorecard: computeScorecard({ ...INPUT, payments: [] }, result.range, result.comparison.range, null) }, null);
    expect(noStripe.sections.money[0]).toMatchObject({ key: 'initial_cash', value: '—', sub: 'Awaiting Stripe' });
    expect(noStripe.sections.money[0].empty?.title).toBe('Awaiting Stripe');
    expect(noStripe.sections.money.find((s) => s.key === 'roas')!.empty).toBeTruthy();
    expect(noStripe.notes[0].text).toMatch(/Stripe is connected/);

    const missingValue = assembleScorecard({ ...result, scorecard: computeScorecard({ ...INPUT, contacts: INPUT.contacts.map((c) => (c.id === 'a2' ? { ...c, monetaryValueCents: 0 } : c)) }, result.range, result.comparison.range, null) }, null);
    const ltv = missingValue.sections.money.find((s) => s.key === 'ltv_cac')!;
    expect(ltv.value).toBe('—');
    expect(ltv.empty?.description).toContain('Bob');
  });

  it('monthly and custom kinds', () => {
    const monthly = assembleScorecard(build({ range: 'month', start: '2026-08-05' }), null);
    expect(monthly.kind).toBe('monthly');
    expect(monthly.title).toBe('August 2026');
    expect(monthly.narrativeTitle).toBe('This month in one paragraph');
    expect(monthly.subject).toMatch(/^FitFlow monthly scorecard — Aug 1–31/);
    const custom = assembleScorecard(build({ range: 'last_30_days' }), null);
    expect(custom.kind).toBe('custom');
    expect(custom.subject).toMatch(/^FitFlow scorecard — /);
  });

  it('a cycled week resolves against the week before it', () => {
    const stepped = build({ range: 'week', start: '2026-08-05' }); // Aug 2–8 vs Jul 26 – Aug 1
    const v = assembleScorecard(stepped, null);
    expect(v.title).toBe('Week of Aug 2–8');
    expect(v.subtitle).toBe('vs Jul 26 – Aug 1');
    expect(v.empty).toBe(true);
  });
});

describe('renderScorecardDigest renders the assembled model verbatim', () => {
  const result = build({ range: 'last_week' });
  const view = assembleScorecard(result, 'A solid week.');
  const digest = renderScorecardDigest('weekly', view, result.range);

  it('HTML carries every section value and the narrative', () => {
    for (const st of [...view.sections.money, ...view.sections.pipeline, ...view.sections.ads]) {
      expect(digest.html).toContain(st.label);
      expect(digest.html).toContain(st.value);
    }
    expect(digest.html).toContain('A solid week.');
    expect(digest.html).toContain('Best cost per client: Retarget');
    expect(digest.html).toContain('Worst: Broad');
    expect(digest.subject).toBe(view.subject);
    expect(digest.empty).toBe(false);
    expect(digest.periodStart).toBe('2026-08-16');
  });

  it('plain text has the same three sections in the same order', () => {
    const money = digest.text.indexOf('MONEY');
    const pipeline = digest.text.indexOf('PIPELINE');
    const adsIdx = digest.text.indexOf('ADS');
    expect(money).toBeGreaterThan(-1);
    expect(pipeline).toBeGreaterThan(money);
    expect(adsIdx).toBeGreaterThan(pipeline);
    expect(digest.text).toMatch(/Initial cash collected\s+\$5,000\s+\+\$2,500 \(\+100%\)/);
    expect(digest.text).toMatch(/ROAS\s+5\.00×\s+no change/);
  });
});

function formatCentsLike(cents: number): string {
  const dollars = Math.round(cents) / 100;
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: dollars % 1 === 0 ? 0 : 2 });
}
