/**
 * Honest Applied caveat (2026-09-30, docs/applied-reconciliation-2026-09-20.md; definition under review —
 * docs/deferred.md #1). The definition of Applied is UNCHANGED: this only says, for the selected range, how many
 * counted applications have no application-form signal and how many form applicants sit in unfollowed pipelines.
 */
import { describe, it, expect } from 'vitest';
import { applicationSignal, computeAppliedCaveat, computeScorecard, isApplicationFormSource, type ContactRow, type MetricsInput } from '@/lib/metrics';

const R = { start: '2026-09-20', end: '2026-09-26' };

describe('isApplicationFormSource', () => {
  it('matches every application-form source seen in GHL, nothing else', () => {
    for (const s of ['New Application 7.10', 'Fit Physician Application', 'application (B)']) expect(isApplicationFormSource(s)).toBe(true);
    for (const s of ['Manual entry', 'Calendar', '', null, undefined]) expect(isApplicationFormSource(s)).toBe(false);
  });
});

describe('applicationSignal', () => {
  const base = { source: 'New Application 7.10', contactCreatedOn: '2026-09-22', appliedOn: '2026-09-22', firstStageRole: 'applied' as string | null };
  it('a form-sourced contact created by the application is a form record (class A1)', () => {
    expect(applicationSignal(base)).toEqual({ signal: 'form', reason: 'new contact created by the application form' });
  });
  it('a returning form contact whose application entered at Applied is a form record (class A3)', () => {
    expect(applicationSignal({ ...base, contactCreatedOn: '2025-03-01' }).signal).toBe('form');
  });
  it('a form-sourced contact whose first stage was never observed is given the benefit of the doubt, and says so', () => {
    expect(applicationSignal({ ...base, contactCreatedOn: '2025-03-01', firstStageRole: null })).toEqual({ signal: 'form', reason: 'form-sourced contact; first stage not observed' });
  });
  it('a pre-existing form contact entered directly at a later stage has no application record for THIS opportunity (class C)', () => {
    expect(applicationSignal({ ...base, contactCreatedOn: '2025-03-01', firstStageRole: 'consult_booked' })).toEqual({
      signal: 'none',
      reason: 'pre-existing form contact entered directly at consult booked',
    });
  });
  it('a non-form source is never a form record, whatever else is true (class D)', () => {
    expect(applicationSignal({ ...base, source: 'Manual entry' })).toEqual({ signal: 'none', reason: 'contact source is "Manual entry", not an application form' });
    expect(applicationSignal({ ...base, source: null }).reason).toBe('contact source is empty, not an application form');
  });
  it('a sample-data row is never flagged: there is no GHL record to check and the banner already labels it', () => {
    expect(applicationSignal({ ...base, source: 'Facebook', origin: 'demo' })).toEqual({ signal: 'form', reason: 'sample data' });
  });
  it('an opportunity moved in from another pipeline is not an application form record', () => {
    expect(applicationSignal({ ...base, movedIn: true })).toEqual({ signal: 'none', reason: 'opportunity moved in from another pipeline' });
  });
});

const c = (id: string, signal: 'form' | 'none', reason: string, appliedOn = '2026-09-22'): ContactRow => ({
  id,
  name: id.toUpperCase(),
  email: null,
  source: signal === 'form' ? 'New Application 7.10' : 'Manual entry',
  stageId: 'st-applied',
  stageName: 'Applied',
  role: 'applied',
  appliedOn,
  applicationSignal: signal,
  applicationSignalReason: reason,
  monetaryValueCents: 0,
  origin: 'ghl',
  attribution: null,
});

const INPUT: MetricsInput = {
  contacts: [
    c('a1', 'form', 'new contact created by the application form'),
    c('a2', 'form', 'new contact created by the application form'),
    c('c1', 'none', 'pre-existing form contact entered directly at enrolled'),
    c('d1', 'none', 'contact source is "Manual entry", not an application form'),
    c('prev', 'none', 'contact source is empty, not an application form', '2026-09-12'), // outside the range
  ],
  transitions: [],
  appointments: [],
  spend: [],
  payments: [],
  otherPipelineApplications: [
    { contactId: 'x1', name: 'X1', on: '2026-09-23', pipeline: 'Marketing/Sales', alsoInFollowed: false },
    { contactId: 'x2', name: 'X2', on: '2026-09-25', pipeline: '{ Off } Old', alsoInFollowed: true },
    { contactId: 'x3', name: 'X3', on: '2026-09-02', pipeline: 'Marketing/Sales', alsoInFollowed: false }, // outside the range
  ],
};

describe('computeAppliedCaveat', () => {
  it('counts the range: applied is unchanged, no-form rows carry their reason, other-pipeline applicants are dated by their opportunity', () => {
    const cav = computeAppliedCaveat(INPUT, R);
    expect(cav.applied).toBe(4); // a1, a2, c1, d1 — the definition is NOT changed by the caveat
    expect(cav.withoutFormRecord).toEqual([
      { contactId: 'c1', name: 'C1', reason: 'pre-existing form contact entered directly at enrolled' },
      { contactId: 'd1', name: 'D1', reason: 'contact source is "Manual entry", not an application form' },
    ]);
    expect(cav.otherPipelines).toEqual([
      { contactId: 'x1', name: 'X1', pipeline: 'Marketing/Sales', alsoInFollowed: false },
      { contactId: 'x2', name: 'X2', pipeline: '{ Off } Old', alsoInFollowed: true },
    ]);
    expect(cav.text).toBe('4 applied · 2 have no application form record · 2 applicants in other pipelines. Definition under review.');
  });
  it('singular wording, and a clean range still says the definition is under review', () => {
    const one = computeAppliedCaveat({ ...INPUT, contacts: [INPUT.contacts[0], INPUT.contacts[2]], otherPipelineApplications: [INPUT.otherPipelineApplications![0]] }, R);
    expect(one.text).toBe('2 applied · 1 has no application form record · 1 applicant in other pipelines. Definition under review.');
    const clean = computeAppliedCaveat({ ...INPUT, contacts: INPUT.contacts.slice(0, 2), otherPipelineApplications: [] }, R);
    expect(clean.text).toBe('2 applied. Definition under review.');
    expect(clean.withoutFormRecord).toEqual([]);
    expect(clean.otherPipelines).toEqual([]);
  });
  it('a fixture without the loader fields (older tests) reads as all-form, nothing withheld', () => {
    const legacy = { ...INPUT, contacts: INPUT.contacts.map(({ applicationSignal: _s, applicationSignalReason: _r, ...rest }) => rest as ContactRow), otherPipelineApplications: undefined };
    expect(computeAppliedCaveat(legacy, R)).toMatchObject({ applied: 4, withoutFormRecord: [], otherPipelines: [] });
  });
  it('the scorecard carries the caveat for its range, so tiles, funnel, data health, digests and the AI read one object', () => {
    const sc = computeScorecard(INPUT, R, null, null);
    expect(sc.appliedCaveat.text).toBe('4 applied · 2 have no application form record · 2 applicants in other pipelines. Definition under review.');
    expect(sc.kpis.applied.current).toBe(4);
  });
});
