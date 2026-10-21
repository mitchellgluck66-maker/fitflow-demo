/**
 * Companion stage 1, item 1 — per-person logins and roles: scrypt hashing, v2 tokens (+ v1 compatibility), the role
 * rule on EVERY route group, the interceptor end to end, the login route against PGlite, the Users API (owner only),
 * currentUser's re-check of `active`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { hashPassword, verifyPassword, passwordProblem, MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { signSession, verifySession, ENV_OWNER, SESSION_COOKIE, SLIDE_AFTER_SECONDS } from '@/lib/auth/session';
import { decide, roleAllows, isCompanionPath, COMPANION_HOME } from '@/lib/auth/policy';
import { resetLoginRateLimit } from '@/lib/auth/login';
import { createUser, updateUser, listAppUsers, changeOwnPassword, savePreferences, UserInputError, getAppUser } from '@/lib/auth/users';
import { resolveUser } from '@/lib/auth/currentUser';
import { proxy } from '@/proxy';
import { POST as loginPost } from '@/app/api/auth/login/route';

const SECRET = 'test-secret-with-enough-entropy-0123456789';
const PROD = { APP_PASSWORD: 'correct horse battery staple', AUTH_SECRET: SECRET, NODE_ENV: 'production', VERCEL_ENV: 'production' };
const NOW = 1_800_000_000;

/** Every page and API group the app has (the nav + the dormant routes + the API families), for the role rule. */
const OWNER_ONLY_PAGES = ['/', '/scorecard', '/funnel', '/ads', '/revenue', '/clients', '/clients/abc', '/onboarding', '/reports', '/setup', '/metrics', '/settings', '/today', '/audit-log', '/companionx'];
const OWNER_ONLY_APIS = ['/api/scorecard', '/api/scorecard/view', '/api/onboarding', '/api/reports/settings', '/api/settings', '/api/users', '/api/users/abc', '/api/clients', '/api/clients/abc', '/api/analyst/turns', '/api/anthropic/ask', '/api/sync', '/api/sync/status', '/api/sync-health', '/api/payments', '/api/spend', '/api/meta/token', '/api/ghl/reconcile', '/api/incidents', '/api/appointments', '/api/contacts', '/api/currency', '/api/reconciliation', '/api/companionx'];
const COMPANION_PATHS = ['/companion', '/companion/settings', '/companion/popout', '/api/companion/day', '/api/companion/me', '/api/companion/brief', '/api/companion/settings', '/api/companion/password', '/api/auth/logout'];

