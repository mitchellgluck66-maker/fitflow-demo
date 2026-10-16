/**
 * App users — the data layer behind Setup → Users and the login route (Companion stage 1). Every function here
 * returns a public shape with NO password hash; the hash is written by `createUser` / `setPassword` only.
 */

import { asc, eq, sql } from 'drizzle-orm';
import { db, appUsers, APP_USER_ROLES, type AppUser, type AppUserRole, type CompanionPreferences } from '@/db';
import { hashPassword, passwordProblem, verifyPassword } from './password';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: AppUserRole;
  ghlUserId: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export class UserInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 404 = 400,
  ) {
    super(message);
    this.name = 'UserInputError';
  }
}

export function toPublic(row: AppUser): PublicUser {
  return { id: row.id, name: row.name, email: row.email, role: row.role, ghlUserId: row.ghlUserId, active: row.active, createdAt: row.createdAt.toISOString(), lastLoginAt: row.lastLoginAt?.toISOString() ?? null };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(email: unknown): string {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(e)) throw new UserInputError('Enter a valid email address.');
  return e;
}

function cleanRole(role: unknown): AppUserRole {
  if (!APP_USER_ROLES.includes(role as AppUserRole)) throw new UserInputError(`Role must be one of ${APP_USER_ROLES.join(', ')}.`);
  return role as AppUserRole;
}

function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new UserInputError('Enter a name.');
  return n.slice(0, 120);
}

function cleanGhlUserId(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new UserInputError('GHL user id must be the id from GoHighLevel (letters and digits).');
  return v;
}

export async function listAppUsers(): Promise<PublicUser[]> {
  const rows = await db.select().from(appUsers).orderBy(asc(appUsers.createdAt));
  return rows.map(toPublic);
}

export async function findUserByEmail(email: string): Promise<AppUser | null> {
  const rows = await db
    .select()
    .from(appUsers)
    .where(eq(sql`lower(${appUsers.email})`, email.trim().toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAppUser(id: string): Promise<AppUser | null> {
  const rows = await db.select().from(appUsers).where(eq(appUsers.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createUser(input: { name: unknown; email: unknown; role: unknown; password: unknown; ghlUserId?: unknown }): Promise<PublicUser> {
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const role = cleanRole(input.role);
  const ghlUserId = cleanGhlUserId(input.ghlUserId);
  const password = typeof input.password === 'string' ? input.password : '';
  const problem = passwordProblem(password);
  if (problem) throw new UserInputError(problem);
  if (await findUserByEmail(email)) throw new UserInputError('A user with that email already exists.', 409);
  const [row] = await db.insert(appUsers).values({ name, email, role, passwordHash: hashPassword(password), ghlUserId }).returning();
  return toPublic(row);
}

export async function updateUser(id: string, patch: { name?: unknown; role?: unknown; ghlUserId?: unknown; active?: unknown; password?: unknown }): Promise<PublicUser> {
  const row = await getAppUser(id);
  if (!row) throw new UserInputError('No such user.', 404);
  const set: Partial<typeof appUsers.$inferInsert> = {};
  if (patch.name !== undefined) set.name = cleanName(patch.name);
  if (patch.role !== undefined) set.role = cleanRole(patch.role);
  if (patch.ghlUserId !== undefined) set.ghlUserId = cleanGhlUserId(patch.ghlUserId);
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw new UserInputError('active must be true or false.');
    set.active = patch.active;
  }
  if (patch.password !== undefined) {
    const password = typeof patch.password === 'string' ? patch.password : '';
    const problem = passwordProblem(password);
    if (problem) throw new UserInputError(problem);
    set.passwordHash = hashPassword(password);
  }
  if (Object.keys(set).length === 0) return toPublic(row);
  const [updated] = await db.update(appUsers).set(set).where(eq(appUsers.id, id)).returning();
  return toPublic(updated);
}

/** The user changes their own password: the current one must verify. */
export async function changeOwnPassword(id: string, current: unknown, next: unknown): Promise<void> {
  const row = await getAppUser(id);
  if (!row) throw new UserInputError('No such user.', 404);
  if (!verifyPassword(typeof current === 'string' ? current : '', row.passwordHash)) throw new UserInputError('Current password is wrong.', 400);
  const password = typeof next === 'string' ? next : '';
  const problem = passwordProblem(password);
  if (problem) throw new UserInputError(problem);
  await db.update(appUsers).set({ passwordHash: hashPassword(password) }).where(eq(appUsers.id, id));
}

/** Merge Companion preferences (item 4) — unknown keys dropped, each value validated by the caller. */
export async function savePreferences(id: string, prefs: CompanionPreferences): Promise<CompanionPreferences> {
  const row = await getAppUser(id);
  if (!row) throw new UserInputError('No such user.', 404);
  const merged: CompanionPreferences = { ...(row.preferences ?? {}), ...prefs };
  await db.update(appUsers).set({ preferences: merged }).where(eq(appUsers.id, id));
  return merged;
}
