/**
 * Auth policy — PURE decisions the request interceptor (proxy.ts) turns into
 * responses. Everything is protected by default; the exemptions are exactly
 * the paths that already carry their own guard.
 *
 * Modes (from env):
 *   enforce   APP_PASSWORD + AUTH_SECRET set → sessions required
 *   skip      neither set AND not production → local dev, no auth
 *   closed    production without APP_PASSWORD or AUTH_SECRET → every
 *             protected request gets a clear error; nothing leaks
 *
 * Roles (Companion stage 1): a valid session carries `owner` or `onboarding`.
 * `owner` reaches everything; `onboarding` reaches ONLY the Companion
 * (`roleAllows`) — any other page is sent to /companion, any other API is 403.
 */

import { verifySession, type SessionCheck, type SessionClaims, type SessionRole } from './session';

export type AuthMode = 'enforce' | 'skip' | 'closed';

export interface AuthEnv {
  APP_PASSWORD?: string;
  AUTH_SECRET?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}

export function isProductionLike(env: AuthEnv): boolean {
  return env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview' || env.NODE_ENV === 'production';
}

export function authMode(env: AuthEnv): { mode: AuthMode; missing: string[] } {
  const missing: string[] = [];
  if (!env.APP_PASSWORD?.trim()) missing.push('APP_PASSWORD');
  if (!env.AUTH_SECRET?.trim()) missing.push('AUTH_SECRET');
  if (missing.length === 0) return { mode: 'enforce', missing };
  return { mode: isProductionLike(env) ? 'closed' : 'skip', missing };
}

/**
 * Paths that stay open. Each has its own guard:
 *   /login                 the gate itself (+ its API)
 *   /_next/*, static files served by Next / public
 *   /api/health            liveness for Vercel checks (no data)
 *   /api/version           the build's commit + time (no data; confirms a deploy from outside)
 *   /api/cron/*            CRON_SECRET bearer
 *   /api/stripe/webhook    Stripe signature
 */
export function isExemptPath(pathname: string): boolean {
  if (pathname === '/login' || pathname === '/api/auth/login' || pathname === '/api/auth/logout') return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname === '/api/health' || pathname === '/api/version') return true;
  if (pathname.startsWith('/api/cron/')) return true;
  if (pathname === '/api/stripe/webhook') return true;
  if (pathname === '/favicon.ico' || pathname === '/robots.txt') return true;
  // Static assets from /public (images, fonts) — no data behind them.
  if (/\.(png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?|ttf|css|js|map|txt|xml)$/i.test(pathname)) return true;
  return false;
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** The Companion's home — where an onboarding login lands and is sent back to. */
export const COMPANION_HOME = '/companion';

/** True for the Companion's pages and APIs (`/companion`, `/companion/*`, `/api/companion/*`). */
export function isCompanionPath(pathname: string): boolean {
  return pathname === COMPANION_HOME || pathname.startsWith(`${COMPANION_HOME}/`) || pathname.startsWith('/api/companion/');
}

/** Pure: may this role reach this path? Exempt paths are decided before this is asked. */
export function roleAllows(role: SessionRole, pathname: string): boolean {
  if (role === 'owner') return true;
  // onboarding: the Companion, and signing out.
  return isCompanionPath(pathname) || pathname.startsWith('/api/auth/');
}

export type SessionFailure = Extract<SessionCheck, { ok: false }>['reason'];

export type AuthDecision =
  | { action: 'allow'; reason: 'exempt' | 'dev_skip' | 'session'; refresh: boolean; claims?: SessionClaims }
  | { action: 'redirect_login'; reason: SessionFailure }
  | { action: 'unauthorized_json'; reason: SessionFailure }
  /** A signed-in onboarding user asked for a page outside the Companion → send them home. */
  | { action: 'redirect_companion'; role: SessionRole }
  /** … or an API outside it → 403, never data. */
  | { action: 'forbidden_json'; role: SessionRole }
  | { action: 'fail_closed'; missing: string[]; api: boolean };

export async function decide(params: { pathname: string; cookie: string | null | undefined; env: AuthEnv; nowSeconds?: number }): Promise<AuthDecision> {
  const { pathname, cookie, env } = params;
  if (isExemptPath(pathname)) return { action: 'allow', reason: 'exempt', refresh: false };

  const { mode, missing } = authMode(env);
  if (mode === 'skip') return { action: 'allow', reason: 'dev_skip', refresh: false };
  if (mode === 'closed') return { action: 'fail_closed', missing, api: isApiPath(pathname) };

  const check = await verifySession(cookie, env.AUTH_SECRET!, params.nowSeconds);
  if (!check.ok) return isApiPath(pathname) ? { action: 'unauthorized_json', reason: check.reason } : { action: 'redirect_login', reason: check.reason };
  if (!roleAllows(check.claims.role, pathname)) {
    return isApiPath(pathname) ? { action: 'forbidden_json', role: check.claims.role } : { action: 'redirect_companion', role: check.claims.role };
  }
  return { action: 'allow', reason: 'session', refresh: check.shouldRefresh, claims: check.claims };
}
