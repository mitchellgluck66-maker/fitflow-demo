/**
 * Companion stage 1 — whose day is on screen. An onboarding login always sees itself. An owner sees their own
 * calls when their login carries a GHL user; otherwise (the team password, a dev session, an owner who takes no
 * calls) the first active onboarding user, labelled "Viewing as <name>", or any active user by `?user=<id>`.
 */

import { asc, eq } from 'drizzle-orm';
import { db, appUsers, type CompanionPreferences } from '@/db';
import type { CurrentUser } from '../auth/currentUser';

export interface Viewing {
  id: string;
  name: string;
  ghlUserId: string | null;
  preferences: CompanionPreferences;
  /** The signed-in person is looking at their own day. */
  isSelf: boolean;
  /** Owner only: chosen because the owner's login has no GHL user. */
  autoPicked: boolean;
}

export interface TechnicianOption {
  id: string;
  name: string;
  ghlUserId: string | null;
}

export type ViewingResult = { ok: true; viewing: Viewing; technicians: TechnicianOption[] } | { ok: false; status: 403 | 404; error: string; detail: string };

export async function resolveViewing(current: CurrentUser, requestedUserId: string | null): Promise<ViewingResult> {
  const self: Viewing = { id: current.uid, name: current.name, ghlUserId: current.ghlUserId, preferences: current.preferences, isSelf: true, autoPicked: false };
  if (current.role !== 'owner') {
    if (requestedUserId && requestedUserId !== current.uid) return { ok: false, status: 403, error: 'Forbidden', detail: 'An onboarding login can only view its own day.' };
    return { ok: true, viewing: self, technicians: [] };
  }
  const rows = await db.select({ id: appUsers.id, name: appUsers.name, ghlUserId: appUsers.ghlUserId, preferences: appUsers.preferences, role: appUsers.role }).from(appUsers).where(eq(appUsers.active, true)).orderBy(asc(appUsers.createdAt));
  const technicians: TechnicianOption[] = rows.filter((r) => r.ghlUserId).map((r) => ({ id: r.id, name: r.name, ghlUserId: r.ghlUserId }));
  if (requestedUserId && requestedUserId !== current.uid) {
    const r = rows.find((x) => x.id === requestedUserId);
    if (!r) return { ok: false, status: 404, error: 'No such user', detail: 'The user is missing or disabled.' };
    return { ok: true, viewing: { id: r.id, name: r.name, ghlUserId: r.ghlUserId, preferences: r.preferences ?? {}, isSelf: false, autoPicked: false }, technicians };
  }
  if (current.ghlUserId) return { ok: true, viewing: self, technicians };
  const first = rows.find((r) => r.role === 'onboarding' && r.ghlUserId);
  if (first) return { ok: true, viewing: { id: first.id, name: first.name, ghlUserId: first.ghlUserId, preferences: first.preferences ?? {}, isSelf: false, autoPicked: true }, technicians };
  return { ok: true, viewing: self, technicians };
}
