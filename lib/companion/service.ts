/**
 * Companion stage 1 — the one call path behind GET /api/companion/day: who is viewed → their timezone and calendar
 * filter → the day (live, cached, or the mirror) → enrichment → status + counter. Readers are injectable for tests.
 */

import { listAppointments, listCalendars } from '../ghl/client';
import { getTimezone, isValidTimezone } from '../settings';
import { todayInTimezone } from '../day';
import type { CurrentUser } from '../auth/currentUser';
import { enrichCalls, type EnrichDeps } from './enrich';
import { loadDayRaw, type LiveGhl, type MirrorReader } from './source';
import { lookupMirrorContacts, readLiveContact, readMirrorDay } from './mirror';
import { resolveViewing, type TechnicianOption, type Viewing } from './viewing';
import { summarize, type CompanionCall, type DayCounts } from './day';

export interface MyDay {
  date: string;
  timezone: string;
  today: string;
  viewing: { id: string; name: string; ghlUserId: string | null; isSelf: boolean; autoPicked: boolean };
  technicians: TechnicianOption[];
  source: 'live' | 'mirror' | 'none';
  fetchedAt: string;
  asOf: string | null;
  reason: string | null;
  calendars: Array<{ id: string; name: string }>;
  calls: CompanionCall[];
  counts: DayCounts;
}

export type MyDayResult = { ok: true; day: MyDay } | { ok: false; status: 400 | 403 | 404; error: string; detail: string };

/** The real read-only GHL client, in the loader's shape. */
export const liveGhl: LiveGhl = {
  async listCalendars() {
    const r = await listCalendars();
    return { ok: r.ok, calendars: r.data?.calendars ?? [], error: r.error };
  },
  async listAppointments(p) {
    const r = await listAppointments(p);
    return { events: r.events, error: r.error };
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The viewed user's timezone: their preference when valid, else the business zone. */
export async function timezoneFor(viewing: Pick<Viewing, 'preferences'>): Promise<string> {
  const pref = viewing.preferences.timezone?.trim();
  if (pref && isValidTimezone(pref)) return pref;
  return getTimezone();
}

export async function getMyDay(
  params: { current: CurrentUser; requestedUserId: string | null; date: string | null; now?: Date },
  deps: { live?: LiveGhl; mirror?: MirrorReader; enrich?: EnrichDeps; cache?: boolean } = {},
): Promise<MyDayResult> {
  const now = params.now ?? new Date();
  const v = await resolveViewing(params.current, params.requestedUserId);
  if (!v.ok) return v;
  const timezone = await timezoneFor(v.viewing);
  const today = todayInTimezone(timezone, now);
  const date = params.date ?? today;
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, status: 400, error: 'Bad date', detail: 'Use YYYY-MM-DD.' };
  const head = { date, timezone, today, viewing: { id: v.viewing.id, name: v.viewing.name, ghlUserId: v.viewing.ghlUserId, isSelf: v.viewing.isSelf, autoPicked: v.viewing.autoPicked }, technicians: v.technicians };
  if (!v.viewing.ghlUserId) {
    return { ok: true, day: { ...head, source: 'none', fetchedAt: now.toISOString(), asOf: null, reason: 'No GoHighLevel user is linked to this login — the owner sets it in Setup → Users.', calendars: [], calls: [], counts: { calls: 0, logged: 0, needOutcome: 0 } } };
  }
  const raw = await loadDayRaw({
    ghlUserId: v.viewing.ghlUserId,
    date,
    timezone,
    calendarFilter: v.viewing.preferences.calendarIds?.length ? v.viewing.preferences.calendarIds : null,
    now,
    live: deps.live ?? liveGhl,
    mirror: deps.mirror ?? readMirrorDay,
    cache: deps.cache,
  });
  const calls = await enrichCalls(raw.calls, now, deps.enrich ?? { lookupContacts: lookupMirrorContacts, liveContact: readLiveContact });
  return { ok: true, day: { ...head, source: raw.source, fetchedAt: raw.fetchedAt, asOf: raw.asOf, reason: raw.reason, calendars: raw.calendars, calls, counts: summarize(calls) } };
}
