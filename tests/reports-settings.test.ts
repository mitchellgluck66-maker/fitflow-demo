/**
 * Companion stage 3, item 3 — the /reports cards: next send (pure), the card state's reasons, the validated save,
 * "Send test to me" without an email (the team password) → 409.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Route handlers read cookies from the request scope; none here (auth off → the dev owner, no email).
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
import { runMigrations } from '@/db/migrate';
import { setSetting, SETTING_KEYS } from '@/lib/settings';
import { nextSend, firstRunOfDay } from '@/lib/email/schedule';
import { reportsSettingsState, saveReportSettings } from '@/lib/reports/settings';
import { POST as testPost } from '@/app/api/reports/test/route';

const TZ = 'America/Edmonton';
const off = { includeWeekends: false };

beforeAll(async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  await runMigrations();
});

describe('nextSend (pure)', () => {
  it('daily: tomorrow after midnight, skipping the reports for Saturday and Sunday unless weekends are on', () => {
    const fri = new Date('2026-10-23T18:00:00Z'); // Fri Oct 23, noon MDT
    expect(nextSend('daily', fri, TZ, off)).toMatchObject({ date: '2026-10-24', period: { start: '2026-10-23' } }); // Sat 00:37 reports Friday
    const sat = new Date('2026-10-24T18:00:00Z');
    expect(nextSend('daily', sat, TZ, off)).toMatchObject({ date: '2026-10-27', period: { start: '2026-10-26' } }); // Sun + Mon runs skipped → Tue reports Monday
    expect(nextSend('daily', sat, TZ, { includeWeekends: true })).toMatchObject({ date: '2026-10-25', period: { start: '2026-10-24' } });
    expect(firstRunOfDay('2026-10-24', TZ).toISOString()).toBe('2026-10-24T06:37:00.000Z');
  });
  it('weekly: the coming Sunday; monthly: the coming 1st (across the DST change)', () => {
    const wed = new Date('2026-10-21T18:00:00Z');
    expect(nextSend('weekly', wed, TZ, off)).toMatchObject({ date: '2026-10-25', period: { start: '2026-10-18', end: '2026-10-24' } });
    expect(nextSend('monthly', wed, TZ, off)).toMatchObject({ date: '2026-11-01', period: { start: '2026-10-01', end: '2026-10-31' } });
    expect(nextSend('monthly', wed, TZ, off)!.at.toISOString()).toBe('2026-11-01T06:37:00.000Z'); // 00:37 MDT (the clocks change at 2 am)
    const sunNoon = new Date('2026-10-25T18:00:00Z');
    expect(nextSend('weekly', sunNoon, TZ, off)).toMatchObject({ date: '2026-11-01' });
  });
});

describe('the cards', () => {
  it('default: every report OFF, no recipients, no reason while off; the schedule text and the next send', async () => {
    const s = await reportsSettingsState(new Date('2026-10-21T18:00:00Z'));
    expect(s.email.configured).toBe(false);
    expect(s.sendsAt).toBe('Sends ~12:40 am');
    expect(s.reports.map((r) => [r.kind, r.enabled, r.reason, r.lastSent, r.lastError])).toEqual([
      ['daily', false, null, null, null],
      ['weekly', false, null, null, null],
      ['monthly', false, null, null, null],
    ]);
    expect(s.reports[0].includeWeekends).toBe(false);
    expect(s.reports[1].includeWeekends).toBeNull();
    expect(s.reports[0].nextSend?.label).toBe('Thu, Oct 22, 2026 ~12:40 am');
    expect(s.reports[1].nextSend?.label).toBe('Sun, Oct 25, 2026 ~12:40 am');
    expect(s.reports[0].schedule).toBe('Sends ~12:40 am · covers yesterday · weekends off');
  });

  it('on with no recipients / no Resend key → the reason on the card; a valid save clears it; an invalid address refuses the save by name', async () => {
    expect(await saveReportSettings('weekly', { enabled: true })).toEqual({ ok: true });
    let s = await reportsSettingsState(new Date('2026-10-21T18:00:00Z'));
    expect(s.reports[1].reason).toBe('On, but nothing will send: RESEND_API_KEY / RESEND_FROM_EMAIL are not set — the report is rendered and archived only');
    process.env.RESEND_API_KEY = 're_x';
    process.env.RESEND_FROM_EMAIL = 'reports@fitflow.test';
    try {
      s = await reportsSettingsState(new Date('2026-10-21T18:00:00Z'));
      expect(s.reports[1].reason).toBe('On, but nothing will send: no recipients');
      expect(await saveReportSettings('weekly', { recipients: 'jake@example.com, jake@' })).toEqual({ ok: false, status: 400, error: 'Invalid recipient: jake@' });
      s = await reportsSettingsState(new Date('2026-10-21T18:00:00Z'));
      expect(s.reports[1].recipients).toBe(''); // nothing saved
      expect(await saveReportSettings('weekly', { recipients: ' Jake@Example.com; miranda@example.com ' })).toEqual({ ok: true });
      s = await reportsSettingsState(new Date('2026-10-21T18:00:00Z'));
      expect(s.reports[1]).toMatchObject({ recipients: 'jake@example.com, miranda@example.com', recipientsValid: ['jake@example.com', 'miranda@example.com'], reason: null });
    } finally {
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_EMAIL;
    }
    expect(await saveReportSettings('weekly', { includeWeekends: true })).toMatchObject({ ok: false, status: 400 });
    expect(await saveReportSettings('daily', { includeWeekends: true })).toEqual({ ok: true });
    expect((await reportsSettingsState()).reports[0].schedule).toBe('Sends ~12:40 am · covers yesterday · every day');
    await setSetting(SETTING_KEYS.digestIncludeWeekends, 'false');
  });

  it('"Send test to me" needs a personal login with an email: the dev / team-password owner gets 409', async () => {
    const res = await testPost(new NextRequest('http://localhost/api/reports/test', { method: 'POST', body: JSON.stringify({ kind: 'daily' }), headers: { 'Content-Type': 'application/json' } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('personal login');
    const bad = await testPost(new NextRequest('http://localhost/api/reports/test', { method: 'POST', body: JSON.stringify({ kind: 'nope' }), headers: { 'Content-Type': 'application/json' } }));
    expect(bad.status).toBe(400);
  });
});
