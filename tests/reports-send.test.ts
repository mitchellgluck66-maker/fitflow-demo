/**
 * Companion stage 3, items 2–3 — the report runner on PGlite (no network: RESEND_API_KEY unset, nothing can be
 * sent): the off switch, no recipients, no Resend key, a test send marked and ignored by the period, idempotency
 * per period, three failures → one incident resolved by the next success, migration 0023's settings copy, the
 * recipients parser. The daily report builds on an almost empty tenant (every section says what is missing).
 */
import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { runMigrations } from '@/db/migrate';
import { db, emailDigests, settings, syncIncidents, pipelines, stages, contacts } from '@/db';
import { setSetting, getSetting, SETTING_KEYS } from '@/lib/settings';
import { runReport, parseRecipients, MAX_FAILED_ATTEMPTS, REPORT_INCIDENT_KIND, incidentMessage } from '@/lib/reports/run';
import { buildReport } from '@/lib/reports/build';
import { localHour } from '@/lib/email/cron';

const NOW = new Date('2026-10-21T06:40:00Z'); // 00:40 MDT Wed Oct 21 → the daily is for Tue Oct 20

beforeAll(async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  await runMigrations();
});

describe('parseRecipients (pure)', () => {
  it('splits on commas / semicolons / spaces, lowercases, dedupes, and names the invalid ones', () => {
    expect(parseRecipients('Jake@X.com, miranda@x.com; jake@x.com bad@ nope')).toEqual({ valid: ['jake@x.com', 'miranda@x.com'], invalid: ['bad@', 'nope'] });
    expect(parseRecipients('')).toEqual({ valid: [], invalid: [] });
  });
});

