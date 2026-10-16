/**
 * Companion stage 1, item 2 — My day: assignment + call type (pure), the status clock, the counter, the auto-select,
 * the live loader with its 2-minute cache and mirror fallback, enrichment, and the service end to end on PGlite
 * (who is viewed, the timezone preference, the "no GHL user" answer, the mirror fallback with asOf from the marker).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { db, appointments, contacts, pipelines, stages } from '@/db';
import { setSetting } from '@/lib/settings';
import { writeMarker } from '@/lib/sync/markers';
import { callTypeOf, isAssignedTo, inCalendarFilter, calendarLabel } from '@/lib/companion/calendars';
import { statusOf, summarize, selectCurrent, outcomeInGhlOf, CURRENT_WINDOW_MINUTES } from '@/lib/companion/day';
import { loadDayRaw, clearCompanionCache, CACHE_TTL_MS, type LiveGhl, type MirrorReader } from '@/lib/companion/source';
import { enrichCalls, unknownName } from '@/lib/companion/enrich';
import { getMyDay } from '@/lib/companion/service';
import { createUser } from '@/lib/auth/users';
import { getDayBounds } from '@/lib/day';
import type { CurrentUser } from '@/lib/auth/currentUser';

const TZ = 'America/Edmonton';
const ME = 'gUYW4bOBKjgrgFCBAW6W';

describe('calendars (pure)', () => {
  it('call type from the calendar name; assignment by assignedUserId or users[]; the filter; labels', () => {
    expect(callTypeOf('15-Minute Fit Physician Consult ')).toBe('Consult');
    expect(callTypeOf('Internal: Roadmap Building Session')).toBe('Roadmap');
    expect(callTypeOf('Back to School Scholarship Roadmap Session')).toBe('Roadmap');
    expect(callTypeOf(' Quick Connect with Miranda')).toBe('Other');
    expect(callTypeOf('10 Minutes with Miranda', 'Consult: Jane')).toBe('Consult');
    expect(isAssignedTo({ assignedUserId: ME }, ME)).toBe(true);
    expect(isAssignedTo({ assignedUserId: 'someone', users: ['x', ME] }, ME)).toBe(true);
    expect(isAssignedTo({ assignedUserId: 'someone', users: ['x'] }, ME)).toBe(false);
    expect(isAssignedTo({}, ME)).toBe(false);
    expect(isAssignedTo({ assignedUserId: ME }, null)).toBe(false);
    expect(inCalendarFilter('a', null)).toBe(true);
    expect(inCalendarFilter('a', [])).toBe(true);
    expect(inCalendarFilter('a', ['b'])).toBe(false);
    expect(inCalendarFilter('a', ['a', 'b'])).toBe(true);
    expect(calendarLabel(' Quick Connect with Miranda', 'id1')).toBe('Quick Connect with Miranda');
    expect(calendarLabel('', 'id1')).toBe('Calendar id1');
  });
});

describe('day (pure)', () => {
  const now = new Date('2026-10-16T16:00:00Z'); // 10:00 MDT
  const at = (h: number, m = 0, len = 30) => ({ startIso: new Date(Date.UTC(2026, 9, 16, h + 6, m)).toISOString(), endIso: new Date(Date.UTC(2026, 9, 16, h + 6, m + len)).toISOString() });
  it('status by the clock and by GHL outcome', () => {
    expect(statusOf({ ...at(11), outcomeInGhl: null }, now)).toBe('up_next');
    expect(statusOf({ ...at(9, 50), outcomeInGhl: null }, now)).toBe('in_progress');
    expect(statusOf({ ...at(9, 50, 5), outcomeInGhl: null }, now)).toBe('needs_outcome');
    expect(statusOf({ startIso: at(9, 45).startIso, endIso: null, outcomeInGhl: null }, now)).toBe('in_progress'); // 30-min default
    expect(statusOf({ startIso: at(9, 25).startIso, endIso: null, outcomeInGhl: null }, now)).toBe('needs_outcome');
    expect(statusOf({ ...at(9), outcomeInGhl: 'showed' }, now)).toBe('ghl_outcome');
    expect(statusOf({ ...at(14), outcomeInGhl: 'cancelled' }, now)).toBe('ghl_outcome');
    expect(statusOf({ ...at(9), outcomeInGhl: null, logged: true }, now)).toBe('logged');
    expect(outcomeInGhlOf('noshow')).toBe('no_show');
    expect(outcomeInGhlOf('cancelled')).toBe('cancelled');
    expect(outcomeInGhlOf('confirmed')).toBeNull();
    expect(outcomeInGhlOf(null)).toBeNull();
  });
  it('the counter never counts a logged call in stage 1 and excludes GHL-recorded outcomes from "need an outcome"', () => {
    expect(summarize([{ status: 'up_next' }, { status: 'needs_outcome' }, { status: 'needs_outcome' }, { status: 'ghl_outcome' }, { status: 'in_progress' }])).toEqual({ calls: 5, logged: 0, needOutcome: 2 });
  });
  it('selectCurrent: ±10 min of start (closest), else in progress, else next upcoming, else last; cancelled skipped', () => {
    const calls = [
      { ...at(8), outcomeInGhl: null },
      { ...at(9, 55), outcomeInGhl: null }, // starts 5 min ago
      { ...at(10, 5), outcomeInGhl: null }, // starts in 5 min
      { ...at(13), outcomeInGhl: null },
    ];
    expect(selectCurrent(calls, now)).toBe(1); // both within the window; 9:55 is as close as 10:05 — first wins the tie
    expect(selectCurrent(calls, new Date('2026-10-16T16:04:00Z'))).toBe(2);
    expect(CURRENT_WINDOW_MINUTES).toBe(10);
    // In progress beats the next upcoming: a 60-min roadmap that started 25 min ago.
    expect(selectCurrent([{ ...at(9, 35, 60), outcomeInGhl: null }, { ...at(13), outcomeInGhl: null }], now)).toBe(0);
    // Nothing near: the next upcoming.
    expect(selectCurrent([{ ...at(8), outcomeInGhl: null }, { ...at(13), outcomeInGhl: null }, { ...at(15), outcomeInGhl: null }], now)).toBe(1);
    // All past: the last one.
    expect(selectCurrent([{ ...at(7), outcomeInGhl: null }, { ...at(8), outcomeInGhl: null }], now)).toBe(1);
    // Cancelled is never selected.
    expect(selectCurrent([{ ...at(10), outcomeInGhl: 'cancelled' }, { ...at(13), outcomeInGhl: null }], now)).toBe(1);
    expect(selectCurrent([{ ...at(10), outcomeInGhl: 'cancelled' }], now)).toBe(-1);
    expect(selectCurrent([], now)).toBe(-1);
  });
});

// ---- the loader with fakes --------------------------------------------------------------------------------------
function fakeLive(events: Record<string, Array<{ id: string; contactId: string; startTime: string; assignedUserId?: string | null; users?: string[] | null; appointmentStatus?: string | null; title?: string | null }>>, opts: { calendarsError?: string; eventsError?: Record<string, string>; throwOn?: string } = {}) {
  const calls = { calendars: 0, events: 0 };
  const live: LiveGhl = {
    async listCalendars() {
      calls.calendars += 1;
      if (opts.calendarsError) return { ok: false, calendars: [], error: opts.calendarsError };
      return { ok: true, calendars: Object.keys(events).map((id) => ({ id, name: id === 'cal-consult' ? '15-Minute Fit Physician Consult ' : id === 'cal-roadmap' ? 'Roadmap Building Session' : ` Quick Connect with Miranda`, isActive: id !== 'cal-inactive' })) };
    },
    async listAppointments({ calendarId, startTimeMs, endTimeMs }) {
      calls.events += 1;
      if (opts.throwOn === calendarId) throw new Error('socket hang up');
      if (opts.eventsError?.[calendarId]) return { events: [], error: opts.eventsError[calendarId] };
      return { events: (events[calendarId] ?? []).filter((e) => Date.parse(e.startTime) >= startTimeMs && Date.parse(e.startTime) <= endTimeMs).map((e) => ({ ...e, calendarId })) };
    },
  };
  return { live, calls };
}
const mirrorRows: MirrorReader = async () => ({ rows: [{ eventId: 'mirror-1', calendarId: 'cal-consult', calendarName: '15-Minute Fit Physician Consult', callType: 'Consult', title: null, startIso: '2026-10-16T17:00:00.000Z', endIso: null, ghlContactId: 'c-mirror', ghlStatus: 'confirmed' }], asOf: '2026-10-16T13:07:00.000Z' });

describe('loadDayRaw', () => {
  beforeEach(() => clearCompanionCache());
  const now = new Date('2026-10-16T16:00:00Z');
  const base = { ghlUserId: ME, date: '2026-10-16', timezone: TZ, calendarFilter: null as string[] | null, now, mirror: mirrorRows };

  it('reads every active calendar in the local day window, keeps only my events, and tags the call type', async () => {
    const { live, calls } = fakeLive({
      'cal-consult': [
        { id: 'e1', contactId: 'c1', startTime: '2026-10-16T15:00:00Z', assignedUserId: ME },
        { id: 'e2', contactId: 'c2', startTime: '2026-10-16T18:00:00Z', assignedUserId: 'other' },
        { id: 'e3', contactId: 'c3', startTime: '2026-10-17T05:30:00Z', assignedUserId: ME }, // 23:30 local — still the 16th
        { id: 'e4', contactId: 'c4', startTime: '2026-10-17T06:10:00Z', assignedUserId: ME }, // 00:10 local on the 17th
        { id: 'e5', contactId: 'c5', startTime: '2026-10-16T20:00:00Z', assignedUserId: 'other', users: [ME] },
      ],
      'cal-roadmap': [{ id: 'r1', contactId: 'c6', startTime: '2026-10-16T19:00:00Z', assignedUserId: ME, appointmentStatus: 'noshow' }],
      'cal-inactive': [{ id: 'x1', contactId: 'c7', startTime: '2026-10-16T19:00:00Z', assignedUserId: ME }],
    });
    const day = await loadDayRaw({ ...base, live });
    expect(day.source).toBe('live');
    expect(day.calls.map((c) => c.eventId)).toEqual(['e1', 'r1', 'e5', 'e3']);
    expect(day.calls.map((c) => c.callType)).toEqual(['Consult', 'Roadmap', 'Consult', 'Consult']);
    expect(day.calls[1].ghlStatus).toBe('noshow');
    expect(day.calendars.map((c) => c.id)).toEqual(['cal-consult', 'cal-roadmap']);
    expect(calls).toEqual({ calendars: 1, events: 2 });
    const { startMs, endMs } = getDayBounds('2026-10-16', TZ);
    expect(new Date(startMs).toISOString()).toBe('2026-10-16T06:00:00.000Z');
    expect(new Date(endMs).toISOString()).toBe('2026-10-17T05:59:59.999Z');
  });

  it("drops events GHL returns outside the asked window (its filter is day-granular in the calendar's timezone)", async () => {
    // The fake honours the window; GHL does not. Simulate GHL by ignoring the window for this calendar.
    const sloppy: LiveGhl = {
      async listCalendars() {
        return { ok: true, calendars: [{ id: 'cal-consult', name: '15-Minute Fit Physician Consult ', isActive: true }] };
      },
      async listAppointments() {
        return {
          events: [
            { id: 'prev-day', calendarId: 'cal-consult', contactId: 'c0', startTime: '2026-10-12T13:00:00-07:00', assignedUserId: ME }, // Oct 12 14:00 Edmonton
            { id: 'this-day', calendarId: 'cal-consult', contactId: 'c1', startTime: '2026-10-13T07:00:00-07:00', assignedUserId: ME }, // Oct 13 08:00 Edmonton
            { id: 'next-day', calendarId: 'cal-consult', contactId: 'c2', startTime: '2026-10-13T23:30:00-07:00', assignedUserId: ME }, // Oct 14 00:30 Edmonton
          ],
        };
      },
    };
    const day = await loadDayRaw({ ...base, live: sloppy, date: '2026-10-13' });
    expect(day.calls.map((c) => c.eventId)).toEqual(['this-day']);
  });

  it('the calendar filter narrows the live read; an unknown filter id reads nothing (no silent widening)', async () => {
    const { live, calls } = fakeLive({ 'cal-consult': [{ id: 'e1', contactId: 'c1', startTime: '2026-10-16T15:00:00Z', assignedUserId: ME }], 'cal-roadmap': [{ id: 'r1', contactId: 'c6', startTime: '2026-10-16T19:00:00Z', assignedUserId: ME }] });
    const day = await loadDayRaw({ ...base, live, calendarFilter: ['cal-roadmap'] });
    expect(day.calls.map((c) => c.eventId)).toEqual(['r1']);
    expect(calls.events).toBe(1);
    const none = await loadDayRaw({ ...base, live, calendarFilter: ['gone'] });
    expect(none.source).toBe('live');
    expect(none.calls).toEqual([]);
  });

  it('caches a live answer for 2 minutes per user/day/filter; a different day or user is a new read', async () => {
    const { live, calls } = fakeLive({ 'cal-consult': [{ id: 'e1', contactId: 'c1', startTime: '2026-10-16T15:00:00Z', assignedUserId: ME }] });
    const a = await loadDayRaw({ ...base, live });
    const b = await loadDayRaw({ ...base, live, now: new Date(now.getTime() + CACHE_TTL_MS - 1) });
    expect(b).toBe(a);
    expect(b.fetchedAt).toBe(now.toISOString());
    expect(calls.calendars).toBe(1);
    await loadDayRaw({ ...base, live, date: '2026-10-15' });
    await loadDayRaw({ ...base, live, ghlUserId: 'someone-else' });
    await loadDayRaw({ ...base, live, calendarFilter: ['cal-consult'] });
    expect(calls.calendars).toBe(4);
    const c = await loadDayRaw({ ...base, live, now: new Date(now.getTime() + CACHE_TTL_MS) });
    expect(c).not.toBe(a);
    expect(calls.calendars).toBe(5);
  });

  it('falls back to the mirror with asOf + reason when calendars fail, when ONE calendar fails, or when the client throws — and never caches the fallback', async () => {
    const bad = fakeLive({ 'cal-consult': [] }, { calendarsError: 'GHL 401 GET /calendars/: Unauthorized' });
    const d1 = await loadDayRaw({ ...base, live: bad.live });
    expect(d1).toMatchObject({ source: 'mirror', asOf: '2026-10-16T13:07:00.000Z', reason: 'GHL 401 GET /calendars/: Unauthorized', calendars: [] });
    expect(d1.calls.map((c) => c.eventId)).toEqual(['mirror-1']);
    await loadDayRaw({ ...base, live: bad.live });
    expect(bad.calls.calendars).toBe(2); // not cached

    const partial = fakeLive({ 'cal-consult': [{ id: 'e1', contactId: 'c1', startTime: '2026-10-16T15:00:00Z', assignedUserId: ME }], 'cal-roadmap': [] }, { eventsError: { 'cal-roadmap': 'GHL 500' } });
    const d2 = await loadDayRaw({ ...base, live: partial.live });
    expect(d2.source).toBe('mirror');
    expect(d2.reason).toBe('Calendar "Roadmap Building Session": GHL 500');

    const thrower = fakeLive({ 'cal-consult': [] }, { throwOn: 'cal-consult' });
    const d3 = await loadDayRaw({ ...base, live: thrower.live });
    expect(d3).toMatchObject({ source: 'mirror', reason: 'socket hang up' });
  });
});

describe('enrichCalls', () => {
  it('mirror contact first, live read for the unknown ones (capped), "Unknown contact" otherwise; status stamped', async () => {
    const now = new Date('2026-10-16T16:00:00Z');
    const raw = ['c-known', 'c-live', 'c-live2', 'c-nobody'].map((id, i) => ({ eventId: `e${i}`, calendarId: 'cal', calendarName: 'Consult', callType: 'Consult' as const, title: null, startIso: new Date(now.getTime() + (i - 2) * 3_600_000).toISOString(), endIso: null, ghlContactId: id, ghlStatus: i === 0 ? 'showed' : 'confirmed' }));
    const liveReads: string[] = [];
    const calls = await enrichCalls(raw, now, {
      async lookupContacts(ids) {
        expect(ids).toEqual(['c-known', 'c-live', 'c-live2', 'c-nobody']);
        return new Map([['c-known', { contactId: 'ff-1', name: 'Known Person', email: 'k@example.com', phone: null, stage: { name: 'Consult booked', role: 'consult_booked', pipeline: 'Application' } }]]);
      },
      async liveContact(id) {
        liveReads.push(id);
        return id === 'c-live' ? { name: 'Live Person', email: null, phone: '+1 403 555 0100' } : null;
      },
      maxLive: 2,
    });
    expect(liveReads).toEqual(['c-live', 'c-live2']); // c-nobody is past the cap
    expect(calls[0]).toMatchObject({ name: 'Known Person', contactId: 'ff-1', stage: { name: 'Consult booked' }, outcomeInGhl: 'showed', status: 'ghl_outcome', logged: false });
    expect(calls[1]).toMatchObject({ name: 'Live Person', phone: '+1 403 555 0100', contactId: null, stage: null, status: 'needs_outcome' });
    expect(calls[2].name).toBe(unknownName('c-live2'));
    expect(calls[3]).toMatchObject({ name: unknownName('c-nobody'), status: 'up_next' });
  });
});

// ---- the service on PGlite -------------------------------------------------------------------------------------
describe('getMyDay (service)', () => {
  const prov = { source: 'ghl', origin: 'ghl', syncedAt: new Date('2026-10-16T13:00:00Z'), backfilled: false } as const;
  let mirandaId = '';
  beforeAll(async () => {
    await runMigrations();
    await setSetting('timezone', TZ);
    const m = await createUser({ name: 'Miranda', email: 'miranda@example.com', role: 'onboarding', password: 'miranda password', ghlUserId: ME });
    mirandaId = m.id;
    await createUser({ name: 'Nobody', email: 'nobody@example.com', role: 'onboarding', password: 'nobody password' });
    await db.insert(pipelines).values({ id: 'p1', name: '[new] Application Pipeline', isTracked: true, ...prov });
    await db.insert(stages).values({ id: 's1', pipelineId: 'p1', name: 'Consult Booked', position: 2, semanticRole: 'consult_booked', ...prov });
    await db.insert(contacts).values({ ghlContactId: 'c1', pipelineId: 'p1', stageId: 's1', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '+14035550100', ...prov });
    await db.insert(appointments).values([
      { ghlEventId: 'm1', ghlCalendarId: 'cal-consult', calendarName: '15-Minute Fit Physician Consult ', ghlContactId: 'c1', type: 'Consult', startTime: new Date('2026-10-16T17:00:00Z'), endTime: new Date('2026-10-16T17:15:00Z'), timezone: TZ, assignedUserId: ME, ghlStatus: 'confirmed', ...prov },
      { ghlEventId: 'm2', ghlCalendarId: 'cal-consult', calendarName: '15-Minute Fit Physician Consult ', ghlContactId: 'c1', type: 'Consult', startTime: new Date('2026-10-16T19:00:00Z'), timezone: TZ, assignedUserId: 'someone-else', ghlStatus: 'confirmed', ...prov },
      { ghlEventId: 'm3', ghlCalendarId: 'cal-consult', calendarName: '15-Minute Fit Physician Consult ', ghlContactId: 'c1', type: 'Consult', startTime: new Date('2026-10-17T17:00:00Z'), timezone: TZ, assignedUserId: ME, ghlStatus: 'confirmed', ...prov },
    ]);
    await writeMarker({ family: 'ghl.appointments', runId: null, fetched: 3, completedAt: '2026-10-16T13:07:00.000Z' });
  });
  beforeEach(() => clearCompanionCache());
  const now = new Date('2026-10-16T16:00:00Z');
  const asUser = (uid: string, role: 'owner' | 'onboarding', ghlUserId: string | null, name = 'X'): CurrentUser => ({ uid, role, name, email: null, ghlUserId, preferences: {}, source: 'db' });

  it('live: an onboarding user sees her own day, enriched from the mirror, with the counter and the local date', async () => {
    const { live } = fakeLive({ 'cal-consult': [{ id: 'e1', contactId: 'c1', startTime: '2026-10-16T17:00:00Z', assignedUserId: ME, title: 'Consult: Jane' }] });
    const r = await getMyDay({ current: asUser(mirandaId, 'onboarding', ME, 'Miranda'), requestedUserId: null, date: null, now }, { live, enrich: { lookupContacts: (await import('@/lib/companion/mirror')).lookupMirrorContacts, liveContact: async () => null } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.day).toMatchObject({ date: '2026-10-16', today: '2026-10-16', timezone: TZ, source: 'live', viewing: { id: mirandaId, name: 'Miranda', isSelf: true }, counts: { calls: 1, logged: 0, needOutcome: 0 } });
    expect(r.day.calls[0]).toMatchObject({ name: 'Jane Doe', email: 'jane@example.com', stage: { name: 'Consult Booked', pipeline: '[new] Application Pipeline' }, status: 'up_next', callType: 'Consult' });
    // An onboarding login cannot view someone else.
    expect(await getMyDay({ current: asUser(mirandaId, 'onboarding', ME), requestedUserId: 'other', date: null, now }, { live })).toMatchObject({ ok: false, status: 403 });
  });

  it('mirror fallback through the real reader: my rows only, the day window, asOf from the ghl.appointments marker', async () => {
    const { live } = fakeLive({}, { calendarsError: 'No GoHighLevel credentials configured.' });
    const r = await getMyDay({ current: asUser(mirandaId, 'onboarding', ME), requestedUserId: null, date: '2026-10-16', now }, { live, enrich: { lookupContacts: async () => new Map(), liveContact: async () => null } });
    expect(r.ok && r.day).toMatchObject({ source: 'mirror', asOf: '2026-10-16T13:07:00.000Z', reason: 'No GoHighLevel credentials configured.' });
    expect(r.ok && r.day.calls.map((c) => c.eventId)).toEqual(['m1']);
  });

  it('owner without a GHL user auto-picks the first onboarding technician; ?user= picks another; a bad date is 400; no GHL user → source none', async () => {
    const { live } = fakeLive({ 'cal-consult': [] });
    const auto = await getMyDay({ current: asUser('env-owner', 'owner', null, 'Owner'), requestedUserId: null, date: null, now }, { live });
    expect(auto.ok && auto.day.viewing).toMatchObject({ id: mirandaId, isSelf: false, autoPicked: true });
    expect(auto.ok && auto.day.technicians.map((t) => t.name)).toEqual(['Miranda']); // Nobody has no GHL user → not a technician option
    const bad = await getMyDay({ current: asUser('env-owner', 'owner', null), requestedUserId: null, date: '16/10/2026', now }, { live });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const missing = await getMyDay({ current: asUser('env-owner', 'owner', null), requestedUserId: 'nope', date: null, now }, { live });
    expect(missing).toMatchObject({ ok: false, status: 404 });
    const nobody = await getMyDay({ current: asUser('nobody-uid', 'onboarding', null, 'Nobody'), requestedUserId: null, date: null, now }, { live });
    expect(nobody.ok && nobody.day).toMatchObject({ source: 'none', calls: [], counts: { calls: 0, logged: 0, needOutcome: 0 } });
    expect(nobody.ok && nobody.day.reason).toContain('No GoHighLevel user is linked');
  });

  it('the timezone preference moves the day boundary', async () => {
    const { live } = fakeLive({ 'cal-consult': [{ id: 'late', contactId: 'c1', startTime: '2026-10-17T05:30:00Z', assignedUserId: ME }] }); // 23:30 Edmonton = 01:30 Toronto on the 17th
    const edm = await getMyDay({ current: { ...asUser(mirandaId, 'onboarding', ME), preferences: {} }, requestedUserId: null, date: '2026-10-16', now }, { live, cache: false, enrich: { lookupContacts: async () => new Map(), liveContact: async () => null } });
    expect(edm.ok && edm.day.calls.length).toBe(1);
    const tor = await getMyDay({ current: { ...asUser(mirandaId, 'onboarding', ME), preferences: { timezone: 'America/Toronto' } }, requestedUserId: null, date: '2026-10-16', now }, { live, cache: false, enrich: { lookupContacts: async () => new Map(), liveContact: async () => null } });
    expect(tor.ok && tor.day.timezone).toBe('America/Toronto');
    expect(tor.ok && tor.day.calls.length).toBe(0);
  });
});
