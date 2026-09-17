import { NextRequest, NextResponse } from 'next/server';
import { authMode } from '@/lib/auth/policy';
import { passwordMatches, checkLoginRateLimit, clientIp } from '@/lib/auth/login';
import { SESSION_COOKIE, signSession, sessionCookieOptions } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login { password } — constant-time check against
 * APP_PASSWORD, 5 attempts/min/IP, sets the httpOnly session cookie.
 * The password never appears in any response or log.
 */
export async function POST(request: NextRequest) {
  const { mode, missing } = authMode({ APP_PASSWORD: process.env.APP_PASSWORD, AUTH_SECRET: process.env.AUTH_SECRET, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV });
  if (mode === 'skip') return NextResponse.json({ ok: true, skipped: true, detail: 'Authentication is off in local development (APP_PASSWORD unset).' });
  if (mode === 'closed') return NextResponse.json({ error: 'Authentication is not configured', detail: `Set ${missing.join(' and ')}.` }, { status: 503 });

  const limit = checkLoginRateLimit(clientIp(request.headers));
  if (!limit.ok) {
    const res = NextResponse.json({ error: 'Too many attempts', detail: `Try again in ${limit.retryAfterSec}s.` }, { status: 429 });
    res.headers.set('Retry-After', String(limit.retryAfterSec));
    return res;
  }

  const body = await request.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || !passwordMatches(password, process.env.APP_PASSWORD!)) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await signSession(process.env.AUTH_SECRET!), sessionCookieOptions(request.nextUrl.protocol === 'https:'));
  return res;
}
