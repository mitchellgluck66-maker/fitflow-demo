/**
 * Phase G item 5 — cohort (journey) funnel mode, cross-week fixture.
 *
 * W1 = Sun 2026-08-02 … Sat 2026-08-08
 * W2 = Sun 2026-08-09 … Sat 2026-08-15
 * W3 = Sun 2026-08-16 … Sat 2026-08-22
 */
import { describe, it, expect } from 'vitest';
import { computeFunnel, cohortMembership, funnelMembership, computeScorecard, computeTrend, computeSourceBreakdown, type MetricsInput } from '@/lib/metrics';

const W1 = { start: '2026-08-02', end: '2026-08-08' };
const W2 = { start: '2026-08-09', end: '2026-08-15' };
const W3 = { start: '2026-08-16', end: '2026-08-22' };
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const t = (contactId: string, fromRole: string | null, toRole: string, on: string) => ({ contactId, fromRole: fromRole as never, toRole: toRole as never, toStageId: `st-${toRole}`, on, atMs: noon(on) });
const a = (contactId: string, type: string, outcome: string | null, on: string) => ({ contactId, type, outcome, on, atMs: noon(on) });
const c = (id: string, source: string, appliedOn: string, role: string) => ({
  id,
  name: id.toUpperCase(),
  email: `${id}@example.com`,
  source,
  stageId: `st-${role}`,
  stageName: role,
  role: role as never,
  appliedOn,
  monetaryValueCents: 0,
  origin: 'ghl',
});

const INPUT: MetricsInput = {
  contacts: [
    c('slow', 'Facebook', '2026-08-03', 'enrolled'), // applied W1, consult W2, roadmap + enrolled W3
    c('fast', 'Facebook', '2026-08-04', 'enrolled'), // applied + everything in W1
    c('stall', 'Google', '2026-08-05', 'consult_booked'), // applied W1, booked W2, nothing since
    c('w2', 'Google', '2026-08-10', 'roadmap_booked'), // applied W2, roadmap W3
    c('old', 'Referral', '2026-07-01', 'enrolled'), // applied long ago, enrolled in W1 — period only
  ],
  transitions: [
    t('slow', null, 'applied', '2026-08-03'),
    t('slow', 'applied', 'consult_booked', '2026-08-11'),
    t('slow', 'consult_booked', 'roadmap_booked', '2026-08-17'),
    t('slow', 'roadmap_booked', 'enrolled', '2026-08-20'),
    t('fast', null, 'applied', '2026-08-04'),
    t('fast', 'applied', 'consult_booked', '2026-08-05'),
    t('fast', 'consult_booked', 'roadmap_booked', '2026-08-06'),
    t('fast', 'roadmap_booked', 'enrolled', '2026-08-08'),
    t('stall', null, 'applied', '2026-08-05'),
    t('stall', 'applied', 'consult_booked', '2026-08-12'),
    t('w2', null, 'applied', '2026-08-10'),
    t('w2', 'applied', 'consult_booked', '2026-08-12'),
    t('w2', 'consult_booked', 'roadmap_booked', '2026-08-18'),
    t('old', null, 'applied', '2026-07-01'),
    t('old', 'applied', 'enrolled', '2026-08-06'),
  ],
  appointments: [
    a('slow', 'Consult', 'showed', '2026-08-13'),
    a('slow', 'Roadmap', 'showed', '2026-08-19'),
    a('fast', 'Consult', 'showed', '2026-08-06'),
    a('fast', 'Roadmap', 'showed', '2026-08-07'),
    a('stall', 'Consult', 'no_show', '2026-08-14'),
    a('w2', 'Consult', 'showed', '2026-08-14'),
  ],
  spend: [{ date: '2026-08-02', platform: 'meta', spendCents: 60_000, origin: 'manual' }],
  payments: [],
};

const counts = (f: ReturnType<typeof computeFunnel>) => Object.fromEntries(f.stages.map((s) => [s.key, s.count]));

describe('cohort membership vs in-period membership', () => {
  it('W1 cohort: three applicants, and everything they reached since — no time cutoff', () => {
    const m = cohortMembership(INPUT, W1);
    expect(m.applied.sort()).toEqual(['fast', 'slow', 'stall']);
    expect(m.consult_booked.sort()).toEqual(['fast', 'slow', 'stall']);
    expect(m.consult_showed.sort()).toEqual(['fast', 'slow']);
    expect(m.roadmap_booked.sort()).toEqual(['fast', 'slow']);
    expect(m.roadmap_showed.sort()).toEqual(['fast', 'slow']);
    expect(m.enrolled.sort()).toEqual(['fast', 'slow']); // slow enrolled in W3 but belongs to W1's cohort
  });

  it('W1 in period: only events that happened in W1, whoever they belong to', () => {
    const m = funnelMembership(INPUT, W1);
    expect(m.applied.sort()).toEqual(['fast', 'slow', 'stall']);
    expect(m.consult_booked).toEqual(['fast']);
    expect(m.enrolled.sort()).toEqual(['fast', 'old']); // old applied in July, enrolled in W1
  });

  it('W3 cohort is empty (nobody applied) while W3 in period has the enrollment and roadmap moves', () => {
    expect(counts(computeFunnel(INPUT, W3, 'cohort'))).toEqual({ applied: 0, consult_booked: 0, consult_showed: 0, roadmap_booked: 0, roadmap_showed: 0, enrolled: 0 });
    expect(counts(computeFunnel(INPUT, W3, 'period'))).toEqual({ applied: 0, consult_booked: 0, consult_showed: 0, roadmap_booked: 2, roadmap_showed: 1, enrolled: 1 });
  });

  it('W2 cohort follows w2 into W3', () => {
    expect(counts(computeFunnel(INPUT, W2, 'cohort'))).toEqual({ applied: 1, consult_booked: 1, consult_showed: 1, roadmap_booked: 1, roadmap_showed: 0, enrolled: 0 });
  });
});

