import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** POST /api/auth/logout — clears the session cookie. */
export async function POST(request: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(request.nextUrl.protocol === 'https:', 0));
  return res;
}
