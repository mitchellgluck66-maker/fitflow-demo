/**
 * Companion stage 1 — where a day's calls come from: LIVE from GoHighLevel (read-only client, injected), cached for
 * two minutes; on any failure the MIRROR (our synced `appointments`) with `source: 'mirror'`, `asOf` and the reason.
 * A fallback result is never cached, so the next request tries GHL again. Pure except for the module cache.
 */

import { getDayBounds } from '../day';
import { callTypeOf, calendarLabel, inCalendarFilter, isAssignedTo } from './calendars';
import type { CallType } from './calendars';

export const CACHE_TTL_MS = 120_000;

export interface RawCall {
  eventId: string;
  calendarId: string;
  calendarName: string;
  callType: CallType;
  title: string | null;
  startIso: string;
  endIso: string | null;
  ghlContactId: string;
  ghlStatus: string | null;
}

export interface LiveCalendar {
  id: string;
  name: string;
  isActive?: boolean | null;
}
export interface LiveEvent {
  id: string;
  calendarId: string;
  contactId: string;
  title?: string | null;
  startTime: string;
  endTime?: string | null;
  appointmentStatus?: string | null;
  assignedUserId?: string | null;
  users?: string[] | null;
}

/** The read-only GHL calls the loader needs — `lib/ghl/client` in production, fakes in tests. */
export interface LiveGhl {
  listCalendars(): Promise<{ ok: boolean; calendars: LiveCalendar[]; error?: string }>;
  listAppointments(p: { startTimeMs: number; endTimeMs: number; calendarId: string }): Promise<{ events: LiveEvent[]; error?: string }>;
}

export interface MirrorResult {
  rows: RawCall[];
  /** When the mirror last completed an appointments fetch (the `ghl.appointments` marker), else the newest row's sync. */
  asOf: string | null;
}
export type MirrorReader = (p: { ghlUserId: string; startMs: number; endMs: number; calendarFilter: string[] | null }) => Promise<MirrorResult>;

export interface DaySource {
  source: 'live' | 'mirror';
  /** When this answer was produced (a cached live answer keeps its original time). */
  fetchedAt: string;
  asOf: string | null;
  /** Why the mirror was used (no token ever appears here — the client strips it). */
  reason: string | null;
  calls: RawCall[];
  /** The calendars the live read covered (after the filter). Empty on a mirror answer. */
  calendars: Array<{ id: string; name: string }>;
}

export interface LoadDayParams {
  ghlUserId: string;
  /** YYYY-MM-DD in `timezone`. */
  date: string;
  timezone: string;
  calendarFilter: string[] | null;
  now: Date;
  live: LiveGhl;
  mirror: MirrorReader;
  /** Tests: bypass the module cache. */
  cache?: boolean;
}

type CacheEntry = { expiresAt: number; value: DaySource };
const cache = new Map<string, CacheEntry>();

export function clearCompanionCache(): void {
  cache.clear();
}

export function cacheKey(p: { ghlUserId: string; date: string; timezone: string; calendarFilter: string[] | null }): string {
  return `${p.ghlUserId}|${p.date}|${p.timezone}|${(p.calendarFilter ?? []).slice().sort().join(',')}`;
}

function toRaw(e: LiveEvent, calendar: { id: string; name: string }): RawCall {
  return {
    eventId: e.id,
    calendarId: calendar.id,
    calendarName: calendar.name,
    callType: callTypeOf(calendar.name, e.title),
    title: e.title ?? null,
    startIso: new Date(e.startTime).toISOString(),
    endIso: e.endTime ? new Date(e.endTime).toISOString() : null,
    ghlContactId: e.contactId,
    ghlStatus: e.appointmentStatus ?? null,
  };
}

const byStart = (a: RawCall, b: RawCall) => Date.parse(a.startIso) - Date.parse(b.startIso) || a.eventId.localeCompare(b.eventId);

/** Live first (cached 2 min), mirror on failure. Never throws for a GHL problem — it reports it. */
export async function loadDayRaw(p: LoadDayParams): Promise<DaySource> {
  const key = cacheKey(p);
  const useCache = p.cache !== false;
  if (useCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > p.now.getTime()) return hit.value;
  }
  const { startMs, endMs } = getDayBounds(p.date, p.timezone);
  const live = await readLive(p, startMs, endMs);
  if (live.ok) {
    const value: DaySource = { source: 'live', fetchedAt: p.now.toISOString(), asOf: p.now.toISOString(), reason: null, calls: live.calls.sort(byStart), calendars: live.calendars };
    if (useCache) cache.set(key, { expiresAt: p.now.getTime() + CACHE_TTL_MS, value });
    return value;
  }
  const mirror = await p.mirror({ ghlUserId: p.ghlUserId, startMs, endMs, calendarFilter: p.calendarFilter });
  return { source: 'mirror', fetchedAt: p.now.toISOString(), asOf: mirror.asOf, reason: live.error, calls: mirror.rows.slice().sort(byStart), calendars: [] };
}

async function readLive(p: LoadDayParams, startMs: number, endMs: number): Promise<{ ok: true; calls: RawCall[]; calendars: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  try {
    const cals = await p.live.listCalendars();
    if (!cals.ok) return { ok: false, error: cals.error ?? 'GoHighLevel calendars could not be read' };
    const active = cals.calendars.filter((c) => c.isActive !== false && inCalendarFilter(c.id, p.calendarFilter)).map((c) => ({ id: c.id, name: calendarLabel(c.name, c.id) }));
    const calls: RawCall[] = [];
    for (const cal of active) {
      const res = await p.live.listAppointments({ startTimeMs: startMs, endTimeMs: endMs, calendarId: cal.id });
      // One calendar failing would silently drop its calls: the whole day falls back instead.
      if (res.error) return { ok: false, error: `Calendar "${cal.name}": ${res.error}` };
      for (const e of res.events) if (isAssignedTo(e, p.ghlUserId)) calls.push(toRaw(e, cal));
    }
    return { ok: true, calls, calendars: active };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