describe('computeFunnel in cohort mode', () => {
  const f = computeFunnel(INPUT, W1, 'cohort');

  it('labels the mode and recomputes conversion / share / drop-off / cost per from cohort counts', () => {
    expect(f.mode).toBe('cohort');
    expect(counts(f)).toEqual({ applied: 3, consult_booked: 3, consult_showed: 2, roadmap_booked: 2, roadmap_showed: 2, enrolled: 2 });
    const st = (k: string) => f.stages.find((s) => s.key === k)!;
    expect(st('consult_booked').conversionFromPrevious).toBe(1);
    expect(st('consult_showed').conversionFromPrevious).toBeCloseTo(2 / 3);
    expect(st('enrolled').shareOfApplied).toBeCloseTo(2 / 3);
    expect(f.stages.map((s) => s.dropOff)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(st('enrolled').costPerCents).toBe(30_000); // W1 spend 60,000 ÷ 2 cohort enrollments
    expect(st('enrolled').contactIds.sort()).toEqual(['fast', 'slow']);
  });

  it('period mode is the default and differs on the same range', () => {
    const p = computeFunnel(INPUT, W1);
    expect(p.mode).toBe('period');
    expect(counts(p)).toEqual({ applied: 3, consult_booked: 1, consult_showed: 1, roadmap_booked: 1, roadmap_showed: 1, enrolled: 2 });
  });

  it('cohort previous-leads row counts cohort members parked after applying', () => {
    const parkedLater: MetricsInput = { ...INPUT, transitions: [...INPUT.transitions, t('stall', 'consult_booked', 'previous_lead', '2026-09-01')] };
    expect(computeFunnel(parkedLater, W1, 'cohort').previousLeads).toEqual({ count: 1, contactIds: ['stall'] });
    expect(computeFunnel(parkedLater, W1, 'cohort').stages[0].count).toBe(3); // still in the cohort
  });
});

describe('scorecard carries both modes with their own chips', () => {
  const s = computeScorecard(INPUT, W1, null, null);

  it('in-period chips and cohort chips are computed independently', () => {
    expect(s.funnel.mode).toBe('period');
    expect(s.cohort.funnel.mode).toBe('cohort');
    expect(s.conversions[0]).toMatchObject({ from: 'applied', to: 'consult_booked', current: 1 / 3 });
    expect(s.cohort.conversions[0]).toMatchObject({ from: 'applied', to: 'consult_booked', current: 1 });
    expect(s.cohort.conversions.map((x) => x.tone)).toEqual(['neutral', 'neutral', 'neutral', 'neutral', 'neutral']); // no comparison/baseline
  });

  it('cohort chips are coloured against the cohort-mode baseline, not the in-period one', () => {
    const withBaseline = computeScorecard(INPUT, W2, null, W1);
    // W2 cohort applied→consult = 1/1; W1 cohort baseline = 3/3 → good
    expect(withBaseline.cohort.conversions[0]).toMatchObject({ current: 1, tone: 'good' });
    // W2 in period applied→consult = 2 booked (slow, stall, w2 booked in W2 → 3) ÷ 1 applied … baseline period W1 = 1/3
    expect(withBaseline.conversions[0].current).toBe(3);
  });

  it('per-source breakdown in cohort mode', () => {
    const src = computeSourceBreakdown(INPUT, W1, 'cohort');
    expect(src.map((x) => [x.source, x.counts.applied, x.counts.enrolled])).toEqual([
      ['Facebook', 2, 2],
      ['Google', 1, 0],
    ]);
    expect(s.cohort.sources).toEqual(src);
  });

  it("weekly cohort trend attributes slow's enrollment to W1", () => {
    const buckets = [
      { ...W1, label: 'W1' },
      { ...W2, label: 'W2' },
      { ...W3, label: 'W3' },
    ];
    expect(computeTrend(INPUT, buckets, 'cohort').map((p) => [p.applied, p.enrolled])).toEqual([
      [3, 2],
      [1, 0],
      [0, 0],
    ]);
    expect(computeTrend(INPUT, buckets).map((p) => [p.applied, p.enrolled])).toEqual([
      [3, 2],
      [1, 0],
      [0, 1],
    ]);
  });
});
