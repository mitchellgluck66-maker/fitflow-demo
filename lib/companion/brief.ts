/**
 * Companion stage 1 — the client brief the pop-out shows (pure assembly over injected readers).
 *
 * Days in pipeline: today − the FOLLOWED-pipeline opportunity's createdAt (ghl_opportunities), else the contact's
 * opportunity_created_at, else the contact's ghl_created_at (labelled "since contact created"), else null —
 * "not in the mirror yet". Notes: the last 3 from GHL's read-only notes endpoint; a read that fails is reported
 * as `unavailable` with the reason, never as "no notes".
 */

import type { CallType } from './calendars';

export const BRIEF_NOTE_COUNT = 3;

export interface BriefContact {
  ghlContactId: string;
  contactId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  stage: { name: string; role: string | null; pipeline: string | null } | null;
  /** The dates that can anchor "days in pipeline", most authoritative first. */
  opportunityCreatedAt: string | null;
  contactOpportunityCreatedAt: string | null;
  contactCreatedAt: string | null;
}

export interface BriefNote {
  id: string;
  body: string;
  dateAdded: string | null;
  author: string | null;
}
export type BriefNotes = { status: 'ok'; items: BriefNote[]; total: number } | { status: 'unavailable'; reason: string };

export interface BriefCall {
  eventId: string;
  callType: CallType;
  calendarName: string;
  startIso: string;
  endIso: string | null;
  title: string | null;
}

export interface DaysInPipeline {
  days: number;
  since: 'application' | 'contact created';
  fromIso: string;
}

export interface ClientBrief {
  contact: { ghlContactId: string; contactId: string | null; name: string; email: string | null; phone: string | null; inMirror: boolean };
  call: BriefCall | null;
  stage: BriefContact['stage'];
  daysInPipeline: DaysInPipeline | null;
  notes: BriefNotes;
}

export function daysInPipelineOf(c: Pick<BriefContact, 'opportunityCreatedAt' | 'contactOpportunityCreatedAt' | 'contactCreatedAt'>, now: Date): DaysInPipeline | null {
  const pick = (iso: string | null, since: DaysInPipeline['since']): DaysInPipeline | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return { days: Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)), since, fromIso: new Date(t).toISOString() };
  };
  return pick(c.opportunityCreatedAt, 'application') ?? pick(c.contactOpportunityCreatedAt, 'application') ?? pick(c.contactCreatedAt, 'contact created');
}

export function shapeNotes(r: { notes: Array<{ id: string; body: string; dateAdded?: string | null; userId?: string | null }>; error?: string }, authorOf: (userId: string | null | undefined) => string | null = () => null): BriefNotes {
  if (r.error) return { status: 'unavailable', reason: r.error };
  return {
    status: 'ok',
    total: r.notes.length,
    items: r.notes.slice(0, BRIEF_NOTE_COUNT).map((n) => ({ id: n.id, body: n.body, dateAdded: n.dateAdded ?? null, author: authorOf(n.userId) })),
  };
}

export function assembleBrief(p: { ghlContactId: string; mirror: BriefContact | null; live: { name: string; email: string | null; phone: string | null } | null; call: BriefCall | null; notes: BriefNotes; now: Date }): ClientBrief {
  const m = p.mirror;
  const name = m?.name || p.live?.name || `Unknown contact ${p.ghlContactId.slice(0, 6)}…`;
  return {
    contact: { ghlContactId: p.ghlContactId, contactId: m?.contactId ?? null, name, email: m?.email ?? p.live?.email ?? null, phone: m?.phone ?? p.live?.phone ?? null, inMirror: m !== null },
    call: p.call,
    stage: m?.stage ?? null,
    daysInPipeline: m ? daysInPipelineOf(m, p.now) : null,
    notes: p.notes,
  };
}

// ---- search --------------------------------------------------------------------------------------------------------

export interface SearchRow {
  ghlContactId: string;
  contactId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  source: 'mirror' | 'live' | 'both';
}

/** Mirror rows first (they carry the FitFlow id), live rows added when new; the live error is reported, not hidden. */
export function mergeSearch(mirror: Array<Omit<SearchRow, 'source'>>, live: { contacts: Array<{ id: string; name: string; email: string | null; phone: string | null }>; error?: string } | null): { results: SearchRow[]; liveError: string | null } {
  const out: SearchRow[] = mirror.map((m) => ({ ...m, source: 'mirror' }));
  const seen = new Set(out.map((r) => r.ghlContactId));
  for (const c of live?.contacts ?? []) {
    const existing = out.find((r) => r.ghlContactId === c.id);
    if (existing) {
      if (existing.source === 'mirror') existing.source = 'both';
      continue;
    }
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ ghlContactId: c.id, contactId: null, name: c.name, email: c.email, phone: c.phone, source: 'live' });
  }
  return { results: out, liveError: live?.error ?? null };
}

export function liveContactName(c: { firstName?: string | null; lastName?: string | null; name?: string | null; contactName?: string | null; email?: string | null; id: string }): string {
  const n = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || (c.name ?? c.contactName ?? '').trim();
  return n || c.email || `Contact ${c.id.slice(0, 6)}…`;
}
