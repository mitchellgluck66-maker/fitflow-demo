/**
 * Digest pipeline on in-memory PGlite: build → run → archive semantics.
 * No network: RESEND_API_KEY is unset, so nothing can be sent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, emailDigests } from '@/db';
import { buildDailyTodo } from '@/lib/email/digests';
import { runDigest, resolveRecipients, MAX_FAILED_ATTEMPTS } from '@/lib/email/send';
import { localHour } from '@/lib/email/cron';

const TODAY = '2026-08-26';
const YESTERDAY = '2026-08-25';

beforeAll(async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  await runMigrations();
  const prov = { source: 'demo', origin: 'demo', backfilled: false } as const;
  // Followed: only followed pipelines drive digests (isTracked defaults false).
  await db.insert(pipelines).values({ id: 'p1', name: 'Pipeline', isTracked: true, ...prov });
  await db.insert(stages).values({ id: 's-applied', pipelineId: 'p1', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov });
  await db.insert(contacts).values({
    ghlContactId: 'ct-1',
    pipelineId: 'p1',
    stageId: 's-applied',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    attributionSource: 'Facebook',
    // Noon ET yesterday — unambiguous local date. The application is dated by the opportunity, as a real sync writes it.
    ghlCreatedAt: new Date(`${YESTERDAY}T16:00:00Z`),
    opportunityCreatedAt: new Date(`${YESTERDAY}T16:00:00Z`),
    ...prov,
  });
});

describe('buildDailyTodo', () => {
  it('lists an applicant with no consult under Day-1, plainly', async () => {
    // Sent just after midnight on TODAY: the report is FOR yesterday; Day-1 = the people whose stage entry was that day.
    const sentAt = new Date(`${TODAY}T06:40:00Z`); // 00:40 MDT
    const d = await buildDailyTodo(TODAY, sentAt);
    expect(d.empty).toBe(false);
    expect(d.periodStart).toBe(YESTERDAY);
    expect(d.periodEnd).toBe(YESTERDAY);
    expect(d.html).toContain('Jane Doe');
    expect(d.html).toContain('jane@example.com');
    expect(d.text).toContain('DAY-1 FOLLOW-UPS');
    expect(d.text).toMatch(/Applied, no consult booked \(1\)\n\s+- Jane Doe — jane@example.com — Facebook — 2026-08-25/);
    expect(d.subject).toContain('Tue, Aug 25');
    expect(d.subject).toContain('(1 to call today)');
    // Meta spend for the reported day: no rows in this fixture, and the day closed 40 min before the send → still settling.
    expect(d.text).toContain('Meta spend Tue, Aug 25, 2026: no spend rows yet · still settling');
  });

  it('drops the settling mark once the reported day is 48 h old', async () => {
    const d = await buildDailyTodo(TODAY, new Date(`2026-08-28T06:40:00Z`));
    expect(d.text).toContain('Meta spend Tue, Aug 25, 2026: no spend rows yet');
    expect(d.text).not.toContain('still settling');
  });

  it('is empty on a quiet day', async () => {
    const d = await buildDailyTodo('2026-01-10');
    expect(d.empty).toBe(true);
    expect(d.html).toContain('Nothing needs a call today.');
  });
});

describe('runDigest', () => {
  it('defaults recipients to Mitchell', async () => {
    expect(await resolveRecipients('daily_todo')).toEqual(['mitchellgluck66@gmail.com']);
  });

  it('stores (does not send) when Resend is not configured', async () => {
    const r = await runDigest('daily_todo', { today: TODAY });
    expect(r.status).toBe('stored');
    const [row] = await db.select().from(emailDigests).where(eq(emailDigests.id, r.digestId!));
    expect(row.status).toBe('stored');
    expect(row.recipients).toEqual(['mitchellgluck66@gmail.com']);
    expect(row.html).toContain('Jane Doe');
    expect(row.sentAt).toBeNull();
  });

  it('records skipped_empty for an empty period and does not send', async () => {
    const r = await runDigest('daily_todo', { today: '2026-01-10' });
    expect(r.status).toBe('skipped_empty');
    const [row] = await db.select().from(emailDigests).where(eq(emailDigests.id, r.digestId!));
    expect(row.status).toBe('skipped_empty');
  });

  it('force renders an empty period anyway (manual Send now)', async () => {
    const r = await runDigest('daily_todo', { today: '2026-01-10', force: true });
    expect(r.status).toBe('stored');
  });

  it('is idempotent per period once a digest has been sent', async () => {
    // Simulate a prior successful send for the same period (the report run on TODAY is FOR yesterday).
    await db.insert(emailDigests).values({
      kind: 'daily_todo',
      periodStart: YESTERDAY,
      periodEnd: YESTERDAY,
      recipients: ['x@example.com'],
      subject: 'prior',
      html: '<p/>',
      status: 'sent',
      sentAt: new Date(),
    });
    const before = (await db.select().from(emailDigests)).length;
    const r = await runDigest('daily_todo', { today: TODAY });
    expect(r.status).toBe('already_sent');
    expect((await db.select().from(emailDigests)).length).toBe(before);

    const forced = await runDigest('daily_todo', { today: TODAY, force: true });
    expect(forced.status).toBe('stored');
  });

  it('heartbeat-safe: a stored or empty period is decided once, not re-archived every run', async () => {
    const day = '2026-08-27';
    const first = await runDigest('daily_todo', { today: day });
    const before = (await db.select().from(emailDigests)).length;
    const again = await runDigest('daily_todo', { today: day });
    expect(again.status).toBe('already_recorded');
    expect(again.digestId).toBe(first.digestId);
    expect((await db.select().from(emailDigests)).length).toBe(before);

    // The empty day recorded earlier in this file is also final.
    expect((await runDigest('daily_todo', { today: '2026-01-10' })).status).toBe('already_recorded');
    expect((await db.select().from(emailDigests)).length).toBe(before);
  });

  it('stops retrying a period after MAX_FAILED_ATTEMPTS failures (force still sends)', async () => {
    const day = '2026-08-28';
    const reported = '2026-08-27'; // the period a run on `day` reports
    const failed = { kind: 'daily_todo', periodStart: reported, periodEnd: reported, recipients: ['x@example.com'], subject: 'f', html: '<p/>', status: 'failed', error: 'boom' };
    await db.insert(emailDigests).values(Array.from({ length: MAX_FAILED_ATTEMPTS }, () => ({ ...failed })));
    const before = (await db.select().from(emailDigests)).length;
    const r = await runDigest('daily_todo', { today: day });
    expect(r.status).toBe('retries_exhausted');
    expect((await db.select().from(emailDigests)).length).toBe(before);
    expect((await runDigest('daily_todo', { today: day, force: true })).status).toBe('stored');
  });

  it('weekly scorecard builds and archives from the same engine', async () => {
    const r = await runDigest('weekly', { force: true });
    expect(r.status).toBe('stored');
    const [row] = await db.select().from(emailDigests).where(eq(emailDigests.id, r.digestId!));
    expect(row.subject).toMatch(/weekly scorecard/);
    expect(row.html).toContain('Awaiting Stripe');
    expect(row.html).toContain('Funnel');
  });
});

describe('cron local-hour gate', () => {
  it('reads the hour in the business timezone', () => {
    expect(localHour(new Date('2026-08-26T11:00:00Z'), 'America/New_York')).toBe(7); // EDT
    expect(localHour(new Date('2026-12-16T12:00:00Z'), 'America/New_York')).toBe(7); // EST
    expect(localHour(new Date('2026-12-16T11:00:00Z'), 'America/New_York')).toBe(6);
  });

  // The 6 am send window (M1) was retired 2026-10-21: reports send after midnight — see tests/report-schedule.test.ts.
});