describe('runReport', () => {
  it('OFF by default: nothing built, nothing stored', async () => {
    const r = await runReport('daily', { now: NOW });
    expect(r).toMatchObject({ kind: 'daily', status: 'disabled', periodStart: '2026-10-20', periodEnd: '2026-10-20' });
    expect(await db.select().from(emailDigests)).toHaveLength(0);
  });

  it('on, no Resend key → stored with the reason; the daily renders every section on an empty tenant and says what is missing', async () => {
    await setSetting(SETTING_KEYS.reportDailyEnabled, 'true');
    await setSetting(SETTING_KEYS.reportDailyRecipients, 'jake@example.com');
    const r = await runReport('daily', { now: NOW, force: true });
    expect(r.status).toBe('stored');
    expect(r.error).toBeUndefined();
    const [row] = await db.select().from(emailDigests).where(eq(emailDigests.id, r.digestId!));
    expect(row).toMatchObject({ kind: 'daily', status: 'stored', isTest: false, error: 'RESEND_API_KEY / RESEND_FROM_EMAIL not configured', recipients: ['jake@example.com'] });
    expect(row.subject).toMatch(/^Daily · Tue, Oct 20, 2026 · 0 applied, 0 consults booked, 0 enrolled$/);
    for (const s of ['Needs attention', 'Nothing needs attention.', 'awaiting Stripe', 'no spend rows for Tue, Oct 20, 2026', 'Data health:', 'Onboarding', 'No onboarding login with a GoHighLevel user', 'Open the Onboarding page']) expect(row.html).toContain(s);
    expect(row.html).not.toContain('$0 CAD'); // a missing source says so, never 0
  });

  it('a scheduled run after a forced store is already_recorded; a test send never satisfies the period and is marked', async () => {
    const again = await runReport('daily', { now: NOW });
    expect(again.status).toBe('already_recorded');
    const test = await runReport('daily', { now: NOW, test: true, to: ['me@example.com'] });
    expect(test).toMatchObject({ status: 'stored', test: true, recipients: ['me@example.com'] });
    const [row] = await db.select().from(emailDigests).where(eq(emailDigests.id, test.digestId!));
    expect(row.isTest).toBe(true);
    expect(row.subject.startsWith('[TEST] Daily ·')).toBe(true);
    expect((await runReport('daily', { now: NOW, test: true })).error).toBe('A test send needs an address');
  });

  it('weekly on with NO recipients → failed with the reason, recorded; three failures → ONE incident; a sent row resolves it', async () => {
    await setSetting(SETTING_KEYS.reportWeeklyEnabled, 'true');
    // One applicant inside the week, so the report is not empty (an empty period is skipped, not failed).
    const prov = { source: 'demo', origin: 'demo', backfilled: false } as const;
    await db.insert(pipelines).values({ id: 'p1', name: 'Application', isTracked: true, ...prov });
    await db.insert(stages).values({ id: 's-applied', pipelineId: 'p1', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov });
    await db.insert(contacts).values({ ghlContactId: 'ct-1', pipelineId: 'p1', stageId: 's-applied', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', ghlCreatedAt: new Date('2026-10-20T16:00:00Z'), opportunityCreatedAt: new Date('2026-10-20T16:00:00Z'), ...prov });
    const sunday = new Date('2026-10-25T06:40:00Z');
    // Pretend Resend is configured but failing: the transport is mocked at fetch.
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'reports@fitflow.test';
    const fetchFake = vi.fn(async () => new Response('{"message":"boom"}', { status: 500 }));
    vi.stubGlobal('fetch', fetchFake);
    try {
      const noRecipients = await runReport('weekly', { now: sunday });
      expect(noRecipients).toMatchObject({ status: 'failed', error: 'No valid recipients configured', periodStart: '2026-10-18', periodEnd: '2026-10-24' });
      await setSetting(SETTING_KEYS.reportWeeklyRecipients, 'jake@example.com');
      const second = await runReport('weekly', { now: sunday });
      expect(second).toMatchObject({ status: 'failed', error: 'Resend 500: boom' });
      expect(await db.select().from(syncIncidents).where(eq(syncIncidents.kind, REPORT_INCIDENT_KIND))).toHaveLength(0);
      const third = await runReport('weekly', { now: sunday });
      expect(third.status).toBe('failed');
      const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, REPORT_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ severity: 'warning', message: incidentMessage('weekly'), details: { kind: 'weekly', failures: MAX_FAILED_ATTEMPTS, period: { start: '2026-10-18', end: '2026-10-24' } } });
      // The 4th scheduled attempt stops; force still sends.
      expect((await runReport('weekly', { now: sunday })).status).toBe('retries_exhausted');
      fetchFake.mockImplementation(async () => new Response('{"id":"em_1"}', { status: 200 }));
      const sent = await runReport('weekly', { now: sunday, force: true });
      expect(sent).toMatchObject({ status: 'sent', resendId: 'em_1' });
      const resolved = await db.select().from(syncIncidents).where(eq(syncIncidents.id, open[0].id));
      expect(resolved[0].resolvedAt).not.toBeNull();
      expect((await runReport('weekly', { now: sunday })).status).toBe('already_sent');
      expect(fetchFake.mock.calls.length).toBe(3); // the no-recipients failure never reached the transport
    } finally {
      vi.unstubAllGlobals();
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_EMAIL;
    }
  });

  it('migration 0023 copies an explicit digest switch and recipients; an absent switch stays OFF', async () => {
    // Replay the settings part of 0023 against old-style rows (the ALTER already ran).
    await db.delete(settings).where(eq(settings.key, 'report_monthly_enabled'));
    await db.insert(settings).values([{ key: 'digest_enabled_monthly', value: 'true' }, { key: 'digest_recipients_monthly', value: 'jake@example.com, miranda@example.com' }]).onConflictDoNothing();
    const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '0023_reports.sql'), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => s.startsWith('INSERT'))) await db.execute(stmt);
    expect(await getSetting('report_monthly_enabled')).toBe('true');
    expect(await getSetting('report_monthly_recipients')).toBe('jake@example.com, miranda@example.com');
    // Daily/weekly had rows set by this file already; a tenant with no digest rows at all reads OFF (the default).
    await db.delete(settings).where(eq(settings.key, 'report_daily_enabled'));
    expect(await getSetting('report_daily_enabled')).toBe('false');
  });

  it('buildReport renders the three kinds on an empty tenant with every missing source named', async () => {
    const weekly = await buildReport('weekly', { start: '2026-10-18', end: '2026-10-24' }, { now: NOW });
    expect(weekly.model.subject).toMatch(/^Weekly · Oct 18–24 · /);
    expect(weekly.html).toContain('Week verdict');
    expect(weekly.html).toContain('Spend changes allowed / blocked');
    const monthly = await buildReport('monthly', { start: '2026-09-01', end: '2026-09-30' }, { now: NOW });
    expect(monthly.model.subject).toMatch(/^Monthly · September 2026 · /);
    expect(monthly.html).toContain('3-month avg');
    expect(monthly.html).toContain('awaiting Stripe');
  });
});

describe('cron local-hour helper', () => {
  it('reads the hour in the business timezone', () => {
    expect(localHour(new Date('2026-08-26T11:00:00Z'), 'America/New_York')).toBe(7);
  });
});
