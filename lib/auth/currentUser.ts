/**
 * The signed-in person, server side (Companion stage 1). The interceptor already proved the cookie; this re-reads
 * the app_users row so a user disabled a minute ago is refused on their next call even though the token is valid.
 *
 *   source 'db'   an app_users row (v2 token)
 *   source 'env'  the team password (uid env-owner, or any v1 token) — an owner with no row and no preferences
 *   source 'dev'  local development with auth off — treated as an owner
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, appUsers, type AppUser, type AppUserRole, type CompanionPreferences } from '@/db';
import { authMode } from './policy';
import { ENV_OWNER_UID, SESSION_COOKIE, verifySession } from './session';

export interface CurrentUser {
  uid: string;
  role: AppUserRole;
  name: string;
  email: string | null;
  ghlUserId: string | null;
  preferences: CompanionPreferences;
  source: 'db' | 'env' | 'dev';
  /** Set for source 'db' — the row itself (never sent to a client). */
  row?: AppUser;
}

export type CurrentUserResult = { ok: true; user: CurrentUser } | { ok: false; status: 401 | 503; error: string; detail: string };

export function userFromRow(row: AppUser): CurrentUser {
  return { uid: row.id, role: row.role, name: row.name, email: row.email, ghlUserId: row.ghlUserId, preferences: row.preferences ?? {}, source: 'db', row };
}

const envOwner = (): CurrentUser => ({ uid: ENV_OWNER_UID, role: 'owner', name: 'Owner', email: null, ghlUserId: null, preferences: {}, source: 'env' });

/** Resolve a cookie value (already verified or not) to the current user — the pure-ish core, also used by tests. */
export async function resolveUser(cookie: string | null | undefined, env: { APP_PASSWORD?: string; AUTH_SECRET?: string; NODE_ENV?: string; VERCEL_ENV?: string }): Promise<CurrentUserResult> {
  const { mode, missing } = authMode(env);
  if (mode === 'skip') return { ok: true, user: { ...envOwner(), uid: 'dev', name: 'Developer', source: 'dev' } };
  if (mode === 'closed') return { ok: false, status: 503, error: 'Authentication is not configured', detail: `Set ${missing.join(' and ')} in the environment.` };
  const check = await verifySession(cookie, env.AUTH_SECRET!);
  if (!check.ok) return { ok: false, status: 401, error: 'Unauthorized', detail: 'Sign in at /login' };
  if (check.claims.version === 'v1' || check.claims.uid === ENV_OWNER_UID) return { ok: true, user: envOwner() };
  const rows = await db.select().from(appUsers).where(eq(appUsers.id, check.claims.uid)).limit(1);
  const row = rows[0];
  if (!row || !row.active) return { ok: false, status: 401, error: 'Account disabled or removed', detail: 'Sign in again, or ask the owner to re-enable this login.' };
  return { ok: true, user: userFromRow(row) };
}

/** The current user from the request's cookies (route handlers / server components). */
export async function currentUser(): Promise<CurrentUserResult> {
  const jar = await cookies();
  return resolveUser(jar.get(SESSION_COOKIE)?.value, {
    APP_PASSWORD: process.env.APP_PASSWORD,
    AUTH_SECRET: process.env.AUTH_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
}

/** The JSON response for a failed resolution (401 / 503). */
export function userErrorResponse(r: Extract<CurrentUserResult, { ok: false }>): NextResponse {
  return NextResponse.json({ error: r.error, detail: r.detail }, { status: r.status });
}

/** Owner-only routes (Users): a second check behind the interceptor's role rule. */
export async function requireOwner(): Promise<{ ok: true; user: CurrentUser } | { ok: false; response: NextResponse }> {
  const r = await currentUser();
  if (!r.ok) return { ok: false, response: userErrorResponse(r) };
  if (r.user.role !== 'owner') return { ok: false, response: NextResponse.json({ error: 'Forbidden', detail: 'Owners only.' }, { status: 403 }) };
  return { ok: true, user: r.user };
}
