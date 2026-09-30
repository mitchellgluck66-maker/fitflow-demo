/**
 * Metric glossary (Analyst plan item 2): every UI metric key has an entry, and
 * for every key × range on this fixture, `worked().value` equals the engine
 * value the page renders (the same functions, so the formula box can never
 * disagree with the tile).
 */
import { describe, it, expect } from 'vitest';
import {
  computeCampaignTable,
  computeFunnel,
  computeMarketing,
  computeRevenueSummary,
  computeShowRates,
  computeTimeInStage,
  formatCents,
  FUNNEL_STAGES,
  type ContactRow,
  type MetricsInput,
  type PaymentRow,
} from '@/lib/metrics';
import { TREND_METRICS } from '@/lib/metrics/trendMetrics';
import { DISPLAY_METRICS } from '@/lib/metrics/display';
import { GLOSSARY, GLOSSARY_KEYS, glossaryEntry, glossaryText, METRIC_DEFINITION_VERSION, missingGlossaryKeys } from '@/lib/metrics/glossary';

const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const c = (id: string, attribution: 'paid' | 'organic' | null, valueCents: number, appliedOn: string, campaign: string | null = null): ContactRow => ({
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
  campaign,
});
const t = (contactId: string, fromRole: string | null, toRole: string, on: string) => ({ contactId, fromRole: fromRole as never, toRole: toRole as never, toStageId: `st-${toRole}`, on, atMs: noon(on) });
const pay = (id: string, contactId: string | null, cents: number, cls: 'initial' | 'recurring', on: string, over: Partial<PaymentRow> = {}): PaymentRow => ({ id, stripeId: id, contactId, kind: 'charge', currency: 'CAD', amountCents: cents, refundedCents: 0, status: 'succeeded', on, origin: 'stripe', paymentClass: cls, ...over });

// Week A = Aug 2–8 (spend, appointments, cash); week B = Aug 9–15 (no spend); C = Aug 16–22 (empty).
const A = { start: '2026-08-02', end: '2026-08-08' };
const B = { start: '2026-08-09', end: '2026-08-15' };
const C = { start: '2026-08-16', end: '2026-08-22' };
const AB = { start: '2026-08-02', end: '2026-08-15' };

const INPUT: MetricsInput = {
  contacts: [c('pa', 'paid', 600_000, '2026-08-02', 'Summer Shred'), c('pb', 'paid', 400_000, '2026-08-03', 'Summer Shred'), c('og', 'organic', 500_000, '2026-08-03'), c('x1', 'paid', 0, '2026-08-10', 'Summer Shred'), c('x2', null, 0, '2026-08-11')],
  transitions: [
    t('pa', 'applied', 'consult_booked', '2026-08-03'), t('pa', 'consult_booked', 'roadmap_booked', '2026-08-04'), t('pa', 'roadmap_booked', 'roadmap_showed', '2026-08-05'), t('pa', 'roadmap_showed', 'enrolled', '2026-08-06'),
    t('pb', 'applied', 'consult_booked', '2026-08-04'), t('pb', 'consult_booked', 'roadmap_booked', '2026-08-05'), t('pb', 'roadmap_booked', 'enrolled', '2026-08-07'),
    t('og', 'applied', 'consult_booked', '2026-08-04'), t('og', 'consult_booked', 'roadmap_booked', '2026-08-06'), t('og', 'roadmap_booked', 'enrolled', '2026-08-08'),
    t('x1', 'applied', 'consult_booked', '2026-08-12'),
  ],
  appointments: [
    { contactId: 'pa', type: 'Consult', outcome: 'showed', on: '2026-08-03', atMs: noon('2026-08-03') },
    { contactId: 'pb', type: 'Consult', outcome: 'showed', on: '2026-08-04', atMs: noon('2026-08-04') },
    { contactId: 'og', type: 'Consult', outcome: 'no_show', on: '2026-08-04', atMs: noon('2026-08-04') },
    { contactId: 'pa', type: 'Roadmap', outcome: 'showed', on: '2026-08-05', atMs: noon('2026-08-05') },
    { contactId: 'pb', type: 'Roadmap', outcome: null, on: '2026-08-06', atMs: noon('2026-08-06') }, // undecided → roadmap coverage 50% → withheld
    { contactId: 'x1', type: 'Consult', outcome: 'showed', on: '2026-08-13', atMs: noon('2026-08-13') },
  ],
  spend: [
    { date: '2026-08-02', platform: 'meta', currency: 'CAD', spendCents: 60_000, origin: 'meta', level: 'campaign', campaignId: 'c1', campaignName: 'Summer Shred', impressions: 10_000, clicks: 300, leads: 12, reach: 4_000, linkClicks: 200, landingPageViews: 150, purchases: 2 },
    { date: '2026-08-04', platform: 'meta', currency: 'CAD', spendCents: 40_000, origin: 'meta', level: 'campaign', campaignId: 'c1', campaignName: 'Summer Shred', impressions: 8_000, clicks: 200, leads: 8, reach: 3_000, linkClicks: 150, landingPageViews: 100, purchases: 1 },
  ],
  payments: [pay('p-pa', 'pa', 300_000, 'initial', '2026-08-06'), pay('p-pb', 'pb', 200_000, 'initial', '2026-08-07', { refundedCents: 50_000 }), pay('p-og', 'og', 250_000, 'initial', '2026-08-08'), pay('r-pa', 'pa', 50_000, 'recurring', '2026-08-12', { kind: 'invoice' })],
};

