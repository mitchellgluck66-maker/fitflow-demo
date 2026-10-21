/**
 * Companion stage 3, item 1 — the ONE onboarding numbers function (pure): logged / showed / no-shows / roadmaps
 * booked / enrolled / not a fit, the needs-attention rules, undone and dry-run logs, week sums, the GHL result
 * column, the filters and the CSV.
 */
import { describe, it, expect } from 'vitest';
import { onboardingNumbers, attentionItems, ghlResultOf, outcomeLabelOf, stageMoveOf, matchesFilter, filterCounts, onboardingHeadline, type OnboardingCall, type OnboardingLog } from '@/lib/onboarding/numbers';
import { onboardingCsv, CSV_HEADERS } from '@/lib/onboarding/csv';

const log = (o: Omit<Partial<OnboardingLog>, 'after'> & { after?: Partial<OnboardingLog['after']> }): OnboardingLog => ({
  id: o.id ?? 'log-1',
  state: o.state ?? 'ok',
  stale: false,
  outcomeKey: o.outcomeKey ?? 'consult_showed_booked',
  label: o.label ?? 'Showed, roadmap booked',
  note: o.note ?? 'Keen to start in November.',
  userName: 'Miranda',
  createdAt: '2026-10-21T15:21:00Z',
  dryRun: o.state === 'dry_run',
  before: { stageName: 'Consult Booked', status: 'open', appointmentStatus: 'confirmed' },
  after: { stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'showed', role: 'roadmap_booked', ...o.after },
  steps: o.steps ?? { stage: 'ok', appointment: 'ok', note: 'ok' },
  failedStep: o.failedStep ?? null,
  error: o.error ?? null,
});

const call = (o: Partial<OnboardingCall>): OnboardingCall => ({
  eventId: o.eventId ?? 'ev',
  date: '2026-10-21',
  startIso: '2026-10-21T15:00:00Z',
  endIso: '2026-10-21T15:30:00Z',
  timeLabel: o.timeLabel ?? '9:00 AM',
  callType: o.callType ?? 'Consult',
  calendarName: 'Discovery Consult',
  ghlContactId: 'c1',
  contactId: 'ct-1',
  name: o.name ?? 'Sarah Lindqvist',
  userName: 'Miranda',
  status: o.status ?? 'logged',
  outcomeInGhl: o.outcomeInGhl ?? null,
  ended: o.ended ?? true,
  log: o.log === undefined ? log({}) : o.log,
  undone: o.undone ?? null,
});

