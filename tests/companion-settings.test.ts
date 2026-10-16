/**
 * Companion stage 1, item 4 — settings: preference validation (pure), the settings and password routes
 * (a personal login saves; the team-password owner gets 409; a wrong current password 401; a short one 400).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { setSetting } from '@/lib/settings';
import { validatePreferences, timezoneOptions } from '@/lib/companion/preferences';
import { createUser, getAppUser } from '@/lib/auth/users';
import { verifyPassword } from '@/lib/auth/password';
import { signSession, ENV_OWNER, SESSION_COOKIE } from '@/lib/auth/session';
import { GET as settingsGet, PATCH as settingsPatch } from '@/app/api/companion/settings/route';
import { POST as passwordPost } from '@/app/api/companion/password/route';

const SECRET = 'test-secret-with-enough-entropy-0123456789';

describe('validatePreferences (pure)', () => {
  it('accepts each key, dedupes calendar ids, maps "" to null, rejects bad values and drops unknown keys', () => {
    expect(validatePreferences({ calendarIds: ['a', 'b', 'a'], timezone: 'America/Toronto', autoAdvance: false, junk: 1 })).toEqual({ ok: true, prefs: { calendarIds: ['a', 'b'], timezone: 'America/Toronto', autoAdvance: false } });
    expect(validatePreferences({ calendarIds: null, timezone: '' })).toEqual({ ok: true, prefs: { calendarIds: null, timezone: null } });
    expect(validatePreferences({})).toEqual({ ok: true, prefs: {} });
    expect(validatePreferences({ calendarIds: 'a' })).toMatchObject({ ok: false });
    expect(validatePreferences({ calendarIds: ['bad id!'] })).toMatchObject({ ok: false });
    expect(validatePreferences({ timezone: 'Mars/Olympus' })).toMatchObject({ ok: false, error: '"Mars/Olympus" is not a valid IANA timezone.' });
    expect(validatePreferences({ autoAdvance: 'yes' })).toMatchObject({ ok: false });
    expect(validatePreferences(null)).toMatchObject({ ok: false });
    expect(timezoneOptions('America/Edmonton')[0]).toBe('America/Edmonton');
    expect(timezoneOptions('America/Edmonton').filter((z) => z === 'America/Edmonton')).toHaveLength(1);
  });
});

// The routes read the cookie through next/headers; mock it per request.
let cookieValue: string | undefined;
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && cookieValue ? { value: cookieValue } : undefined) }) }));
vi.mock('@/lib/ghl/client', async (orig) => ({ ...(await orig<typeof import('@/lib/ghl/client')>()), listCalendars: async () => ({ ok: false, status: 0, data: null, request: { method: 'GET', endpoint: '/calendars/', family: 'calendars' }, error: 'No GoHighLevel credentials configured.' }) }));

const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const req = (path: string, init: { method?: string; body?: unknown } = {}) => new NextRequest(`https://fitflow.example${path}`, { method: init.method ?? 'GET', headers: init.body ? { 'content-type': 'application/json' } : {}, body: init.body ? JSON.stringify(init.body) : undefined });

describe('settings + password routes', () => {
  let mirandaId = '';
  beforeAll(async () => {
    await runMigrations();
    await setSetting('timezone', 'America/Edmonton');
    setEnv({ APP_PASSWORD: 'team password here', AUTH_SECRET: SECRET, VERCEL_ENV: 'production' });
    mirandaId = (await createUser({ name: 'Miranda', email: 'miranda@example.com', role: 'onboarding', password: 'miranda password', ghlUserId: 'gUYW4bOBKjgrgFCBAW6W' })).id;
  });
  afterEach(() => {
    cookieValue = undefined;
  });

  it('a personal login reads defaults and saves preferences; GET reports the calendar source and the reason', async () => {
    cookieValue = await signSession(SECRET, { uid: mirandaId, role: 'onboarding' });
    const g = await settingsGet();
    expect(g.status).toBe(200);
    const body = await g.json();
    expect(body).toMatchObject({ hasRow: true, preferences: { calendarIds: null, timezone: null, autoAdvance: true }, businessTimezone: 'America/Edmonton', calendarsSource: 'none', calendarsError: 'No GoHighLevel credentials configured.' });
    expect(body.timezones[0]).toBe('America/Edmonton');
    const p = await settingsPatch(req('/api/companion/settings', { method: 'PATCH', body: { calendarIds: ['PVm8i0dUEugSsW6EwnoS'], autoAdvance: false } }));
    expect(await p.json()).toEqual({ ok: true, preferences: { calendarIds: ['PVm8i0dUEugSsW6EwnoS'], timezone: null, autoAdvance: false } });
    const bad = await settingsPatch(req('/api/companion/settings', { method: 'PATCH', body: { timezone: 'Nowhere/Land' } }));
    expect(bad.status).toBe(400);
    expect((await getAppUser(mirandaId))!.preferences).toEqual({ calendarIds: ['PVm8i0dUEugSsW6EwnoS'], autoAdvance: false });
  });

  it('the team-password owner cannot save preferences or change a password here (409)', async () => {
    cookieValue = await signSession(SECRET, ENV_OWNER);
    expect((await (await settingsGet()).json()).hasRow).toBe(false);
    expect((await settingsPatch(req('/api/companion/settings', { method: 'PATCH', body: { autoAdvance: false } }))).status).toBe(409);
    expect((await passwordPost(req('/api/companion/password', { method: 'POST', body: { current: 'x', next: 'y' } }))).status).toBe(409);
  });

  it('change password: wrong current → 401; short → 400; right → the new one verifies; no cookie → 401', async () => {
    cookieValue = await signSession(SECRET, { uid: mirandaId, role: 'onboarding' });
    const wrong = await passwordPost(req('/api/companion/password', { method: 'POST', body: { current: 'nope nope nope', next: 'a brand new password' } }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Current password is wrong.' });
    const short = await passwordPost(req('/api/companion/password', { method: 'POST', body: { current: 'miranda password', next: 'short' } }));
    expect(short.status).toBe(400);
    const ok = await passwordPost(req('/api/companion/password', { method: 'POST', body: { current: 'miranda password', next: 'a brand new password' } }));
    expect(ok.status).toBe(200);
    expect(verifyPassword('a brand new password', (await getAppUser(mirandaId))!.passwordHash)).toBe(true);
    cookieValue = undefined;
    expect((await settingsGet()).status).toBe(401);
  });
});
