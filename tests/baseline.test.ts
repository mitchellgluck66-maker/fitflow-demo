/**
 * THE baseline rule (2026-10-06, after the Oct 4 smoke): for a history-dependent metric the weeks before
 * complete stage history are EXCLUDED from the baseline; a source-dated metric uses every complete week; fewer
 * than 4 usable weeks → a note, never a number. The fixture is the smoke's own evidence: entered-Enrolled per
 * week 0, 1, 2, 12 (a catch-up) in the four pre-history weeks against Stripe first payments 6, 3, 1, 5 — the
 * clean baseline must not see the catch-up week anywhere: chips, get_scorecard, the starter snapshot, the brief,
 * the insight input, the ask context.
 */
import { weekVerdictFor } from '@/lib/metrics/verdict';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanBaseline, trailingBaseline, scorecardBaselines, baselineFamilyOf, BASELINE_MIN_WEEKS } from '@/lib/metrics/baseline';
import { computeScorecard, computeAdsKpis, computeCampaignTable, computeRevenueSummary, type ContactRow, type MetricsInput, type PaymentRow } from '@/lib/metrics';
import { rangeFromParams, resolveComparison, trailingWeeks, weekBuckets } from '@/lib/dates';
import { buildBrief } from '@/lib/analyst/brief';
import { EMPTY_PROFILE } from '@/lib/analyst/notes';
import { buildInsightInput } from '@/lib/metrics/insights';
import { buildAskContext } from '@/lib/metrics/ask';
import { computeMaturity } from '@/lib/metrics/maturity';
import type { ScorecardResult } from '@/lib/metrics/service';

const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
let n = 0;
const enrol = (on: string, paidOn: string | null): { contact: ContactRow; transition: MetricsInput['transitions'][number]; payment: PaymentRow | null } => {
  n += 1;
  const id = `c${n}`;
  return {
    contact: { id, name: id.toUpperCase(), email: null, source: 'Fit Physician Application (Facebook)', stageId: 's', stageName: 'Enrolled', role: 'enrolled', appliedOn: on, monetaryValueCents: 500_000, origin: 'ghl', attribution: 'paid', campaign: 'Broad' },
    transition: { contactId: id, fromRole: 'roadmap_booked' as never, toRole: 'enrolled' as never, toStageId: 'st-enrolled', on, atMs: noon(on) },
    payment: paidOn ? { id: `p${n}`, stripeId: `ch_${n}`, contactId: id, kind: 'charge', currency: 'CAD', amountCents: 300_000, refundedCents: 0, status: 'succeeded', on: paidOn, origin: 'stripe', paymentClass: 'initial' } : null,
  };
};
// Weeks (Sun–Sat): Aug 2, 9, 16, 23 are BEFORE history (complete since Aug 30 — a week that STARTS before the date is excluded whole); Aug 30, Sep 6, 13, 20 are clean; last week = Sep 27 – Oct 3; today Oct 6.
const weeks = ['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20'];
const enrolledPerWeek = [0, 1, 2, 12, 4, 4, 5, 4];
const paidPerWeek = [6, 3, 1, 5, 4, 4, 5, 4];
const rows: ReturnType<typeof enrol>[] = [];
weeks.forEach((w, i) => {
  for (let k = 0; k < Math.max(enrolledPerWeek[i], paidPerWeek[i]); k++) {
    const day = (d: number) => `${w.slice(0, 8)}${String(Number(w.slice(8)) + d).padStart(2, '0')}`;
    const on = day(1 + (k % 5));
    const r = enrol(on, k < paidPerWeek[i] ? on : null);
    if (k >= enrolledPerWeek[i]) r.transition = { ...r.transition, on: '2026-01-01', atMs: noon('2026-01-01') }; // paid but never "entered Enrolled" in that week
    rows.push(r);
  }
});
// Last week: 8 entered Enrolled (GHL), 4 paid.
['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-01', '2026-10-02', '2026-10-02', '2026-10-03'].forEach((d, i) => rows.push(enrol(d, i < 4 ? d : null)));
const INPUT: MetricsInput = {
  contacts: rows.map((r) => r.contact),
  transitions: rows.map((r) => r.transition),
  appointments: [],
  spend: weeks.concat(['2026-09-27']).map((w) => ({ date: w, platform: 'meta', currency: 'CAD' as const, spendCents: 400_000, origin: 'manual' })),
  payments: rows.flatMap((r) => (r.payment ? [r.payment] : [])),
};
const TODAY = '2026-10-06';
const SETTINGS = { historyCompleteSince: '2026-08-30', sunset: '2026-12-31', today: TODAY };

