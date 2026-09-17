/**
 * Authentication: session tokens, the pure policy, the request interceptor,
 * the login route (constant-time + rate limit), and logout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSession, verifySession, timingSafeEqualBytes, SESSION_COOKIE, SESSION_TTL_SECONDS, SLIDE_AFTER_SECONDS } from '@/lib/auth/session';
import { decide, authMode, isExemptPath, isApiPath } from '@/lib/auth/policy';
import { passwordMatches, checkLoginRateLimit, resetLoginRateLimit, LOGIN_RATE_LIMIT } from '@/lib/auth/login';
import { proxy } from '@/proxy';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { POST as logoutPost } from '@/app/api/auth/logout/route';

const SECRET = 'test-secret-with-enough-entropy-0123456789';
const PROD = { APP_PASSWORD: 'correct horse battery staple', AUTH_SECRET: SECRET, NODE_ENV: 'production', VERCEL_ENV: 'production' };
const NOW = 1_800_000_000;

describe('session tokens', () => {
  it('signs and verifies; a fresh token does not need a refresh', async () => {
    const t = await signSession(SECRET, NOW);
    expect(t.startsWith(`v1.${NOW}.${NOW + SESSION_TTL_SECONDS}.`)).toBe(true);
    const v = await verifySession(t, SECRET, NOW + 60);
    expect(v).toMatchObject({ ok: true, claims: { iat: NOW, exp: NOW + SESSION_TTL_SECONDS }, shouldRefresh: false });
  });

  it('rejects a tampered token, a wrong secret, a malformed token and an expired one', async () => {
    const t = await signSession(SECRET, NOW);
    const [v, iat, exp, sig] = t.split('.');
    expect(await verifySession(`${v}.${iat}.${Number(exp) + 86_400}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' }); // exp edited
    expect(await verifySession(`${v}.${iat}.${exp}.${sig.slice(0, -2)}xx`, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySession(t, 'another-secret', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySession('garbage', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifySession('v1.x.y.z', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifySession(null, SECRET, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifySession(t, SECRET, NOW + SESSION_TTL_SECONDS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('slides: after a day of age the token asks to be re-issued', async () => {
    const t = await signSession(SECRET, NOW);
    expect((await verifySession(t, SECRET, NOW + SLIDE_AFTER_SECONDS - 1)) as { shouldRefresh: boolean }).toMatchObject({ shouldRefresh: false });
    expect((await verifySession(t, SECRET, NOW + SLIDE_AFTER_SECONDS)) as { shouldRefresh: boolean }).toMatchObject({ shouldRefresh: true });
  });

  it('constant-time compare', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('policy', () => {
  it('modes: enforce when both env vars exist; skip locally; closed in production/preview', () => {
    expect(authMode(PROD).mode).toBe('enforce');
    expect(authMode({ NODE_ENV: 'development' })).toEqual({ mode: 'skip', missing: ['APP_PASSWORD', 'AUTH_SECRET'] });
    expect(authMode({ NODE_ENV: 'production' }).mode).toBe('closed');
    expect(authMode({ VERCEL_ENV: 'preview', NODE_ENV: 'production', APP_PASSWORD: 'x' })).toEqual({ mode: 'closed', missing: ['AUTH_SECRET'] });
    expect(authMode({ VERCEL_ENV: 'production', AUTH_SECRET: 'x' })).toEqual({ mode: 'closed', missing: ['APP_PASSWORD'] });
  });

  it('exempt paths: login, static, health, cron, stripe webhook — and nothing else', () => {
    for (const p of ['/login', '/api/auth/login', '/api/auth/logout', '/_next/static/chunks/a.js', '/_next/image?x', '/api/health', '/api/cron/sync-ghl', '/api/cron/dispatch', '/api/stripe/webhook', '/logo.png', '/favicon.ico']) {
      expect(isExemptPath(p), p).toBe(true);
    }
    for (const p of ['/', '/scorecard', '/clients/abc', '/setup', '/api/scorecard', '/api/clients', '/api/settings', '/api/stripe/sync', '/api/stripe/credentials', '/api/cron', '/api/anthropic/ask', '/api/healthz']) {
      expect(isExemptPath(p), p).toBe(false);
    }
    expect(isApiPath('/api/x')).toBe(true);
    expect(isApiPath('/apix')).toBe(false);
  });

  it('decide: exempt allow; page redirect; API 401; valid cookie allow; tampered reject; dev skip; prod fail-closed', async () => {
    const good = await signSession(SECRET, NOW);
    expect(await decide({ pathname: '/api/health', cookie: null, env: PROD, nowSeconds: NOW })).toMatchObject({ action: 'allow', reason: 'exempt' });
    expect(await decide({ pathname: '/scorecard', cookie: null, env: PROD, nowSeconds: NOW })).toMatchObject({ action: 'redirect_login', reason: 'missing' });
    expect(await decide({ pathname: '/api/scorecard', cookie: null, env: PROD, nowSeconds: NOW })).toMatchObject({ action: 'unauthorized_json', reason: 'missing' });
    expect(await decide({ pathname: '/scorecard', cookie: good, env: PROD, nowSeconds: NOW + 10 })).toMatchObject({ action: 'allow', reason: 'session', refresh: false });
    expect(await decide({ pathname: '/api/scorecard', cookie: good, env: PROD, nowSeconds: NOW + 2 * SLIDE_AFTER_SECONDS })).toMatchObject({ action: 'allow', reason: 'session', refresh: true });
    expect(await decide({ pathname: '/scorecard', cookie: good.slice(0, -3) + 'abc', env: PROD, nowSeconds: NOW })).toMatchObject({ action: 'redirect_login', reason: 'bad_signature' });
    expect(await decide({ pathname: '/api/clients', cookie: good.slice(0, -3) + 'abc', env: PROD, nowSeconds: NOW })).toMatchObject({ action: 'unauthorized_json', reason: 'bad_signature' });
    expect(await decide({ pathname: '/scorecard', cookie: null, env: { NODE_ENV: 'development' } })).toMatchObject({ action: 'allow', reason: 'dev_skip' });
    expect(await decide({ pathname: '/scorecard', cookie: good, env: { NODE_ENV: 'production' } })).toMatchObject({ action: 'fail_closed', missing: ['APP_PASSWORD', 'AUTH_SECRET'], api: false });
    expect(await decide({ pathname: '/api/scorecard', cookie: good, env: { VERCEL_ENV: 'production', APP_PASSWORD: 'x' } })).toMatchObject({ action: 'fail_closed', missing: ['AUTH_SECRET'], api: true });
    // Exempt paths stay open even when the app is locked.
    expect(await decide({ pathname: '/api/cron/dispatch', cookie: null, env: { NODE_ENV: 'production' } })).toMatchObject({ action: 'allow', reason: 'exempt' });
  });
});

// ---- the interceptor and routes, with real env ------------------------------
const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const req = (path: string, init: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://fitflow.example${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

beforeEach(() => {
  setEnv({ APP_PASSWORD: PROD.APP_PASSWORD, AUTH_SECRET: SECRET, VERCEL_ENV: 'production' });
  resetLoginRateLimit();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('proxy (request interceptor)', () => {
  it('exempt paths pass without a cookie', async () => {
    for (const p of ['/api/health', '/api/cron/sync-ghl', '/api/stripe/webhook', '/login', '/logo.png']) {
      const res = await proxy(req(p));
      expect(res.status, p).toBe(200);
      expect(res.headers.get('location'), p).toBeNull();
    }
  });

  it('everything else is blocked without a cookie: pages redirect to /login?next=, APIs get 401 JSON', async () => {
    const page = await proxy(req('/clients/abc?tab=x'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('https://fitflow.example/login?next=%2Fclients%2Fabc%3Ftab%3Dx');
    const root = await proxy(req('/'));
    expect(root.headers.get('location')).toBe('https://fitflow.example/login');
    const api = await proxy(req('/api/settings'));
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: 'Unauthorized' });
    expect((await proxy(req('/api/stripe/credentials'))).status).toBe(401);
  });

  it('a valid cookie is accepted; an old one is re-issued (sliding expiry)', async () => {
    const fresh = await signSession(SECRET);
    const res = await proxy(req('/api/settings', { cookie: fresh }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();

    const old = await signSession(SECRET, Math.floor(Date.now() / 1000) - 2 * SLIDE_AFTER_SECONDS);
    const refreshed = await proxy(req('/scorecard', { cookie: old }));
    expect(refreshed.status).toBe(200);
    const cookie = refreshed.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=v1.`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`, 'i'));
  });

  it('a tampered cookie is rejected like no cookie', async () => {
    const good = await signSession(SECRET);
    const tampered = good.replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect((await proxy(req('/scorecard', { cookie: tampered }))).status).toBe(307);
    expect((await proxy(req('/api/scorecard', { cookie: tampered }))).status).toBe(401);
    expect((await proxy(req('/api/scorecard', { cookie: 'not-a-token' }))).status).toBe(401);
  });

  it('production without APP_PASSWORD fails closed with a clear page / JSON; local dev skips', async () => {
    setEnv({ APP_PASSWORD: undefined });
    const page = await proxy(req('/'));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('APP_PASSWORD');
    const api = await proxy(req('/api/clients'));
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: 'Authentication is not configured' });
    expect((await proxy(req('/api/health'))).status).toBe(200); // still exempt

    setEnv({ VERCEL_ENV: undefined, AUTH_SECRET: undefined });
    setEnv({ NODE_ENV: 'test' });
    expect((await proxy(req('/'))).status).toBe(200);
  });
});

describe('login and logout routes', () => {
  it('wrong password → 401, right password → cookie; constant-time compare handles length differences', async () => {
    expect(passwordMatches('a', 'abc')).toBe(false);
    expect(passwordMatches('abc', 'abc')).toBe(true);
    const bad = await loginPost(req('/api/auth/login', { method: 'POST', body: { password: 'nope' } }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const good = await loginPost(req('/api/auth/login', { method: 'POST', body: { password: PROD.APP_PASSWORD } }));
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    const token = cookie.split(';')[0].split('=')[1];
    expect((await verifySession(token, SECRET)).ok).toBe(true);
    expect(JSON.stringify(await good.json())).not.toContain(PROD.APP_PASSWORD);
  });

  it('rate-limits to 5 attempts per minute per IP', async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT; i += 1) {
      expect(checkLoginRateLimit('1.1.1.1', 1000 + i).ok).toBe(true);
    }
    expect(checkLoginRateLimit('1.1.1.1', 2000)).toMatchObject({ ok: false });
    expect(checkLoginRateLimit('2.2.2.2', 2000).ok).toBe(true); // other IP unaffected
    expect(checkLoginRateLimit('1.1.1.1', 1000 + 60_001).ok).toBe(true); // window passed

    resetLoginRateLimit();
    for (let i = 0; i < LOGIN_RATE_LIMIT; i += 1) await loginPost(req('/api/auth/login', { method: 'POST', body: { password: 'x' }, headers: { 'x-forwarded-for': '9.9.9.9' } }));
    const sixth = await loginPost(req('/api/auth/login', { method: 'POST', body: { password: PROD.APP_PASSWORD }, headers: { 'x-forwarded-for': '9.9.9.9' } }));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBeTruthy();
  });

  it('logout clears the cookie', async () => {
    const res = await logoutPost(req('/api/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`, 'i'));
  });
});
