/**
 * Digest pipeline on in-memory PGlite: build → run → archive semantics.
 * No network: RESEND_API_KEY is unset, so nothing can be sent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, emailDigests } from '@/db';
import { buildDailyTodo } from '@/lib/email/digests';
import { runDigest, resolveRecipients } from '@/lib/email/send';
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
    // Noon ET yesterday — unambiguous local date.
    ghlCreatedAt: new Date(`${YESTERDAY}T16:00:00Z`),
    ...prov,
  });
});

describe('buildDailyTodo', () => {
  it('lists an applicant with no consult under Day-1, plainly', async () => {
    const d = await buildDailyTodo(TODAY);
    expect(d.empty).toBe(false);
    expect(d.periodStart).toBe(TODAY);
    expect(d.html).toContain('Jane Doe');
    expect(d.html).toContain('jane@example.com');
    expect(d.text).toContain('DAY-1 FOLLOW-UPS');
    expect(d.text).toMatch(/Applied, no consult booked \(1\)\n\s+- Jane Doe — jane@example.com — Facebook — 2026-08-25/);
    expect(d.subject).toContain('(1 to call)');
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
    // Simulate a prior successful send for the same period.
    await db.insert(emailDigests).values({
      kind: 'daily_todo',
      periodStart: TODAY,
      periodEnd: TODAY,
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
});