describe('onboardingNumbers', () => {
  it('the canvas day: 8 calls, 7 logged, 4 showed (57%), 1 roadmap booked, 1 enrolled, 2 no-shows, 2 need attention', () => {
    const calls: OnboardingCall[] = [
      call({ eventId: '1', name: 'Sarah', log: log({}) }),
      call({ eventId: '2', name: 'David', log: log({ outcomeKey: 'consult_noshow', label: 'No-show', after: { stageName: 'Consult No Show', appointmentStatus: 'noshow', role: 'consult_noshow' } }) }),
      call({ eventId: '3', name: 'Priya', callType: 'Roadmap', log: log({ outcomeKey: 'roadmap_enrolled', label: 'Enrolled', after: { stageName: 'Enrolled', status: 'won', appointmentStatus: 'showed', role: 'enrolled' } }) }),
      call({ eventId: '4', name: 'Jordan', log: log({ outcomeKey: 'consult_reschedule', label: 'Reschedule', after: { stageName: 'Consult Reschedule', appointmentStatus: 'cancelled', role: 'consult_rescheduled' } }) }),
      call({ eventId: '5', name: 'Megan', callType: 'Roadmap', status: 'failed', log: log({ state: 'partial', outcomeKey: 'roadmap_showed_objection', label: 'Showed, objection', after: { stageName: 'Roadmap Completed: Objection', appointmentStatus: 'showed', role: 'roadmap_showed' }, steps: { stage: 'ok', appointment: 'ok', note: 'failed' }, failedStep: 'note', error: 'GHL 500' }) }),
      call({ eventId: '6', name: 'Tom', log: log({ outcomeKey: 'consult_not_fit', label: 'Not a fit', after: { stageName: 'Consult Booked', status: 'lost', appointmentStatus: 'showed', role: 'consult_booked' } }) }),
      call({ eventId: '7', name: 'Alicia', callType: 'Roadmap', log: log({ outcomeKey: 'roadmap_noshow', label: 'No-show', after: { stageName: 'Roadmap No Show', appointmentStatus: 'noshow', role: 'roadmap_noshow' } }) }),
      call({ eventId: '8', name: 'Ben', timeLabel: '4:30 PM', status: 'needs_outcome', log: null }),
    ];
    const n = onboardingNumbers(calls);
    expect(n).toMatchObject({ calls: 8, consults: 5, roadmaps: 3, logged: 7, showed: 4, roadmapsBooked: 1, enrolled: 1, notFit: 1, noShows: 2, consultNoShows: 1, roadmapNoShows: 1, needsOutcome: 1, failedLogs: 1, needsAttention: 2, unlogged: 1 });
    expect(n.showedPct).toBeCloseTo(4 / 7, 5);
    const a = attentionItems(calls);
    expect(a).toEqual([
      { eventId: '8', kind: 'needs_outcome', text: '4:30 PM consult with Ben has no outcome logged.', logId: null },
      { eventId: '5', kind: 'failed_log', text: "9:00 AM roadmap with Megan: Stage and Appointment updated; the note didn't reach GoHighLevel (GHL 500).", logId: 'log-1' },
    ]);
    expect(onboardingHeadline(n, 'today')).toBe('8 calls today: 1 enrolled, 1 roadmap booked, 2 no-shows, 2 need attention.');
    expect(filterCounts(calls)).toEqual({ all: 8, attention: 2, no_shows: 2, enrolled: 1, not_fit: 1 });
    expect(calls.filter((c) => matchesFilter(c, 'enrolled')).map((c) => c.name)).toEqual(['Priya']);
  });

  it('an undone log is not logged; a dry run is logged; a failed log (nothing applied) is logged and needs attention', () => {
    const undone = call({ eventId: 'u', status: 'needs_outcome', log: null, undone: { label: 'Enrolled', undoneBy: 'Miranda', undoneAt: '2026-10-21T15:40:00Z' } });
    const dry = call({ eventId: 'd', status: 'dry_run', log: log({ state: 'dry_run' }) });
    const failed = call({ eventId: 'f', status: 'failed', log: log({ state: 'failed', steps: { stage: 'failed', appointment: 'pending', note: 'pending' }, failedStep: 'stage', error: 'GHL 401' }) });
    const n = onboardingNumbers([undone, dry, failed]);
    expect(n).toMatchObject({ calls: 3, logged: 2, needsOutcome: 1, failedLogs: 1, needsAttention: 2, roadmapsBooked: 2, showed: 2, unlogged: 1 });
    expect(ghlResultOf(undone)).toEqual({ label: 'Undone', sub: 'Enrolled · by Miranda', tone: 'neutral', canRetry: false });
    expect(ghlResultOf(dry)).toEqual({ label: 'Dry run — not sent', sub: 'Recorded in FitFlow only', tone: 'warn', canRetry: false });
    expect(ghlResultOf(failed)).toMatchObject({ label: '✗ Failed', sub: 'GHL 401', tone: 'bad', canRetry: true });
    expect(attentionItems([failed])[0].text).toBe("9:00 AM consult with Sarah Lindqvist: the stage move didn't reach GoHighLevel (GHL 401).");
    expect(outcomeLabelOf(undone)).toEqual({ label: 'Undone', tone: 'gray' });
    expect(stageMoveOf(undone)).toBe('Restored by undo');
  });

  it('with no Companion log, GHL\'s own outcome counts (showed / no-show) and is never "needs attention"; cancelled is not unlogged', () => {
    const showed = call({ eventId: 'g1', status: 'ghl_outcome', outcomeInGhl: 'showed', log: null });
    const noShow = call({ eventId: 'g2', status: 'ghl_outcome', outcomeInGhl: 'no_show', log: null, callType: 'Roadmap' });
    const cancelled = call({ eventId: 'g3', status: 'ghl_outcome', outcomeInGhl: 'cancelled', log: null });
    const upNext = call({ eventId: 'g4', status: 'up_next', log: null, ended: false });
    const n = onboardingNumbers([showed, noShow, cancelled, upNext]);
    expect(n).toMatchObject({ calls: 4, logged: 0, showed: 1, noShows: 1, roadmapNoShows: 1, needsAttention: 0, unlogged: 2, showedPct: null });
    expect(ghlResultOf(showed).label).toBe('Showed in GHL');
    expect(ghlResultOf(upNext)).toMatchObject({ label: 'Up next', tone: 'neutral' });
    expect(outcomeLabelOf(noShow)).toEqual({ label: 'No-show (GHL)', tone: 'amber' });
    expect(attentionItems([showed, noShow, cancelled, upNext])).toEqual([]);
  });

  it('week sums are the same function over seven days of calls; the empty week', () => {
    const days = ['19', '20', '21', '22', '23'].flatMap((d) => [call({ eventId: `${d}-a`, date: `2026-10-${d}` }), call({ eventId: `${d}-b`, date: `2026-10-${d}`, callType: 'Roadmap', log: log({ outcomeKey: 'roadmap_enrolled', label: 'Enrolled', after: { stageName: 'Enrolled', status: 'won', role: 'enrolled' } }) })]);
    const n = onboardingNumbers(days);
    expect(n).toMatchObject({ calls: 10, consults: 5, roadmaps: 5, logged: 10, showed: 10, roadmapsBooked: 5, enrolled: 5, needsAttention: 0 });
    expect(n.showedPct).toBe(1);
    expect(onboardingNumbers([])).toMatchObject({ calls: 0, logged: 0, showedPct: null, needsAttention: 0 });
    expect(onboardingHeadline(onboardingNumbers([]), 'this week')).toBe('No onboarding calls this week.');
    expect(onboardingHeadline(onboardingNumbers([call({ eventId: 'x', log: log({ outcomeKey: 'consult_reschedule', label: 'Reschedule', after: { appointmentStatus: 'cancelled', role: 'consult_rescheduled', stageName: 'Consult Reschedule' } }) })]), 'today')).toBe('1 call today, 1 of 1 logged.');
  });

  it('stage move text and the GHL column per state', () => {
    const partial = call({ status: 'failed', log: log({ state: 'partial', steps: { stage: 'ok', appointment: 'failed', note: 'pending' }, failedStep: 'appointment', error: 'GHL 422' }) });
    expect(stageMoveOf(partial)).toBe('Consult Booked → Pre-Roadmap Booked');
    expect(ghlResultOf(partial)).toEqual({ label: '! Partly failed', sub: 'Stage ✓ · Appointment ✗ · Note …', tone: 'warn', canRetry: true });
    const lost = call({ log: log({ outcomeKey: 'consult_not_fit', label: 'Not a fit', after: { stageName: 'Consult Booked', status: 'lost', appointmentStatus: 'showed', role: 'consult_booked' } }) });
    expect(stageMoveOf(lost)).toBe('Consult Booked (unchanged) · deal marked Lost');
    expect(ghlResultOf(call({}))).toEqual({ label: '✓ Updated', sub: 'Stage · appointment · note', tone: 'ok', canRetry: false });
    expect(ghlResultOf(call({ status: 'needs_outcome', log: null }))).toMatchObject({ label: 'Not logged', tone: 'bad' });
  });
});

describe('CSV', () => {
  it('one row per call, quoted when needed, CRLF', () => {
    const csv = onboardingCsv([call({ log: log({ note: 'Price is the concern, "payment plan" Monday.' }) }), call({ eventId: 'n', status: 'needs_outcome', log: null, name: 'Ben Sato' })]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
    expect(lines[1]).toContain('2026-10-21,9:00 AM,Consult,Discovery Consult,Sarah Lindqvist,Miranda,"Showed, roadmap booked",Consult Booked,Pre-Roadmap Booked,open,"Price is the concern, ""payment plan"" Monday.",2026-10-21T15:21:00Z,Miranda,✓ Updated,Stage · appointment · note');
    expect(lines[2]).toContain('Ben Sato,Miranda,Needs outcome,,,,,,,Not logged,Call ended');
    expect(lines[3]).toBe('');
  });
});