describe('cleanBaseline — the rule', () => {
  const candidate = trailingWeeks('2026-09-27', 8).weeks;
  it('excludes the weeks before complete history for a stage-history metric; keeps every week for a source-dated one', () => {
    const e = cleanBaseline({ candidate, metric: 'enrollments', ...SETTINGS });
    expect(e.family).toBe('stage_history');
    expect(e.weeks.map((w) => w.start)).toEqual(['2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20']);
    expect(e.excluded.map((w) => w.start)).toEqual(['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23']);
    expect(e).toMatchObject({ enough: true, note: null, range: { start: '2026-08-30', end: '2026-09-26' }, summary: '4 weeks (Aug 30 – Sep 26) · 4 maturing weeks excluded (Aug 2–29)' });
    const s = cleanBaseline({ candidate, metric: 'initial_cash', ...SETTINGS });
    expect(s).toMatchObject({ family: 'source_dated', excluded: [], enough: true, summary: '8 weeks (Aug 2 – Sep 26)' });
    expect(s.weeks.length).toBe(8);
    for (const m of ['enrollments', 'paid_cac', 'blended_cac', 'ltv_cac', 'cost_client', 'consults_booked', 'conversions']) expect(baselineFamilyOf(m), m).toBe('stage_history');
    for (const m of ['initial_cash', 'applied', 'roas', 'spend', 'consult_show_rate']) expect(baselineFamilyOf(m), m).toBe('source_dated');
  });
  it('fewer than 4 usable weeks → no range, a note every consumer renders; after the sunset nothing is excluded', () => {
    const late = cleanBaseline({ candidate, metric: 'enrollments', ...SETTINGS, historyCompleteSince: '2026-09-15' });
    expect(late).toMatchObject({ enough: false, range: null, note: 'baseline needs 4 complete weeks of complete stage history; have 1 (Sep 20–26)' });
    expect(late.summary).toContain('7 maturing weeks excluded');
    expect(BASELINE_MIN_WEEKS).toBe(4);
    const sunset = cleanBaseline({ candidate, metric: 'enrollments', ...SETTINGS, today: '2027-01-02' });
    expect(sunset).toMatchObject({ enough: true, excluded: [], summary: '8 weeks (Aug 2 – Sep 26)' });
    expect(trailingBaseline({ before: '2026-09-27', metric: 'enrollments', ...SETTINGS }).candidate.length).toBe(8);
  });
});

describe('the catch-up week never reaches a baseline — every surface', () => {
  const range = rangeFromParams({ start: '2026-09-27', end: '2026-10-03' }, TODAY);
  const comparison = resolveComparison(range, 'previous_period', TODAY);
  const baselines = scorecardBaselines(INPUT, range, SETTINGS);
  const scorecard = computeScorecard(INPUT, range, comparison.range, baselines.stageHistory.range);
  const result: ScorecardResult = {
    timezone: 'America/Edmonton',
    today: TODAY,
    range,
    comparison,
    baseline: { start: '2026-08-02', end: '2026-09-26' },
    baselines,
    verdict: weekVerdictFor(INPUT, range, baselines.sourceDated),
    scorecard,
    trend: { grain: 'day', current: [], comparison: null },
    trendWeekly: { current: [], comparison: null },
    trendWeeklyCohort: { current: [], comparison: null },
    trailingWeeks: [],
    ads: { kpis: computeAdsKpis(INPUT, range), previousKpis: null, campaigns: computeCampaignTable(INPUT, range), previousCampaigns: null },
    revenue: computeRevenueSummary(INPUT, range),
    maturity: computeMaturity({ range, today: TODAY, historyCompleteSince: SETTINGS.historyCompleteSince, sunset: SETTINGS.sunset, comparedWith: [comparison.range, { start: '2026-08-02', end: '2026-09-26' }] }),
    money: { currency: 'CAD', fx: { text: 'displayed in CAD', rate: null, source: null, date: null } as never, unsupportedRows: 0 },
  };

  it('scorecardBaselines: enrollments over the 4 clean weeks (4.25/week — the 12 is absent); Stripe over all 8 (32/8 = 4 new paying clients/week)', () => {
    expect(baselines.averages).toMatchObject({ weeksUsed: 4, weeksExcluded: 4, enrollmentsPerWeek: 4.25, newPayingClientsPerWeek: 4, initialCashPerWeekCents: 1_200_000, spendPerWeekCents: 400_000, note: null });
    expect(baselines.averages.summary).toBe('4 weeks (Aug 30 – Sep 26) · 4 maturing weeks excluded (Aug 2–29)');
    // The dirty average would have been (0+1+2+12+4+4+5+4)/8 = 4 — same number by coincidence; the clean one is 17/4 = 4.25. Check the exclusion itself:
    expect(baselines.stageHistory.excluded.map((w) => w.start)).toEqual(['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23']);
  });
  it('chips are judged against the clean range only; with a late history date they are neutral and the note travels', () => {
    expect(scorecard.conversions.every((c) => c.baseline === null || c.tone !== undefined)).toBe(true);
    const late = scorecardBaselines(INPUT, range, { ...SETTINGS, historyCompleteSince: '2026-09-15' });
    const sc = computeScorecard(INPUT, range, comparison.range, late.stageHistory.range);
    expect(late.stageHistory.range).toBeNull();
    expect(sc.conversions.every((c) => c.baseline === null && c.tone === 'neutral')).toBe(true);
    expect(late.averages).toMatchObject({ enrollmentsPerWeek: null, note: expect.stringMatching(/^baseline needs 4 complete weeks of complete stage history; have 1/) });
  });
  it('the insight input and the ask context carry the clean figures and the exclusion', () => {
    const insight = buildInsightInput(result);
    expect(insight.baseline).toMatchObject({ enrollmentsPerWeek: 4.25, newPayingClientsPerWeek: 4, stageHistory: '4 weeks (Aug 30 – Sep 26) · 4 maturing weeks excluded (Aug 2–29)' });
    expect(insight.baseline.note).toContain('CLEAN stage-history baseline');
    const ask = buildAskContext(result);
    expect(JSON.stringify(ask)).toContain('4 maturing weeks excluded');
  });
  it('the brief: stage-history averages over the clean weeks, source-dated over all; the maturing weeks are named as excluded', () => {
    const brief = buildBrief({ timezone: 'America/Edmonton', today: TODAY, input: INPUT, firstData: '2026-08-02', historyCompleteSince: '2026-08-30', disclaimerSunset: '2026-12-31', profile: EMPTY_PROFILE, notes: [] });
    const line = brief.text.split('\n').find((l) => l.startsWith('- Trailing 8 weeks'))!;
    // The trailing 8 COMPLETE weeks before today (Oct 6) are Aug 9 – Oct 3: 3 maturing (Aug 9, 16, 23) + 5 clean.
    expect(line).toContain('stage-history metrics over 5 weeks (Aug 30 – Oct 3) · 3 maturing weeks excluded (Aug 9–29)');
    expect(line).toMatch(/enrolled 5\.0\/week/); // (4+4+5+4+8)/5 — the 12 never enters
    expect(line).toMatch(/Source-dated metrics over 8 weeks \(Aug 9 – Oct 3\) — applied [\d.]+\/week · new paying clients \(Stripe first payments\) 3\.8\/week/); // (3+1+5+4+4+5+4+4)/8 = 3.75
    expect(line).toContain('the GHL "enrolled" count of a maturing week is never a baseline');
  });
});