const RANGES = [A, B, C, AB];

describe('coverage', () => {
  it('every TREND_METRICS, DISPLAY_METRICS and funnel-stage key has an entry; keys are unique; version is set', () => {
    expect(missingGlossaryKeys()).toEqual([]);
    expect(new Set(GLOSSARY_KEYS).size).toBe(GLOSSARY_KEYS.length);
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(50);
    expect(METRIC_DEFINITION_VERSION).toBe('2026-09-30');
    for (const e of GLOSSARY) {
      expect(e.definition.length).toBeGreaterThan(20);
      expect(e.differsFrom.length).toBeGreaterThan(10);
      expect(e.formula.length).toBeGreaterThan(5);
    }
  });
  it('glossaryText names every key and marks the history-dependent ones', () => {
    const text = glossaryText();
    for (const k of GLOSSARY_KEYS) expect(text).toContain(`(${k})`);
    expect(glossaryText(['consults_booked'])).toContain('History-dependent');
    expect(glossaryText(['enrollments'])).not.toContain('History-dependent');
    expect(glossaryText(['nope'])).toBe('');
  });
  it('maturing flags follow lib/metrics/maturity.ts', () => {
    expect(['consults_booked', 'roadmaps_booked', 'cpl', 'cost_consult', 'cost_roadmap', 'consult_booked', 'roadmap_booked'].every((k) => glossaryEntry(k)!.maturing)).toBe(true);
    expect(['enrollments', 'initial_cash', 'paid_cac', 'blended_cac', 'roas', 'ltv_cac', 'spend', 'consult_show_rate'].some((k) => glossaryEntry(k)!.maturing)).toBe(false);
  });
});

