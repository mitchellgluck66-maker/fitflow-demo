/**
 * Companion stage 3, item 1 — the Onboarding view on PGlite: two companion users, a past day from the mirror,
 * the week, today live with the mirror fallback, the logs joined (ok / partial / dry run / undone), the after-stage
 * role resolved through the stages table, no companion user, the CSV through the API route (owner) and the role rule.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { db, appointments, companionActions, contacts, pipelines, stages } from '@/db';
import { createUser } from '@/lib/auth/users';
import { writeMarker } from '@/lib/sync/markers';
import { clearCompanionCache, type LiveGhl } from '@/lib/companion/source';
import { getOnboardingView, companionUsers, rangeFor } from '@/lib/onboarding/service';
import { onboardingCsv } from '@/lib/onboarding/csv';
import { roleAllows } from '@/lib/auth/policy';

const TZ = 'America/Edmonton';
const MIRANDA = 'ghl-user-miranda';
const SAM = 'ghl-user-sam';
const prov = { source: 'demo', origin: 'demo', backfilled: false } as const;
const DAY = '2026-10-20'; // Tuesday
const NOW = new Date('2026-10-21T06:40:00Z'); // 00:40 MDT Wed Oct 21 — the daily report's instant
const at = (day: string, h: number, m = 0) => new Date(`${day}T${String(h + 6).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`); // MDT

const noLive: LiveGhl = { listCalendars: async () => ({ ok: false, calendars: [], error: 'GoHighLevel 503' }), listAppointments: async () => ({ events: [] }) };
const enrich = { lookupContacts: (await import('@/lib/companion/mirror')).lookupMirrorContacts, liveContact: async () => null };

beforeAll(async () => {
  await runMigrations();
  await db.insert(pipelines).values({ id: 'p1', name: 'Application', isTracked: true, ...prov });
  await db.insert(stages).values([
    { id: 's_cbooked', pipelineId: 'p1', name: 'Consult Booked', position: 1, semanticRole: 'consult_booked', ...prov },
    { id: 's_rbooked', pipelineId: 'p1', name: 'Pre-Roadmap Booked', position: 2, semanticRole: 'roadmap_booked', ...prov },
    { id: 's_enrolled', pipelineId: 'p1', name: 'Enrolled', position: 5, semanticRole: 'enrolled', ...prov },
    { id: 's_cnoshow', pipelineId: 'p1', name: 'Consult No Show', position: 6, semanticRole: 'consult_noshow', ...prov },
  ]);
  await db.insert(contacts).values([
    { id: 'ct-sarah', ghlContactId: 'c-sarah', pipelineId: 'p1', stageId: 's_rbooked', firstName: 'Sarah', lastName: 'Lindqvist', email: 'sarah@example.com', ...prov },
    { id: 'ct-priya', ghlContactId: 'c-priya', pipelineId: 'p1', stageId: 's_enrolled', firstName: 'Priya', lastName: 'Raman', ...prov },
    { id: 'ct-megan', ghlContactId: 'c-megan', pipelineId: 'p1', stageId: 's_rbooked', firstName: 'Megan', lastName: 'Ortiz', ...prov },
    { id: 'ct-ben', ghlContactId: 'c-ben', pipelineId: 'p1', stageId: 's_cbooked', firstName: 'Ben', lastName: 'Sato', ...prov },
    { id: 'ct-david', ghlContactId: 'c-david', pipelineId: 'p1', stageId: 's_cnoshow', firstName: 'David', lastName: 'Okafor', ...prov },
  ]);
  const consult = (ghlEventId: string, ghlContactId: string, start: Date, user: string, ghlStatus = 'confirmed') => ({ ghlEventId, ghlCalendarId: 'cal-consult', calendarName: 'Discovery Consult', ghlContactId, type: 'Consult', startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), timezone: TZ, assignedUserId: user, ghlStatus, ...prov });
  const roadmap = (ghlEventId: string, ghlContactId: string, start: Date, user: string, ghlStatus = 'confirmed') => ({ ...consult(ghlEventId, ghlContactId, start, user, ghlStatus), ghlCalendarId: 'cal-roadmap', calendarName: 'Roadmap Session', type: 'Roadmap' });
  await db.insert(appointments).values([
    consult('e-sarah', 'c-sarah', at(DAY, 9), MIRANDA),
    roadmap('e-priya', 'c-priya', at(DAY, 10, 30), MIRANDA),
    roadmap('e-megan', 'c-megan', at(DAY, 13), MIRANDA),
    consult('e-ben', 'c-ben', at(DAY, 16, 30), MIRANDA),
    consult('e-david', 'c-david', at(DAY, 9, 30), SAM, 'noshow'),
    consult('e-mon', 'c-sarah', at('2026-10-19', 11), MIRANDA, 'showed'),
    consult('e-sun', 'c-ben', at('2026-10-18', 11), MIRANDA),
    consult('e-next', 'c-ben', at('2026-10-25', 11), MIRANDA), // next week — out of range
    consult('e-nobody', 'c-ben', at(DAY, 12), 'ghl-user-jake'), // not a companion user
    consult('e-today', 'c-ben', at('2026-10-21', 9), MIRANDA),
  ]);
  await writeMarker({ family: 'ghl.appointments', runId: null, fetched: 10, completedAt: '2026-10-21T06:07:00.000Z' });
  const m = await createUser({ name: 'Miranda', email: 'miranda@example.com', role: 'onboarding', password: 'demo-companion', ghlUserId: MIRANDA });
  await createUser({ name: 'Sam', email: 'sam@example.com', role: 'onboarding', password: 'demo-companion', ghlUserId: SAM });
  await createUser({ name: 'Jake', email: 'jake@example.com', role: 'owner', password: 'owner-password', ghlUserId: 'ghl-user-jake' }); // an owner is not a companion user
  await createUser({ name: 'Old', email: 'old@example.com', role: 'onboarding', password: 'demo-companion', ghlUserId: null }); // no GHL user → not listed
  const base = { userId: m.id, userName: 'Miranda', ghlUserId: MIRANDA, callType: 'Consult', dryRun: false };
  const pos = (stageId: string | null, stageName: string | null, status: string, appointmentStatus: string | null) => ({ stageId, stageName, status, appointmentStatus });
  const okSteps = { stage: { status: 'ok' }, appointment: { status: 'ok' }, note: { status: 'ok' } } as never;
  await db.insert(companionActions).values([
    { ...base, requestId: 'r1', ghlEventId: 'e-sarah', ghlContactId: 'c-sarah', contactId: 'ct-sarah', clientName: 'Sarah Lindqvist', callStartAt: at(DAY, 9), outcomeKey: 'consult_showed_booked', label: 'Showed, roadmap booked', note: 'Keen to start in November.', before: pos('s_cbooked', 'Consult Booked', 'open', 'confirmed'), after: pos('s_rbooked', 'Pre-Roadmap Booked', 'open', 'showed'), steps: okSteps, state: 'ok', createdAt: at(DAY, 9, 21), updatedAt: at(DAY, 9, 21) },
    { ...base, callType: 'Roadmap', requestId: 'r2', ghlEventId: 'e-priya', ghlContactId: 'c-priya', contactId: 'ct-priya', clientName: 'Priya Raman', callStartAt: at(DAY, 10, 30), outcomeKey: 'roadmap_enrolled', label: 'Enrolled', note: 'Signed the 6-month program.', before: pos('s_rbooked', 'Pre-Roadmap Booked', 'open', 'confirmed'), after: pos('s_enrolled', 'Enrolled', 'won', 'showed'), steps: okSteps, state: 'ok', createdAt: at(DAY, 11, 32), updatedAt: at(DAY, 11, 32) },
    { ...base, callType: 'Roadmap', requestId: 'r3', ghlEventId: 'e-megan', ghlContactId: 'c-megan', contactId: 'ct-megan', clientName: 'Megan Ortiz', callStartAt: at(DAY, 13), outcomeKey: 'roadmap_showed_objection', label: 'Showed, objection', note: 'Price is the concern.', before: pos('s_rbooked', 'Pre-Roadmap Booked', 'open', 'confirmed'), after: pos('s_rbooked', 'Pre-Roadmap Booked', 'open', 'showed'), steps: { stage: { status: 'skipped', reason: 'stage unchanged' }, appointment: { status: 'ok' }, note: { status: 'failed', error: 'GHL 500' } } as never, state: 'partial', error: 'GHL 500', createdAt: at(DAY, 13, 52), updatedAt: at(DAY, 13, 52) },
    // An earlier log for Sarah that was undone — the live one above wins.
    { ...base, requestId: 'r0', ghlEventId: 'e-sarah', ghlContactId: 'c-sarah', contactId: 'ct-sarah', clientName: 'Sarah Lindqvist', callStartAt: at(DAY, 9), outcomeKey: 'consult_noshow', label: 'No-show', note: 'Mis-click.', before: pos('s_cbooked', 'Consult Booked', 'open', 'confirmed'), after: pos('s_cnoshow', 'Consult No Show', 'open', 'noshow'), steps: okSteps, state: 'undone', undoneAt: at(DAY, 9, 10), undoneBy: 'Miranda', createdAt: at(DAY, 9, 5), updatedAt: at(DAY, 9, 10) },
    // Monday: a dry run, and an undone-only log on Sunday.
    { ...base, requestId: 'r4', ghlEventId: 'e-mon', ghlContactId: 'c-sarah', contactId: 'ct-sarah', clientName: 'Sarah Lindqvist', callStartAt: at('2026-10-19', 11), outcomeKey: 'consult_showed_booked', label: 'Showed, roadmap booked', note: 'Dry run day.', before: pos('s_cbooked', 'Consult Booked', 'open', 'confirmed'), after: pos('s_rbooked', 'Pre-Roadmap Booked', 'open', 'showed'), steps: { stage: { status: 'ok' }, appointment: { status: 'ok' }, note: { status: 'ok' } } as never, state: 'dry_run', dryRun: true, createdAt: at('2026-10-19', 11, 40), updatedAt: at('2026-10-19', 11, 40) },
    { ...base, requestId: 'r5', ghlEventId: 'e-sun', ghlContactId: 'c-ben', contactId: 'ct-ben', clientName: 'Ben Sato', callStartAt: at('2026-10-18', 11), outcomeKey: 'consult_not_fit', label: 'Not a fit', note: 'Wrong person.', before: pos('s_cbooked', 'Consult Booked', 'open', 'confirmed'), after: pos('s_cbooked', 'Consult Booked', 'lost', 'showed'), steps: okSteps, state: 'undone', undoneAt: at('2026-10-18', 11, 50), undoneBy: 'Miranda', createdAt: at('2026-10-18', 11, 45), updatedAt: at('2026-10-18', 11, 50) },
  ]);
});
beforeEach(() => clearCompanionCache());

describe('companion users + ranges', () => {
  it('lists active onboarding logins with a GHL user, oldest first; a week is Sun–Sat', async () => {
    expect((await companionUsers()).map((u) => u.name)).toEqual(['Miranda', 'Sam']);
    expect(rangeFor('week', '2026-10-21')).toEqual({ start: '2026-10-18', end: '2026-10-24' });
    expect(rangeFor('day', '2026-10-21')).toEqual({ start: '2026-10-21', end: '2026-10-21' });
  });
});

describe('getOnboardingView', () => {
  it('a past day from the mirror: both users, the logs joined, roles resolved, the numbers and the attention list', async () => {
    const v = await getOnboardingView({ range: 'day', date: DAY, now: NOW, timezone: TZ }, { live: noLive, enrich });
    if ('error' in v) throw new Error(v.error);
    expect(v).toMatchObject({ range: 'day', start: DAY, end: DAY, label: 'Tue, Oct 20, 2026', today: '2026-10-21', reason: null });
    expect(v.users.map((u) => `${u.name}:${u.source}`)).toEqual(['Miranda:mirror', 'Sam:mirror']);
    expect(v.users[0].asOf).toBe('2026-10-21T06:07:00.000Z');
    expect(v.calls.map((c) => `${c.timeLabel} ${c.name} (${c.userName})`)).toEqual(['9:00 AM Sarah Lindqvist (Miranda)', '9:30 AM David Okafor (Sam)', '10:30 AM Priya Raman (Miranda)', '1:00 PM Megan Ortiz (Miranda)', '4:30 PM Ben Sato (Miranda)']);
    const by = Object.fromEntries(v.calls.map((c) => [c.name.split(' ')[0], c]));
    expect(by.Sarah.log).toMatchObject({ state: 'ok', label: 'Showed, roadmap booked', after: { role: 'roadmap_booked', stageName: 'Pre-Roadmap Booked' }, steps: { stage: 'ok', appointment: 'ok', note: 'ok' } });
    expect(by.Sarah.undone).toBeNull(); // the live log wins over the undone one
    expect(by.Priya.log).toMatchObject({ state: 'ok', after: { role: 'enrolled', status: 'won' } });
    expect(by.Megan.log).toMatchObject({ state: 'partial', failedStep: 'note', error: 'GHL 500', steps: { stage: 'skipped', appointment: 'ok', note: 'failed' } });
    expect(by.Megan.status).toBe('failed');
    expect(by.Ben).toMatchObject({ status: 'needs_outcome', log: null, ended: true, contactId: 'ct-ben' });
    expect(by.David).toMatchObject({ status: 'ghl_outcome', outcomeInGhl: 'no_show', log: null, userName: 'Sam' });
    expect(v.numbers).toMatchObject({ calls: 5, consults: 3, roadmaps: 2, logged: 3, showed: 3, roadmapsBooked: 1, enrolled: 1, noShows: 1, consultNoShows: 1, needsOutcome: 1, failedLogs: 1, needsAttention: 2, unlogged: 2 });
    expect(v.attention.map((a) => a.text)).toEqual(['4:30 PM consult with Ben Sato has no outcome logged.', "1:00 PM roadmap with Megan Ortiz: Appointment updated; the note didn't reach GoHighLevel (GHL 500)."]);
    expect(v.attention[1].logId).toBe(by.Megan.log!.id);
    // The CSV the route serves.
    const csv = onboardingCsv(v.calls);
    expect(csv.split('\r\n')).toHaveLength(7);
    expect(csv).toContain('Megan Ortiz,Miranda,"Showed, objection",Pre-Roadmap Booked,Pre-Roadmap Booked,open,Price is the concern.');
  });

  it('the week: Sun–Sat from the mirror, the dry run counted as logged, the undone-only Sunday call marked Undone, next week excluded', async () => {
    const v = await getOnboardingView({ range: 'week', date: DAY, now: NOW, timezone: TZ }, { live: noLive, enrich });
    if ('error' in v) throw new Error(v.error);
    expect(v).toMatchObject({ range: 'week', start: '2026-10-18', end: '2026-10-24', label: 'Oct 18–24' });
    expect(v.calls.map((c) => c.eventId)).toEqual(['e-sun', 'e-mon', 'e-sarah', 'e-david', 'e-priya', 'e-megan', 'e-ben', 'e-today']);
    const sun = v.calls.find((c) => c.eventId === 'e-sun')!;
    expect(sun.log).toBeNull();
    expect(sun.undone).toEqual({ label: 'Not a fit', undoneBy: 'Miranda', undoneAt: at('2026-10-18', 11, 50).toISOString() });
    expect(v.calls.find((c) => c.eventId === 'e-mon')!.log).toMatchObject({ state: 'dry_run', dryRun: true });
    expect(v.calls.find((c) => c.eventId === 'e-today')!.ended).toBe(false); // 9 AM today, now is 00:40
    expect(v.numbers).toMatchObject({ calls: 8, logged: 4, roadmapsBooked: 2, enrolled: 1, needsAttention: 3, unlogged: 3 });
  });

  it("today's Day view reads live per user; GHL down → the mirror with asOf and the reason", async () => {
    const live: LiveGhl = {
      listCalendars: async () => ({ ok: true, calendars: [{ id: 'cal-consult', name: 'Discovery Consult' }] }),
      listAppointments: async ({ calendarId }) => ({ events: calendarId === 'cal-consult' ? [{ id: 'e-live', calendarId, contactId: 'c-ben', startTime: '2026-10-21T15:00:00Z', assignedUserId: MIRANDA, appointmentStatus: 'confirmed' }] : [] }),
    };
    const ok = await getOnboardingView({ range: 'day', date: '2026-10-21', now: NOW, timezone: TZ }, { live, enrich, cache: false });
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.users.map((u) => `${u.name}:${u.source}`)).toEqual(['Miranda:live', 'Sam:live']);
    expect(ok.calls.map((c) => c.eventId)).toEqual(['e-live']);
    expect(ok.calls[0]).toMatchObject({ name: 'Ben Sato', status: 'up_next', ended: false });
    const down = await getOnboardingView({ range: 'day', date: '2026-10-21', now: NOW, timezone: TZ }, { live: noLive, enrich, cache: false });
    if ('error' in down) throw new Error(down.error);
    expect(down.users[0]).toMatchObject({ source: 'mirror', reason: 'GoHighLevel 503', asOf: '2026-10-21T06:07:00.000Z' });
    expect(down.calls.map((c) => c.eventId)).toEqual(['e-today']);
  });

  it('no companion user → the reason, empty numbers; a bad date → 400', async () => {
    const v = await getOnboardingView({ range: 'day', date: DAY, now: NOW, timezone: TZ }, { live: noLive, enrich, users: async () => [] });
    if ('error' in v) throw new Error(v.error);
    expect(v.reason).toBe('No onboarding login with a GoHighLevel user — add one in Setup → Users.');
    expect(v.numbers.calls).toBe(0);
    expect(await getOnboardingView({ range: 'day', date: '2026-13-40', now: NOW, timezone: TZ }, { live: noLive })).toEqual({ error: 'Bad date', detail: 'Use YYYY-MM-DD.' });
  });

  it('role rule: /onboarding and /api/onboarding are the owner\'s', () => {
    expect(roleAllows('onboarding', '/onboarding')).toBe(false);
    expect(roleAllows('onboarding', '/api/onboarding?date=2026-10-20')).toBe(false);
    expect(roleAllows('owner', '/onboarding')).toBe(true);
  });
});
