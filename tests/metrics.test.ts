/**
 * Hand-computed fixture for the metrics engine. Every expected number below
 * was worked out by hand from the rows — if a formula changes, this file is
 * the contract that has to change with it.
 *
 * Range R  = Sun 2026-08-02 … Sat 2026-08-08
 * Range P  = Sun 2026-07-26 … Sat 2026-08-01 (previous period)
 */
import { describe, it, expect } from 'vitest';
import {
  computeFunnel,
  computeCac,
  computeRevenue,
  computeShowRates,
  computeSourceBreakdown,
  computeTimeInStage,
  computeDelta,
  conversionTone,
  computeTrend,
  computeTodoBuckets,
  computeScorecard,
  computeSpend,
  formatCents,
  formatDelta,
  type MetricsInput,
} from '@/lib/metrics';

const R = { start: '2026-08-02', end: '2026-08-08' };
const P = { start: '2026-07-26', end: '2026-08-01' };

const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const t = (contactId: string, fromRole: string | null, toRole: string, on: string) => ({
  contactId,
  fromRole: fromRole as never,
  toRole: toRole as never,
  toStageId: `st-${toRole}`,
  on,
  atMs: noon(on),
});
const a = (contactId: string, type: string, outcome: string | null, on: string) => ({ contactId, type, outcome, on, atMs: noon(on) });
const c = (id: string, name: string, source: string | null, appliedOn: string, role: string) => ({
  id,
  name,
  email: `${name.toLowerCase()}@example.com`,
  source,
  stageId: `st-${role}`,
  stageName: role,
  role: role as never,
  appliedOn,
  monetaryValueCents: 0,
  origin: 'ghl',
});

const FIXTURE: MetricsInput = {
  contacts: [
    c('c1', 'Ann', 'Facebook', '2026-08-03', 'enrolled'),
    c('c2', 'Bob', 'Facebook', '2026-08-04', 'consult_noshow'),
    c('c3', 'Cal', 'Google', '2026-08-05', 'applied'),
    c('c4', 'Dee', 'Referral', '2026-08-06', 'consult_booked'),
    c('c5', 'Eve', 'Facebook', '2026-07-28', 'roadmap_booked'),
    c('c6', 'Fay', 'Google', '2026-07-30', 'consult_booked'),
    c('c7', 'Gus', null, '2026-06-01', 'enrolled'),
    c('c8', 'Hal', 'Google', '2026-08-04', 'applied'),
  ],
  transitions: [
    t('c1', null, 'applied', '2026-08-03'),
    t('c1', 'applied', 'consult_booked', '2026-08-04'),
    t('c1', 'consult_booked', 'roadmap_booked', '2026-08-06'),
    t('c1', 'roadmap_booked', 'enrolled', '2026-08-08'),
    t('c2', null, 'applied', '2026-08-04'),
    t('c2', 'applied', 'consult_booked', '2026-08-05'),
    t('c4', null, 'applied', '2026-08-06'),
    t('c4', 'applied', 'consult_booked', '2026-08-07'),
    t('c5', null, 'applied', '2026-07-28'),
    t('c5', 'applied', 'consult_booked', '2026-07-29'),
    t('c5', 'consult_booked', 'roadmap_booked', '2026-08-03'),
    t('c6', null, 'applied', '2026-07-30'),
    t('c6', 'applied', 'consult_booked', '2026-07-31'),
    t('c7', null, 'enrolled', '2026-08-05'),
    t('c8', null, 'applied', '2026-08-04'),
  ],
  appointments: [
    a('c1', 'Consult', 'showed', '2026-08-05'),
    a('c1', 'Roadmap', 'showed', '2026-08-07'),
    a('c2', 'Consult', 'no_show', '2026-08-06'),
    a('c4', 'Consult', null, '2026-08-10'),
    a('c5', 'Consult', 'showed', '2026-07-31'),
    a('c5', 'Roadmap', 'no_show', '2026-08-05'),
    a('c6', 'Consult', 'cancelled', '2026-08-02'),
  ],
  spend: [
    { date: '2026-08-02', platform: 'meta', currency: 'CAD' as const, spendCents: 100_000, origin: 'manual' },
    { date: '2026-08-02', platform: 'google', currency: 'CAD' as const, spendCents: 20_000, origin: 'manual' },
    { date: '2026-07-26', platform: 'meta', currency: 'CAD' as const, spendCents: 50_000, origin: 'manual' },
  ],
  payments: [],
};