describe('worked() equals the engine, per key × range', () => {
  const trendKeys = TREND_METRICS.map((m) => m.key);
  it.each(RANGES.flatMap((r) => trendKeys.map((k) => [k, r] as const)))('%s on %o matches TREND_METRICS.compute', (key, range) => {
    const metric = TREND_METRICS.find((m) => m.key === key)!;
    expect(glossaryEntry(key)!.worked(INPUT, range).value).toBe(metric.compute(INPUT, range));
  });

  it.each(RANGES.flatMap((r) => (['period', 'cohort'] as const).flatMap((mode) => FUNNEL_STAGES.map((s) => [s.key, mode, r] as const))))('stage %s (%s) on %o matches computeFunnel', (key, mode, range) => {
    const stage = computeFunnel(INPUT, range, mode).stages.find((s) => s.key === key)!;
    const w = glossaryEntry(key)!.worked(INPUT, range, mode);
    expect(w.value).toBe(stage.withheld ? null : stage.count);
    if (stage.withheld) expect(w.reason).toBe(stage.withheld);
  });

  it.each(RANGES)('conversions on %o match the chain (withheld stages spanned)', (range) => {
    const f = computeFunnel(INPUT, range, 'period');
    for (const e of GLOSSARY.filter((x) => x.group === 'conversion' && x.key !== 'applied_to_enrolled')) {
      const to = e.key.replace(/^conv_.*?_(consult_booked|consult_showed|roadmap_booked|roadmap_showed|enrolled)$/, '$1');
      const stage = f.stages.find((s) => s.key === to)!;
      expect(e.worked(INPUT, range).value).toBe(stage.withheld ? null : stage.conversionFromPrevious);
    }
    const cohort = computeFunnel(INPUT, range, 'cohort');
    expect(glossaryEntry('applied_to_enrolled')!.worked(INPUT, range).value).toBe(cohort.stages[0].count === 0 ? null : cohort.stages.find((s) => s.key === 'enrolled')!.shareOfApplied);
  });

  it.each(RANGES)('show rates, MRR, campaign columns and time in stage on %o', (range) => {
    for (const [key, type] of [['consult_show_rate', 'Consult'], ['roadmap_show_rate', 'Roadmap']] as const) {
      expect(glossaryEntry(key)!.worked(INPUT, range).value).toBe(computeShowRates(INPUT, range).find((r) => r.type === type)?.rate ?? null);
    }
    expect(glossaryEntry('mrr')!.worked(INPUT, range).value).toBe(computeRevenueSummary(INPUT, range).mrrCents);
    const rows = computeCampaignTable(INPUT, range);
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    expect(glossaryEntry('impressions')!.worked(INPUT, range).value).toBe(sum((r) => r.impressions));
    expect(glossaryEntry('link_clicks')!.worked(INPUT, range).value).toBe(sum((r) => r.linkClicks));
    expect(glossaryEntry('platform_leads')!.worked(INPUT, range).value).toBe(sum((r) => r.platformLeads));
    expect(glossaryEntry('tracked_applied')!.worked(INPUT, range).value).toBe(sum((r) => r.tracked.applied));
    expect(glossaryEntry('tracked_enrolled')!.worked(INPUT, range).value).toBe(sum((r) => r.tracked.enrolled));
    const spend = sum((r) => r.spendCents);
    const impressions = sum((r) => r.impressions);
    expect(glossaryEntry('cpm')!.worked(INPUT, range).value).toBe(impressions ? Math.round((spend / impressions) * 1000) : null);
    for (const role of ['applied', 'consult_booked', 'roadmap_booked'] as const) {
      const ts = computeTimeInStage(INPUT, range).find((x) => x.role === role);
      expect(glossaryEntry(`time_in_${role}`)!.worked(INPUT, range).value).toBe(ts && ts.samples > 0 ? ts.medianHours : null);
    }
  });
});

describe('worked() text', () => {
  it('Paid CAC reads as the tile formula, to the cent', () => {
    const m = computeMarketing(INPUT, A);
    const w = glossaryEntry('paid_cac')!.worked(INPUT, A);
    expect(m.paidCacCents).toBe(50_000); // $1,000 ÷ 2 paid enrollments
    expect(w.text).toBe(`${formatCents(100_000, 'CAD')} spend ÷ 2 paid enrollments = ${formatCents(50_000, 'CAD')}`);
    expect(w.inputs).toEqual({ spendCents: 100_000, paidEnrollments: 2 });
  });
  it('a metric whose inputs are missing returns null with the reason, never a number', () => {
    expect(glossaryEntry('paid_cac')!.worked(INPUT, B)).toMatchObject({ value: null, reason: 'no spend in the period' });
    expect(glossaryEntry('roadmap_show_rate')!.worked(INPUT, A)).toMatchObject({ value: null, reason: expect.stringContaining('attendance recorded for 50% of roadmaps') });
  });
  it('LTV:CAC shows when every new client has a value and is withheld once one does not', () => {
    expect(glossaryEntry('ltv_cac')!.worked(INPUT, A).value).toBeCloseTo(15, 6); // $15,000 ÷ $1,000
    const withZero: MetricsInput = { ...INPUT, contacts: INPUT.contacts.map((x) => (x.id === 'og' ? { ...x, monetaryValueCents: 0 } : x)) };
    expect(glossaryEntry('ltv_cac')!.worked(withZero, A)).toMatchObject({ value: null, reason: '1 new client has no contract value (OG)' });
  });
});