describe('passwords (scrypt)', () => {
  it('hashes with a random salt, verifies, and rejects the wrong password / a malformed hash', () => {
    const h1 = hashPassword('a strong enough one');
    const h2 = hashPassword('a strong enough one');
    expect(h1.startsWith('scrypt$N=16384,r=8,p=1$')).toBe(true);
    expect(h1).not.toBe(h2); // salted
    expect(verifyPassword('a strong enough one', h1)).toBe(true);
    expect(verifyPassword('a strong enough one', h2)).toBe(true);
    expect(verifyPassword('a strong enough onE', h1)).toBe(false);
    expect(verifyPassword('', h1)).toBe(false);
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', 'sha256$abc')).toBe(false);
    expect(verifyPassword('x', 'scrypt$N=0,r=8,p=1$AAAA$BBBB')).toBe(false);
  });
  it('the password rule', () => {
    expect(passwordProblem('short')).toBe(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    expect(passwordProblem(' padded padded')).toBe('A password cannot start or end with a space.');
    expect(passwordProblem('long enough now')).toBeNull();
  });
});

describe('session v2 and the v1 compatibility', () => {
  it('a v2 token carries uid + role; a v1 token still verifies as the env owner', async () => {
    const t = await signSession(SECRET, { uid: 'user-1', role: 'onboarding' }, NOW);
    expect(t.startsWith(`v2.${NOW}.`)).toBe(true);
    expect(await verifySession(t, SECRET, NOW + 1)).toMatchObject({ ok: true, claims: { uid: 'user-1', role: 'onboarding', version: 'v2' } });
    // A v1 token minted by the shared-password code (the exact shape it used): HMAC over `v1.<iat>.<exp>`.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const payload = `v1.${NOW}.${NOW + 86_400}`;
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
    const b64 = btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifySession(`${payload}.${b64}`, SECRET, NOW + 1)).toMatchObject({ ok: true, claims: { uid: 'env-owner', role: 'owner', version: 'v1' } });
    // A v2 token with a made-up role or a bad uid is malformed; an edited role is a bad signature.
    expect(await verifySession(`v2.${NOW}.${NOW + 10}.u.admin.abc`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifySession(`v2.${NOW}.${NOW + 10}.bad uid.owner.abc`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifySession(t.replace('.onboarding.', '.owner.'), SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    await expect(signSession(SECRET, { uid: 'x', role: 'admin' as never })).rejects.toThrow();
  });
});

describe('role rule — every route group', () => {
  it('onboarding reaches only the Companion (+ sign-out); owner reaches everything', () => {
    for (const p of [...OWNER_ONLY_PAGES, ...OWNER_ONLY_APIS]) {
      expect(roleAllows('onboarding', p), p).toBe(false);
      expect(roleAllows('owner', p), p).toBe(true);
    }
    for (const p of COMPANION_PATHS) {
      expect(roleAllows('onboarding', p), p).toBe(true);
      expect(roleAllows('owner', p), p).toBe(true);
    }
    expect(isCompanionPath('/companion')).toBe(true);
    expect(isCompanionPath('/companionx')).toBe(false);
    expect(isCompanionPath('/api/companion/day')).toBe(true);
    expect(COMPANION_HOME).toBe('/companion');
  });

  it('decide: an onboarding session is sent home from a page and gets 403 from an API; an owner is allowed; refresh keeps the claims', async () => {
    const onboarding = await signSession(SECRET, { uid: 'user-1', role: 'onboarding' }, NOW);
    const owner = await signSession(SECRET, { uid: 'user-2', role: 'owner' }, NOW);
    for (const p of OWNER_ONLY_PAGES) expect(await decide({ pathname: p, cookie: onboarding, env: PROD, nowSeconds: NOW + 1 }), p).toMatchObject({ action: 'redirect_companion', role: 'onboarding' });
    for (const p of OWNER_ONLY_APIS) expect(await decide({ pathname: p, cookie: onboarding, env: PROD, nowSeconds: NOW + 1 }), p).toMatchObject({ action: 'forbidden_json', role: 'onboarding' });
    for (const p of COMPANION_PATHS.filter((x) => x !== '/api/auth/logout')) expect(await decide({ pathname: p, cookie: onboarding, env: PROD, nowSeconds: NOW + 1 }), p).toMatchObject({ action: 'allow', reason: 'session', claims: { uid: 'user-1', role: 'onboarding' } });
    for (const p of [...OWNER_ONLY_PAGES, ...OWNER_ONLY_APIS, ...COMPANION_PATHS.filter((x) => x !== '/api/auth/logout')]) expect(await decide({ pathname: p, cookie: owner, env: PROD, nowSeconds: NOW + 1 }), p).toMatchObject({ action: 'allow', claims: { uid: 'user-2', role: 'owner' } });
    expect(await decide({ pathname: '/companion', cookie: onboarding, env: PROD, nowSeconds: NOW + 2 * SLIDE_AFTER_SECONDS })).toMatchObject({ action: 'allow', refresh: true, claims: { uid: 'user-1', role: 'onboarding' } });
    // No cookie → the usual login redirect / 401, not a role decision.
    expect(await decide({ pathname: '/companion', cookie: null, env: PROD, nowSeconds: NOW })).toMatchObject({ action: 'redirect_login' });
  });
});

// ---- the interceptor, the login route and the data layer, with real env + PGlite ----------------------------
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
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0].split('=')[1];

beforeAll(async () => {
  await runMigrations();
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

describe('proxy with roles', () => {
  it('onboarding: pages outside the Companion → 307 /companion; APIs → 403 JSON; the Companion passes; an old cookie is re-issued with the same role', async () => {
    const onboarding = await signSession(SECRET, { uid: 'user-1', role: 'onboarding' });
    const page = await proxy(req('/scorecard?range=last_week', { cookie: onboarding }));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('https://fitflow.example/companion');
    const api = await proxy(req('/api/scorecard', { cookie: onboarding }));
    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: 'Forbidden', detail: 'This login can only use the Companion.' });
    expect((await proxy(req('/companion/settings', { cookie: onboarding }))).status).toBe(200);
    expect((await proxy(req('/api/companion/day?date=2026-10-16', { cookie: onboarding }))).status).toBe(200);

    const old = await signSession(SECRET, { uid: 'user-1', role: 'onboarding' }, Math.floor(Date.now() / 1000) - 2 * SLIDE_AFTER_SECONDS);
    const refreshed = await proxy(req('/companion', { cookie: old }));
    expect(refreshed.status).toBe(200);
    const reissued = cookieOf(refreshed);
    expect(await verifySession(reissued, SECRET)).toMatchObject({ ok: true, claims: { uid: 'user-1', role: 'onboarding' } });
  });

  it('owner (db user or team password) passes everywhere', async () => {
    for (const cookie of [await signSession(SECRET, { uid: 'user-2', role: 'owner' }), await signSession(SECRET, ENV_OWNER)]) {
      for (const p of ['/scorecard', '/api/scorecard', '/setup', '/api/users', '/companion', '/api/companion/day']) {
        const res = await proxy(req(p, { cookie }));
        expect(res.status, p).toBe(200);
        expect(res.headers.get('location'), p).toBeNull();
      }
    }
  });
});

describe('users data layer', () => {
  it('creates, lists (no hashes), validates, refuses a duplicate email, updates, resets a password, changes own password, saves preferences', async () => {
    const u = await createUser({ name: 'Miranda Murphey', email: 'Miranda@Example.com', role: 'onboarding', password: 'first password', ghlUserId: 'gUYW4bOBKjgrgFCBAW6W' });
    expect(u).toMatchObject({ name: 'Miranda Murphey', email: 'miranda@example.com', role: 'onboarding', ghlUserId: 'gUYW4bOBKjgrgFCBAW6W', active: true, lastLoginAt: null });
    expect(JSON.stringify(await listAppUsers())).not.toContain('scrypt$');
    await expect(createUser({ name: 'Dup', email: 'MIRANDA@example.com', role: 'owner', password: 'another password' })).rejects.toMatchObject({ status: 409 });
    await expect(createUser({ name: 'X', email: 'not-an-email', role: 'owner', password: 'another password' })).rejects.toBeInstanceOf(UserInputError);
    await expect(createUser({ name: 'X', email: 'x@example.com', role: 'admin', password: 'another password' })).rejects.toThrow(/Role must be/);
    await expect(createUser({ name: 'X', email: 'x@example.com', role: 'owner', password: 'short' })).rejects.toThrow(/at least 10/);
    await expect(createUser({ name: 'X', email: 'x@example.com', role: 'owner', password: 'long enough', ghlUserId: 'bad id!' })).rejects.toThrow(/GHL user id/);

    const disabled = await updateUser(u.id, { active: false });
    expect(disabled.active).toBe(false);
    await expect(updateUser(u.id, { active: 'no' })).rejects.toThrow(/true or false/);
    await updateUser(u.id, { active: true, password: 'second password' });
    expect(verifyPassword('second password', (await getAppUser(u.id))!.passwordHash)).toBe(true);
    await expect(changeOwnPassword(u.id, 'wrong one', 'third password')).rejects.toThrow('Current password is wrong.');
    await changeOwnPassword(u.id, 'second password', 'third password');
    expect(verifyPassword('third password', (await getAppUser(u.id))!.passwordHash)).toBe(true);
    expect(await savePreferences(u.id, { calendarIds: ['a'], autoAdvance: false })).toEqual({ calendarIds: ['a'], autoAdvance: false });
    expect(await savePreferences(u.id, { timezone: 'America/Edmonton' })).toEqual({ calendarIds: ['a'], autoAdvance: false, timezone: 'America/Edmonton' });
    await expect(updateUser('nope', { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('login route', () => {
  it('db user → v2 cookie with the role + home /companion + last_login_at; disabled → 401; wrong password → 401 (same text as an unknown email); team password → env owner', async () => {
    const jake = await createUser({ name: 'Jake', email: 'jake@example.com', role: 'owner', password: 'jake password' });
    const miranda = await createUser({ name: 'Miranda', email: 'miranda2@example.com', role: 'onboarding', password: 'miranda password' });

    const m = await loginPost(req('/api/auth/login', { method: 'POST', body: { email: 'Miranda2@example.com', password: 'miranda password' } }));
    expect(m.status).toBe(200);
    expect(await m.json()).toEqual({ ok: true, role: 'onboarding', home: '/companion' });
    expect(await verifySession(cookieOf(m), SECRET)).toMatchObject({ ok: true, claims: { uid: miranda.id, role: 'onboarding' } });
    expect((await getAppUser(miranda.id))!.lastLoginAt).toBeInstanceOf(Date);

    const j = await loginPost(req('/api/auth/login', { method: 'POST', body: { email: 'jake@example.com', password: 'jake password' } }));
    expect(await j.json()).toEqual({ ok: true, role: 'owner', home: '/' });
    expect(await verifySession(cookieOf(j), SECRET)).toMatchObject({ ok: true, claims: { uid: jake.id, role: 'owner' } });

    const wrong = await loginPost(req('/api/auth/login', { method: 'POST', body: { email: 'miranda2@example.com', password: 'nope nope nope' } }));
    expect(wrong.status).toBe(401);
    const unknown = await loginPost(req('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'nope nope nope' } }));
    const wrongBody = await wrong.json();
    expect(wrongBody).toEqual(await unknown.json());
    expect(JSON.stringify(wrongBody)).not.toContain('nope nope');

    await updateUser(miranda.id, { active: false });
    const off = await loginPost(req('/api/auth/login', { method: 'POST', body: { email: 'miranda2@example.com', password: 'miranda password' } }));
    expect(off.status).toBe(401);
    expect(await off.json()).toMatchObject({ error: 'This account is disabled' });

    // The team password still signs an owner in — with or without an email that matches nobody.
    resetLoginRateLimit(); // the attempts above used this IP's 5/min
    const env = await loginPost(req('/api/auth/login', { method: 'POST', body: { password: PROD.APP_PASSWORD } }));
    expect(await env.json()).toEqual({ ok: true, role: 'owner', home: '/' });
    expect(await verifySession(cookieOf(env), SECRET)).toMatchObject({ ok: true, claims: { uid: 'env-owner', role: 'owner' } });
    const envWithEmail = await loginPost(req('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: PROD.APP_PASSWORD } }));
    expect(envWithEmail.status).toBe(200);
    // A disabled user's email is refused as disabled even with the team password (owners sign in without an email).
    const disabledWithTeam = await loginPost(req('/api/auth/login', { method: 'POST', body: { email: 'miranda2@example.com', password: PROD.APP_PASSWORD } }));
    expect(disabledWithTeam.status).toBe(401);
    expect(await disabledWithTeam.json()).toMatchObject({ error: 'This account is disabled' });
  });
});

describe('currentUser re-checks active', () => {
  it('a valid token for a disabled or deleted user resolves to 401; env owner and dev resolve without a row', async () => {
    const u = await createUser({ name: 'Temp', email: 'temp@example.com', role: 'onboarding', password: 'temp password' });
    const env = { APP_PASSWORD: PROD.APP_PASSWORD, AUTH_SECRET: SECRET, VERCEL_ENV: 'production' };
    const cookie = await signSession(SECRET, { uid: u.id, role: 'onboarding' });
    expect(await resolveUser(cookie, env)).toMatchObject({ ok: true, user: { uid: u.id, role: 'onboarding', name: 'Temp', source: 'db' } });
    await updateUser(u.id, { active: false });
    expect(await resolveUser(cookie, env)).toMatchObject({ ok: false, status: 401, error: 'Account disabled or removed' });
    expect(await resolveUser(await signSession(SECRET, { uid: 'gone', role: 'owner' }), env)).toMatchObject({ ok: false, status: 401 });
    expect(await resolveUser(await signSession(SECRET, ENV_OWNER), env)).toMatchObject({ ok: true, user: { uid: 'env-owner', role: 'owner', source: 'env' } });
    expect(await resolveUser(null, env)).toMatchObject({ ok: false, status: 401, error: 'Unauthorized' });
    expect(await resolveUser(null, { NODE_ENV: 'development' })).toMatchObject({ ok: true, user: { role: 'owner', source: 'dev' } });
    expect(await resolveUser(cookie, { NODE_ENV: 'production' })).toMatchObject({ ok: false, status: 503 });
  });
});
