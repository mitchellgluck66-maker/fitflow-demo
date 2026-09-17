/**
 * Request interceptor (Next 16's `proxy.ts`, the successor to middleware.ts):
 * every page and API route requires a valid session cookie. Exemptions and
 * modes live in lib/auth/policy.ts; this file only turns a decision into a
 * response.
 *
 *   page, no session      → 302 /login?next=<path>
 *   API, no session       → 401 JSON
 *   production, no APP_PASSWORD / AUTH_SECRET → fails CLOSED (503 + clear text)
 *   local dev, unset      → auth skipped
 * A valid session older than a day is re-issued (30-day sliding expiry).
 */

import { NextRequest, NextResponse } from 'next/server';
import { decide } from './lib/auth/policy';
import { SESSION_COOKIE, signSession, sessionCookieOptions } from './lib/auth/session';

const env = () => ({
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,
});

function failClosedHtml(missing: string[]): string {
  const list = missing.map((m) => `<code>${m}</code>`).join(' and ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FitFlow — locked</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,-apple-system,system-ui,sans-serif;background:#08090a;color:#e6e7ea}
main{max-width:520px;padding:32px;border:1px solid #26282d;border-radius:14px;background:#0f1013}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;line-height:1.55;color:#a1a5ad;margin:0 0 10px}code{color:#c4b5fd}</style></head>
<body><main><h1>FitFlow is locked</h1><p>This deployment holds real client data, so it refuses every request until authentication is configured.</p>
<p>Set ${list} in the Vercel project's environment variables and redeploy. See README → Authentication.</p></main></body></html>`;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const decision = await decide({ pathname, cookie: request.cookies.get(SESSION_COOKIE)?.value, env: env() });

  switch (decision.action) {
    case 'allow': {
      if (!decision.refresh) return NextResponse.next();
      // Sliding expiry: re-issue the cookie on an active session.
      const res = NextResponse.next();
      res.cookies.set(SESSION_COOKIE, await signSession(process.env.AUTH_SECRET!), sessionCookieOptions(request.nextUrl.protocol === 'https:'));
      return res;
    }
    case 'unauthorized_json':
      return NextResponse.json({ error: 'Unauthorized', detail: 'Sign in at /login' }, { status: 401 });
    case 'redirect_login': {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.search = '';
      const next = `${pathname}${search}`;
      if (next !== '/') url.searchParams.set('next', next);
      return NextResponse.redirect(url);
    }
    case 'fail_closed':
      return decision.api
        ? NextResponse.json({ error: 'Authentication is not configured', detail: `Set ${decision.missing.join(' and ')} in the environment.` }, { status: 503 })
        : new NextResponse(failClosedHtml(decision.missing), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
}

export const config = {
  // Everything except Next's own static output; /public files and the
  // documented exemptions are handled inside decide().
  matcher: ['/((?!_next/static|_next/image).*)'],
};
