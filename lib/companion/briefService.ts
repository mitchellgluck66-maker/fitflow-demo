/**
 * Companion stage 1 — GET /api/companion/brief and /search behind one call path each, readers injectable.
 */

import { getContact, listContactNotes, listUsers, searchContacts } from '../ghl/client';
import { assembleBrief, liveContactName, mergeSearch, shapeNotes, type BriefCall, type BriefNotes, type ClientBrief, type SearchRow } from './brief';
import { callTypeOf } from './calendars';
import { readBriefContact, readLiveContact, readMirrorEvent, searchMirrorContacts } from './mirror';

export interface BriefDeps {
  readContact?: typeof readBriefContact;
  readEvent?: typeof readMirrorEvent;
  liveContact?: typeof readLiveContact;
  notes?: (ghlContactId: string) => Promise<BriefNotes>;
}

/** Notes through the read-only client; the author is resolved from GHL's user list when it can be read. */
export async function readNotes(ghlContactId: string): Promise<BriefNotes> {
  const r = await listContactNotes(ghlContactId);
  if (r.error) return { status: 'unavailable', reason: r.error };
  const ids = new Set(r.notes.map((n) => n.userId).filter((v): v is string => Boolean(v)));
  let names = new Map<string, string>();
  if (ids.size) {
    const users = await listUsers().catch(() => null);
    if (users?.ok && users.data) names = new Map(users.data.users.map((u) => [u.id, (u.name ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`).trim() || u.id]));
  }
  return shapeNotes(r, (uid) => (uid ? (names.get(uid) ?? null) : null));
}

export async function getBrief(p: { ghlContactId: string; eventId: string | null; call?: BriefCall | null; now?: Date }, deps: BriefDeps = {}): Promise<ClientBrief> {
  const now = p.now ?? new Date();
  const [mirror, event, notes] = await Promise.all([
    (deps.readContact ?? readBriefContact)(p.ghlContactId),
    p.eventId && !p.call ? (deps.readEvent ?? readMirrorEvent)(p.eventId) : Promise.resolve(null),
    (deps.notes ?? readNotes)(p.ghlContactId),
  ]);
  const live = mirror ? null : await (deps.liveContact ?? readLiveContact)(p.ghlContactId);
  const call: BriefCall | null = p.call ?? (event ? { eventId: event.eventId, callType: callTypeOf(event.calendarName, event.title), calendarName: event.calendarName, startIso: event.startIso, endIso: event.endIso, title: event.title } : null);
  return assembleBrief({ ghlContactId: p.ghlContactId, mirror, live, call, notes, now });
}

/** Mirror + live GHL search (the live half's failure is reported, never hidden). */
export async function searchPeople(q: string, deps: { mirror?: typeof searchMirrorContacts; live?: (q: string) => Promise<{ contacts: Array<{ id: string; name: string; email: string | null; phone: string | null }>; error?: string }> } = {}): Promise<{ results: SearchRow[]; liveError: string | null }> {
  const term = q.trim();
  if (term.length < 2) return { results: [], liveError: null };
  const liveFn =
    deps.live ??
    (async (query: string) => {
      const r = await searchContacts(query);
      return { contacts: r.contacts.map((c) => ({ id: c.id, name: liveContactName(c), email: c.email ?? null, phone: c.phone ?? null })), error: r.error };
    });
  const [mirror, live] = await Promise.all([(deps.mirror ?? searchMirrorContacts)(term), liveFn(term).catch((e: unknown) => ({ contacts: [], error: e instanceof Error ? e.message : String(e) }))]);
  return mergeSearch(mirror, live);
}

export { getContact };