describe('no caller builds a baseline outside lib/metrics/baseline.ts', () => {
  it('trailingWeeks( is called only by baseline.ts (and lib/dates itself)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p) && fs.readFileSync(p, 'utf8').includes('trailingWeeks(') && !p.endsWith('lib/metrics/baseline.ts') && !p.endsWith('lib/dates/index.ts')) offenders.push(p);
      }
    };
    for (const d of ['lib', 'app', 'components', 'scripts']) walk(d);
    expect(offenders).toEqual([]);
    expect(weekBuckets('2026-08-02', '2026-08-08').length).toBe(1);
  });
});

describe('1c — GHL enrolled entries vs Stripe first payments', () => {
  it('last week: 8 entered Enrolled, 4 paid — both shown, the unpaid named; a paid contact with no enrolled entry is named too', async () => {
    const { computeEnrollmentReconciliation } = await import('@/lib/metrics');
    const r = computeEnrollmentReconciliation(INPUT, { start: '2026-09-27', end: '2026-10-03' });
    expect(r).toMatchObject({ enrolledInGhl: 8, paidInStripe: 4, paidUnmatched: 0, reason: null });
    expect(r.enrolledUnpaid.length).toBe(4);
    expect(r.text).toMatch(/^8 enrolled in GHL, 4 have paid · unpaid: C\d+, C\d+, C\d+, C\d+$/);
    // Aug 2–8: 0 enrolled entries, 6 first payments (the catch-up case from the other side)
    const aug = computeEnrollmentReconciliation(INPUT, { start: '2026-08-02', end: '2026-08-08' });
    expect(aug).toMatchObject({ enrolledInGhl: 0, paidInStripe: 6 });
    expect(aug.paidNotEnrolled.length).toBe(6);
    expect(aug.text).toContain('0 enrolled in GHL, 6 have paid · paid without an enrolled entry this period:');
    // No Stripe → no comparison, the reason stated
    const none = computeEnrollmentReconciliation({ ...INPUT, payments: [] }, { start: '2026-09-27', end: '2026-10-03' });
    expect(none).toMatchObject({ enrolledInGhl: 8, paidInStripe: null, reason: 'Stripe not connected' });
    // an unmatched first payment is counted, never silently dropped
    const unmatched = computeEnrollmentReconciliation({ ...INPUT, payments: [...INPUT.payments, { ...INPUT.payments[0], id: 'u1', stripeId: 'ch_u1', contactId: null, on: '2026-09-30' }] }, { start: '2026-09-27', end: '2026-10-03' });
    expect(unmatched).toMatchObject({ paidInStripe: 5, paidUnmatched: 1 });
    expect(unmatched.text).toContain('1 first payment not matched to a contact');
    // the scorecard carries it
    expect(scorecardResultFor().scorecard.enrollmentReconciliation.text).toMatch(/^8 enrolled in GHL, 4 have paid/);
  });
});

function scorecardResultFor() {
  const range = rangeFromParams({ start: '2026-09-27', end: '2026-10-03' }, TODAY);
  return { scorecard: computeScorecard(INPUT, range, null, null) };
}
