/**
 * Companion stage 1 — a raw call + the person behind it: the mirror's contact (name, email, phone, stage, pipeline)
 * by GHL contact id in ONE query; contacts the mirror has not synced yet are read live (`getContact`, at most
 * `maxLive` per request) and otherwise shown as "Unknown contact". Pure over injected readers.
 */

import { outcomeInGhlOf, statusOf, type CompanionCall } from './day';
import type { RawCall } from './source';

export interface MirrorContact {
  contactId: string;
  name: string;
  email: string | null;
  phone: string | null;
  stage: { name: string; role: string | null; pipeline: string | null } | null;
}
export interface LiveContact {
  name: string;
  email: string | null;
  phone: string | null;
}

export interface EnrichDeps {
  lookupContacts(ghlContactIds: string[]): Promise<Map<string, MirrorContact>>;
  liveContact(ghlContactId: string): Promise<LiveContact | null>;
  maxLive?: number;
}

export const MAX_LIVE_CONTACTS = 10;

export function unknownName(ghlContactId: string): string {
  return `Unknown contact ${ghlContactId.slice(0, 6)}…`;
}

export async function enrichCalls(raw: RawCall[], now: Date, deps: EnrichDeps): Promise<CompanionCall[]> {
  const ids = Array.from(new Set(raw.map((r) => r.ghlContactId)));
  const mirror = ids.length ? await deps.lookupContacts(ids) : new Map<string, MirrorContact>();
  const live = new Map<string, LiveContact | null>();
  const maxLive = deps.maxLive ?? MAX_LIVE_CONTACTS;
  for (const id of ids) {
    if (mirror.has(id)) continue;
    if (live.size >= maxLive) break;
    live.set(id, await deps.liveContact(id).catch(() => null));
  }
  return raw.map((r) => {
    const m = mirror.get(r.ghlContactId);
    const l = live.get(r.ghlContactId) ?? null;
    const outcomeInGhl = outcomeInGhlOf(r.ghlStatus);
    const base = { ...r, outcomeInGhl, logged: false as const };
    const call: CompanionCall = {
      ...base,
      contactId: m?.contactId ?? null,
      name: m?.name ?? l?.name ?? unknownName(r.ghlContactId),
      email: m?.email ?? l?.email ?? null,
      phone: m?.phone ?? l?.phone ?? null,
      stage: m?.stage ?? null,
      status: statusOf({ startIso: r.startIso, endIso: r.endIso, outcomeInGhl }, now),
    };
    return call;
  });
}
