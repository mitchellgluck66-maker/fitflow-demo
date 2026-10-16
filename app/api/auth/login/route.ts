import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db, appUsers } from '@/db';
import { authMode, COMPANION_HOME } from '@/lib/auth/policy';
import { passwordMatches, checkLoginRateLimit, clientIp } from '@/lib/auth/login';
import { verifyPassword } from '@/lib/auth/password';
import { ENV_OWNER, SESSION_COOKIE, signSession, sessionCookieOptions, type SessionIdentity } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login { email?, password } — 5 attempts/min/IP, sets the httpOnly session cookie.
 *
 *   email names an ACTIVE app_users row → scrypt check → a v2 session for that person (last_login_at updated)
 *   email names a DISABLED row           → 401 "This account is disabled"
 *   otherwise                            → the team password (APP_PASSWORD, constant time) → the env owner
 *   otherwise                            → 401 "Wrong email or password" (the same text for an unknown email)
 *
 * The password never appears in any response or log; the body is read once and only its two strings are used.
 */
export async function POST(request: NextRequest) {
  const { mode, missing } = authMode({ APP_PASSWORD: process.env.APP_PASSWORD, AUTH_SECRET: process.env.AUTH_SECRET, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV });
  if (mode === 'skip') return NextResponse.json({ ok: true, skipped: true, home: '/', detail: 'Authentication is off in local development (APP_PASSWORD unset).' });
  if (mode === 'closed') return NextResponse.json({ error: 'Authentication is not configured', detail: `Set ${missing.join(' and ')}.` }, { status: 503 });

  const limit = checkLoginRateLimit(clientIp(request.headers));
  if (!limit.ok) {
    const res = NextResponse.json({ error: 'Too many attempts', detail: `Try again in ${limit.retryAfterSec}s.` }, { status: 429 });
    res.headers.set('Retry-After', String(limit.retryAfterSec));
    return res;
  }

  const body = await request.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!password) return NextResponse.json({ error: 'Wrong email or password' }, { status: 401 });

  let identity: SessionIdentity | null = null;
  let home = '/';
  if (email) {
    const rows = await db.select().from(appUsers).where(eq(sql`lower(${appUsers.email})`, email)).limit(1);
    const row = rows[0];
    if (row) {
      if (!row.active) return NextResponse.json({ error: 'This account is disabled', detail: 'Ask the owner to re-enable it.' }, { status: 401 });
      if (verifyPassword(password, row.passwordHash)) {
        identity = { uid: row.id, role: row.role };
        home = row.role === 'onboarding' ? COMPANION_HOME : '/';
        await db.update(appUsers).set({ lastLoginAt: new Date() }).where(eq(appUsers.id, row.id));
      }
    }
  }
  if (!identity && passwordMatches(password, process.env.APP_PASSWORD!)) identity = ENV_OWNER;
  if (!identity) return NextResponse.json({ error: 'Wrong email or password' }, { status: 401 });

  const res = NextResponse.json({ ok: true, role: identity.role, home });
  res.cookies.set(SESSION_COOKIE, await signSession(process.env.AUTH_SECRET!, identity), sessionCookieOptions(request.nextUrl.protocol === 'https:'));
  return res;
}