describe('computeFunnel', () => {
  const f = computeFunnel(FIXTURE, R);
  const stage = (k: string) => f.stages.find((s) => s.key === k)!;

  it('counts each stage by the definitions', () => {
    expect(f.stages.map((s) => [s.key, s.count])).toEqual([
      ['applied', 5], // c1 c2 c3 c4 c8
      ['consult_booked', 3], // c1 c2 c4 entered in R (c5/c6 entered in P)
      ['consult_showed', 1], // c1 (c5 showed in P)
      ['roadmap_booked', 2], // c1, c5 (entered 08-03)
      ['roadmap_showed', 1], // c1 (c5 was a no-show)
      ['enrolled', 2], // c1 + c7
    ]);
    expect(stage('applied').contactIds.sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c8']);
    expect(stage('enrolled').contactIds.sort()).toEqual(['c1', 'c7']);
  });

  it('derives conversion, share, drop-off and cost per stage', () => {
    expect(f.spendCents).toBe(120_000);
    expect(stage('consult_booked').conversionFromPrevious).toBeCloseTo(0.6);
    expect(stage('consult_showed').conversionFromPrevious).toBeCloseTo(1 / 3);
    // 2 ÷ 1 in period mode: capped at 100% and flagged (audit P1 #3) — the same people are not being compared
    expect(stage('roadmap_booked').conversionFromPrevious).toBe(1);
    expect(stage('roadmap_booked').capped).toBe(true);
    expect(stage('consult_booked').capped).toBe(false);
    expect(stage('enrolled').shareOfApplied).toBeCloseTo(0.4);
    expect(f.stages.map((s) => s.dropOff)).toEqual([0, 2, 2, 0, 1, 0]);
    expect(f.stages.map((s) => s.conversionFrom)).toEqual([null, 'applied', 'consult_booked', 'consult_showed', 'roadmap_booked', 'roadmap_showed']);
    expect(f.stages.map((s) => s.costPerCents)).toEqual([24_000, 40_000, 120_000, 60_000, 120_000, 60_000]);
  });

  it('returns nulls, not zeros, when a denominator is empty', () => {
    const empty = computeFunnel(FIXTURE, { start: '2025-01-01', end: '2025-01-31' });
    expect(empty.stages.every((s) => s.count === 0 && s.costPerCents === null && s.shareOfApplied === null)).toBe(true);
    expect(empty.stages[1].conversionFromPrevious).toBeNull();
  });
});

describe('spend, CAC and revenue', () => {
  it('sums spend inside the range only', () => {
    expect(computeSpend(FIXTURE.spend, R)).toBe(120_000);
    expect(computeSpend(FIXTURE.spend, P)).toBe(50_000);
  });

  it('an API row replaces the manual fallback for its date only', () => {
    const spend = [
      ...FIXTURE.spend,
      { date: '2026-08-04', platform: 'meta', currency: 'CAD' as const, spendCents: 90_000, origin: 'meta' }, // real Meta row, one day
    ];
    // manual meta 100,000 ÷ 7 = 14,285 r5 → Sunday 14,290; Tue Aug 4 replaced by 90,000
    // meta: 100,000 − 14,285 + 90,000 = 175,715; google manual 20,000 untouched
    expect(computeSpend(spend, R)).toBe(195_715);
  });

  it('CAC = spend ÷ enrollments; null when no enrollments', () => {
    expect(computeCac(FIXTURE, R)).toEqual({ spendCents: 120_000, enrollments: 2, cacCents: 60_000, noSpendData: false, currency: 'CAD' });
    expect(computeCac(FIXTURE, P)).toMatchObject({ spendCents: 50_000, enrollments: 0, cacCents: null });
  });

  it('revenue is "awaiting Stripe" until Stripe rows exist — never a fake 0 ROAS', () => {
    const r = computeRevenue(FIXTURE, R);
    expect(r).toMatchObject({ awaitingStripe: true, roas: null, collectedCents: 0 });
  });

  it('revenue and ROAS from Stripe rows — initial cash only, net of refunds', () => {
    const withStripe: MetricsInput = {
      ...FIXTURE,
      payments: [
        { contactId: 'c1', currency: 'CAD' as const, amountCents: 250_000, refundedCents: 0, status: 'succeeded', on: '2026-08-05', origin: 'stripe', paymentClass: 'initial' },
        // Fully refunded: the 50,000 was never kept, so it nets to 0 (not −50,000).
        { contactId: 'c7', currency: 'CAD' as const, amountCents: 50_000, refundedCents: 50_000, status: 'refunded', on: '2026-08-06', origin: 'stripe', paymentClass: null },
        { contactId: 'c1', currency: 'CAD' as const, amountCents: 19_900, refundedCents: 0, status: 'succeeded', on: '2026-08-07', origin: 'stripe', kind: 'invoice', paymentClass: 'recurring' },
        { contactId: null, currency: 'CAD' as const, amountCents: 99_900, refundedCents: 0, status: 'failed', on: '2026-08-07', origin: 'stripe' },
        { contactId: null, currency: 'CAD' as const, amountCents: 999_900, refundedCents: 0, status: 'succeeded', on: '2026-07-01', origin: 'stripe', paymentClass: 'initial' }, // out of range
      ],
    };
    const r = computeRevenue(withStripe, R);
    expect(r).toMatchObject({
      awaitingStripe: false,
      initialCents: 250_000,
      recurringCents: 19_900,
      collectedCents: 269_900,
      paymentCount: 2,
      failedCount: 1,
      refundedCents: 50_000,
    });
    expect(r.roas).toBeCloseTo(250_000 / 120_000);
  });
});

describe('show rates', () => {
  it('per appointment type: showed ÷ (showed + no-show); cancelled excluded', () => {
    // Every past appointment in the fixture has an outcome → coverage 100% → the rate is shown.
    expect(computeShowRates(FIXTURE, R)).toEqual([
      { type: 'Consult', showed: 1, noShow: 1, cancelled: 1, undecided: 0, past: 3, coverage: 1, rate: 0.5, withheld: null },
      { type: 'Roadmap', showed: 1, noShow: 1, cancelled: 0, undecided: 0, past: 2, coverage: 1, rate: 0.5, withheld: null },
    ]);
  });

  // F2 (2026-09-30): the real Sep 20–26 shape — 0 showed, 2 no-shows, 62 past consults with no outcome. The old
  // rule printed 0%; a rate is shown only when ≥ 90% of past appointments of the type have an outcome.
  const WEEK = { start: '2026-09-20', end: '2026-09-26' };
  const appt = (i: number, outcome: string | null, on = '2026-09-22') => ({ contactId: `c${i}`, type: 'Consult', outcome, on, atMs: Date.parse(`${on}T18:00:00Z`) });
  const shape = (undecided: number): MetricsInput => ({
    ...FIXTURE,
    appointments: [appt(1, 'no_show'), appt(2, 'no_show'), ...Array.from({ length: undecided }, (_, i) => appt(100 + i, null))],
  });

  it('Sep 20–26: 0 showed + 2 no-shows + 62 undecided → coverage 3% → rate NULL with the reason, never 0%', () => {
    const [consult] = computeShowRates(shape(62), WEEK);
    expect(consult).toMatchObject({ showed: 0, noShow: 2, undecided: 62, past: 64, rate: null });
    expect(consult.coverage).toBeCloseTo(2 / 64);
    expect(consult.withheld).toBe('attendance recorded for 3% of consults (2 of 64) — show rate needs 90%');
  });

  it('the funnel withholds "Consult showed" and the per-source consult show rate with the same reason', () => {
    const f = computeFunnel(shape(62), WEEK);
    expect(f.stages.find((s) => s.key === 'consult_showed')?.withheld).toBe('attendance recorded for 3% of consults (2 of 64) — show rate needs 90%');
    expect(computeSourceBreakdown(shape(62), WEEK).every((s) => s.consultShowRate === null)).toBe(true);
  });

  it('exactly at 90% coverage the rate is shown; future appointments are not "past"', () => {
    const covered: MetricsInput = { ...FIXTURE, appointments: [...Array.from({ length: 9 }, (_, i) => appt(i, i < 6 ? 'showed' : 'no_show')), appt(50, null)] };
    expect(computeShowRates(covered, WEEK)[0]).toMatchObject({ coverage: 0.9, rate: 6 / 9, withheld: null });
    const withFuture: MetricsInput = { ...covered, appointments: [...covered.appointments, appt(60, null, '2026-09-26')], asOfMs: Date.parse('2026-09-24T00:00:00Z') };
    expect(computeShowRates(withFuture, WEEK)[0]).toMatchObject({ past: 10, coverage: 0.9, withheld: null });
  });
});

describe('per-source breakdown', () => {
  it('splits the funnel by attribution source', () => {
    const s = computeSourceBreakdown(FIXTURE, R);
    expect(s.map((x) => x.source)).toEqual(['Facebook', 'Google', 'Referral', 'Unknown']);
    expect(s[0].counts).toEqual({ applied: 2, consult_booked: 2, consult_showed: 1, roadmap_booked: 2, roadmap_showed: 1, enrolled: 1 });
    expect(s[0].appliedToEnrolled).toBe(0.5);
    expect(s[0].consultShowRate).toBe(0.5);
    expect(s[1].counts).toMatchObject({ applied: 2, enrolled: 0 });
    expect(s[1].appliedToEnrolled).toBe(0);
    expect(s[3].counts.enrolled).toBe(1); // Gus has no source
    expect(s[3].appliedToEnrolled).toBeNull();
  });
});

describe('time in stage', () => {
  it('measures duration in the stage being left, for exits inside the range', () => {
    const tis = computeTimeInStage(FIXTURE, R);
    expect(tis).toEqual([
      { role: 'applied', samples: 3, medianHours: 24, meanHours: 24 }, // c1, c2, c4 — all 24h
      { role: 'consult_booked', samples: 2, medianHours: 84, meanHours: 84 }, // c1 48h, c5 120h (exit 08-03 in R)
      { role: 'roadmap_booked', samples: 1, medianHours: 48, meanHours: 48 }, // c1
    ]);
  });
});

describe('deltas and chip tones', () => {
  it('computes abs/pct/direction and inverts for cost metrics', () => {
    expect(computeDelta(3, 2)).toMatchObject({ abs: 1, pct: 0.5, direction: 'up', good: true });
    expect(computeDelta(60_000, 80_000, true)).toMatchObject({ abs: -20_000, pct: -0.25, direction: 'down', good: true });
    expect(computeDelta(80_000, 60_000, true)).toMatchObject({ direction: 'up', good: false });
    expect(computeDelta(2, 0)).toMatchObject({ abs: 2, pct: null, direction: 'up' });
    expect(computeDelta(2, 2)).toMatchObject({ abs: 0, direction: 'flat', good: null });
    expect(computeDelta(null, 5)).toMatchObject({ abs: null, direction: 'none', good: null });
  });

  it('colours conversions against the trailing baseline', () => {
    expect(conversionTone(0.9, 0.8)).toBe('good');
    expect(conversionTone(0.75, 0.8)).toBe('ok'); // 93.75% of baseline
    expect(conversionTone(0.6, 0.8)).toBe('warn');
    expect(conversionTone(null, 0.8)).toBe('neutral');
    expect(conversionTone(0.5, 0)).toBe('neutral');
  });
});

describe('trend', () => {
  it('produces one point per Sun–Sat bucket', () => {
    const trend = computeTrend(FIXTURE, [
      { ...P, label: 'Jul 26 – Aug 1' },
      { ...R, label: 'Aug 2–8' },
    ]);
    expect(trend.map((p) => [p.applied, p.consultsBooked, p.enrolled, p.spendCents, p.cacCents])).toEqual([
      [2, 2, 0, 50_000, null],
      [5, 3, 2, 120_000, 60_000],
    ]);
  });
});

describe('daily to-do buckets', () => {
  it('Day-1 / Day-3 × applied-no-booking, consult no-show, roadmap no-show', () => {
    const b = computeTodoBuckets(FIXTURE, '2026-08-07');
    // Day-1 → 2026-08-06: Bob no-showed his consult and has not rebooked.
    expect(b.day1.consult_noshow.map((p) => p.name)).toEqual(['Bob']);
    expect(b.day1.applied_no_booking).toEqual([]); // Dee applied 08-06 but is already consult_booked
    expect(b.day1.roadmap_noshow).toEqual([]);
    // Day-3 → 2026-08-04: Hal applied, still in applied, no consult on the books.
    expect(b.day3.applied_no_booking.map((p) => p.name)).toEqual(['Hal']);
    expect(b.day3.consult_noshow).toEqual([]);
    expect(b.total).toBe(2);
  });

  it('roadmap no-shows surface the next day; a rebook removes them', () => {
    const b = computeTodoBuckets(FIXTURE, '2026-08-06');
    expect(b.day1.roadmap_noshow.map((p) => p.name)).toEqual(['Eve']);

    const rebooked: MetricsInput = {
      ...FIXTURE,
      appointments: [...FIXTURE.appointments, a('c5', 'Roadmap', null, '2026-08-09')],
    };
    expect(computeTodoBuckets(rebooked, '2026-08-06').day1.roadmap_noshow).toEqual([]);
  });

  it('is empty when nothing happened', () => {
    expect(computeTodoBuckets(FIXTURE, '2026-09-30').total).toBe(0);
  });

  it('the roadmap_noshow / consult_noshow stage roles feed the no-show buckets without an appointment outcome', () => {
    const withRoles: MetricsInput = {
      ...FIXTURE,
      contacts: [
        ...FIXTURE.contacts,
        c('n1', 'Ned', 'Facebook', '2026-08-01', 'roadmap_noshow'), // moved into Roadmap No Show on 08-06, no appointment row
        c('n2', 'Nia', 'Google', '2026-08-01', 'consult_noshow'), // moved on 08-04 (Day-3 on 08-07)
        c('n3', 'Nox', null, '2026-08-01', 'roadmap_noshow'), // moved on 08-06 but has a later Roadmap booked → skip
      ],
      transitions: [
        ...FIXTURE.transitions,
        t('n1', 'roadmap_booked', 'roadmap_noshow', '2026-08-06'),
        t('n2', 'consult_booked', 'consult_noshow', '2026-08-04'),
        t('n3', 'roadmap_booked', 'roadmap_noshow', '2026-08-06'),
      ],
      appointments: [...FIXTURE.appointments, a('n3', 'Roadmap', null, '2026-08-09')],
    };
    const b = computeTodoBuckets(withRoles, '2026-08-07');
    expect(b.day1.roadmap_noshow.map((p) => p.name)).toEqual(['Ned']);
    expect(b.day3.consult_noshow.map((p) => p.name)).toEqual(['Nia']);
    // Bob (appointment no-show, 08-06) is still there and not duplicated by his role.
    expect(b.day1.consult_noshow.map((p) => p.name)).toEqual(['Bob']);
    expect(b.total).toBe(4);
  });

  it('awaiting rebook: everyone in a rescheduled role, every day, dated from when they entered it', () => {
    const withResched: MetricsInput = {
      ...FIXTURE,
      contacts: [
        ...FIXTURE.contacts,
        c('r1', 'Ria', 'Facebook', '2026-08-01', 'consult_rescheduled'),
        c('r2', 'Rob', 'Google', '2026-07-20', 'roadmap_rescheduled'),
        c('r3', 'Rue', null, '2026-08-02', 'consult_rescheduled'),
      ],
      transitions: [
        ...FIXTURE.transitions,
        t('r1', 'consult_booked', 'consult_rescheduled', '2026-08-03'),
        t('r2', 'roadmap_booked', 'roadmap_rescheduled', '2026-07-25'),
        t('r2', 'roadmap_rescheduled', 'roadmap_booked', '2026-07-28'),
        t('r2', 'roadmap_booked', 'roadmap_rescheduled', '2026-08-05'), // latest entry wins
        // r3 has no transition into the role → falls back to applied date
      ],
    };
    const day = (d: string) => computeTodoBuckets(withResched, d);
    const b = day('2026-08-07');
    expect(b.awaitingRebook.consult_rescheduled.map((p) => [p.name, p.on, p.daysWaiting])).toEqual([
      ['Rue', '2026-08-02', 5],
      ['Ria', '2026-08-03', 4],
    ]);
    expect(b.awaitingRebook.roadmap_rescheduled.map((p) => [p.name, p.on, p.daysWaiting])).toEqual([['Rob', '2026-08-05', 2]]);
    expect(b.total).toBe(2 + 3); // Day-1/Day-3 (Bob, Hal) + 3 awaiting rebook
    // Still there the next day — and the day after — until they leave the role.
    expect(day('2026-08-08').awaitingRebook.consult_rescheduled).toHaveLength(2);
    expect(day('2026-08-20').awaitingRebook.roadmap_rescheduled[0].daysWaiting).toBe(15);
    // Leaving the role drops them immediately.
    const rebooked: MetricsInput = { ...withResched, contacts: withResched.contacts.map((x) => (x.id === 'r1' ? { ...x, role: 'consult_booked' as never } : x)) };
    expect(computeTodoBuckets(rebooked, '2026-08-08').awaitingRebook.consult_rescheduled.map((p) => p.name)).toEqual(['Rue']);
  });
});

describe('previous leads (parked)', () => {
  const parked: MetricsInput = {
    ...FIXTURE,
    contacts: [
      ...FIXTURE.contacts,
      c('pl1', 'Pat', 'Facebook', '2026-08-03', 'previous_lead'), // applied in R, then parked in R
      c('pl2', 'Pam', 'Google', '2026-05-01', 'previous_lead'), // old lead parked in R
    ],
    transitions: [
      ...FIXTURE.transitions,
      t('pl1', null, 'applied', '2026-08-03'),
      t('pl1', 'applied', 'consult_booked', '2026-08-04'),
      t('pl1', 'consult_booked', 'previous_lead', '2026-08-06'),
      t('pl2', 'applied', 'previous_lead', '2026-08-05'),
    ],
  };

  it('counts entries into previous_lead as their own row, outside the stage chain', () => {
    const f = computeFunnel(parked, R);
    expect(f.previousLeads).toEqual({ count: 2, contactIds: ['pl1', 'pl2'] });
    expect(f.stages.map((s) => s.key)).not.toContain('previous_lead');
  });

  it('a genuine applicant parked later still counts for what they did; an imported old lead never enters the stages', () => {
    const f = computeFunnel(parked, R);
    const base = computeFunnel(FIXTURE, R);
    // pl1 applied and booked a consult in R before being parked → +1 applied, +1 consult_booked.
    // pl2 was parked from her first observed move → excluded everywhere.
    expect(f.stages.map((s) => [s.key, s.count])).toEqual(base.stages.map((s) => [s.key, s.key === 'applied' || s.key === 'consult_booked' ? s.count + 1 : s.count]));
  });

  it('a contact with no history sitting in previous_lead is treated as parked', () => {
    const noHistory: MetricsInput = { ...FIXTURE, contacts: [...FIXTURE.contacts, c('pl3', 'Pax', null, '2026-08-04', 'previous_lead')] };
    expect(computeFunnel(noHistory, R).stages[0].count).toBe(computeFunnel(FIXTURE, R).stages[0].count);
  });

  it('nothing parked → empty row', () => {
    expect(computeFunnel(FIXTURE, R).previousLeads).toEqual({ count: 0, contactIds: [] });
  });
});

describe('scorecard (what tiles + emails render)', () => {
  const s = computeScorecard(FIXTURE, R, P, null);

  it('assembles KPI deltas from the same functions', () => {
    expect(s.kpis.enrollments).toMatchObject({ current: 2, previous: 0, abs: 2, direction: 'up' });
    expect(s.kpis.consultsBooked).toMatchObject({ current: 3, previous: 2, pct: 0.5 });
    expect(s.kpis.applied).toMatchObject({ current: 5, previous: 2, pct: 1.5 });
    expect(s.kpis.cacCents).toMatchObject({ current: 60_000, previous: null, direction: 'none' });
    expect(s.kpis.revenueCents).toMatchObject({ current: null, direction: 'none' });
    expect(s.kpis.initialCents).toMatchObject({ current: null, direction: 'none' });
    expect(s.kpis.roas.current).toBeNull();
    expect(s.revenue.awaitingStripe).toBe(true);
    expect(s.empty).toBe(false);
  });

  it('conversion chips fall back to the comparison period when no baseline is given', () => {
    const first = s.conversions[0];
    expect(first).toMatchObject({ from: 'applied', to: 'consult_booked', current: 0.6, previous: 1 });
    expect(first.tone).toBe('warn');
  });

  it('flags an empty period so digests skip sending', () => {
    expect(computeScorecard(FIXTURE, { start: '2025-01-01', end: '2025-01-07' }, null, null).empty).toBe(true);
  });
});

describe('formatting shared by UI and email', () => {
  it('formats cents, percentages and deltas consistently', () => {
    // Money is never rendered without its currency (C1).
    expect(formatCents(60_000, 'CAD')).toBe('$600 CAD');
    expect(formatCents(123_456, 'USD')).toBe('$1,234.56 USD');
    expect(formatCents(1_250_000, 'CAD', { compact: true })).toBe('$12.5k CAD');
    expect(formatCents(-5_000, 'CAD')).toBe('-$50 CAD');
    expect(formatCents(null, 'CAD')).toBe('—');
    expect(formatDelta(computeDelta(3, 2))).toBe('+1 (+50%)');
    expect(formatDelta(computeDelta(60_000, 80_000, true), 'cents', 'CAD')).toBe('−$200 CAD (−25%)');
    expect(() => formatDelta(computeDelta(1, 2), 'cents', undefined as unknown as 'CAD')).toThrow(/currency/);
    expect(formatDelta(computeDelta(2, 0))).toBe('+2');
    expect(formatDelta(computeDelta(null, 1))).toBe('—');
  });
});
