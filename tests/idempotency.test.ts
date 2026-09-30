/**
 * F5 (2026-09-30): idempotency enforced by the database. Duplicate transitions (3,051 in production) are removed
 * by migration 0012 and made impossible by a unique index; a digest can be recorded 'sent' once per period;
 * the sync lease is atomic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, stageTransitions, emailDigests, syncLocks } from '@/db';
import { acquireLock, releaseLock } from '@/lib/syncLock';

const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
let contactId: string;
const move = (observedAt: Date) => ({ contactId, ghlOpportunityId: 'opp-1', pipelineId: 'p1', fromStageId: 's1', toStageId: 's2', fromRole: 'applied' as const, toRole: 'consult_booked' as const, observedAt, kind: 'backfill', ...prov });

beforeAll(async () => {
  await runMigrations();
  await db.insert(pipelines).values({ id: 'p1', name: 'P', ...prov });
  await db.insert(stages).values([
    { id: 's1', pipelineId: 'p1', name: 'Applied', position: 0, ...prov },
    { id: 's2', pipelineId: 'p1', name: 'Consult', position: 1, ...prov },
  ]);
  const [c] = await db.insert(contacts).values({ ghlContactId: 'c1', ...prov }).returning({ id: contacts.id });
  contactId = c.id;
});

describe('stage_transitions natural key', () => {
  it('the same move observed twice is one row (ON CONFLICT DO NOTHING); a plain duplicate insert is rejected', async () => {
    const at = new Date('2026-09-01T12:00:00Z');
    await db.insert(stageTransitions).values(move(at)).onConflictDoNothing();
    await db.insert(stageTransitions).values(move(at)).onConflictDoNothing();
    expect(await db.select().from(stageTransitions)).toHaveLength(1);
    await expect(db.insert(stageTransitions).values(move(at))).rejects.toThrow();
    // A genuinely new observation (another time) is a new row.
    await db.insert(stageTransitions).values(move(new Date('2026-09-02T12:00:00Z'))).onConflictDoNothing();
    expect(await db.select().from(stageTransitions)).toHaveLength(2);
  });

  it("migration 0012's dedupe keeps the earliest of each duplicate group, then the index can be created", async () => {
    await db.execute(sql`DROP INDEX "transitions_natural_uidx"`);
    await db.delete(stageTransitions);
    const at = new Date('2026-09-01T12:00:00Z');
    // The production shape: every backfill row doubled (and one tripled).
    await db.insert(stageTransitions).values([move(at), move(at), move(at), move(new Date('2026-09-02T12:00:00Z')), move(new Date('2026-09-02T12:00:00Z'))]);
    const first = (await db.select().from(stageTransitions).orderBy(stageTransitions.createdAt, stageTransitions.id))[0];
    const file = readFileSync(join(process.cwd(), 'migrations/0012_f5_idempotency_keys.sql'), 'utf8');
    const statements = file.split('--> statement-breakpoint').map((x) => x.trim()).filter((x) => /DELETE FROM "stage_transitions"|CREATE UNIQUE INDEX "transitions_natural_uidx"/.test(x));
    for (const st of statements) await db.execute(sql.raw(st));
    const left = await db.select().from(stageTransitions);
    expect(left).toHaveLength(2);
    expect(left.map((r) => r.id)).toContain(first.id);
    await expect(db.insert(stageTransitions).values(move(at))).rejects.toThrow();
  });
});

describe('email digest sent once per period', () => {
  const d = (status: string) => ({ kind: 'weekly', periodStart: '2026-09-20', periodEnd: '2026-09-26', subject: 's', html: '<p/>', status });
  it('a second SENT row for the same period is rejected; stored / failed rows are not limited', async () => {
    await db.insert(emailDigests).values([d('stored'), d('failed'), d('failed'), d('sent')]);
    await expect(db.insert(emailDigests).values(d('sent'))).rejects.toThrow();
    expect((await db.select().from(emailDigests).where(eq(emailDigests.status, 'sent'))).length).toBe(1);
  });
});

describe('sync lease', () => {
  it('two simultaneous acquires: exactly one holder; release frees it; an expired lease is taken over', async () => {
    const [a, b] = await Promise.all([acquireLock('t', 'A', 60_000), acquireLock('t', 'B', 60_000)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser.heldBy).toBe(a.ok ? 'A' : 'B');
    await releaseLock('t', a.ok ? 'A' : 'B');
    expect((await acquireLock('t', 'C', 1_000, new Date(Date.now() - 10_000))).ok).toBe(true); // expired immediately
    expect((await acquireLock('t', 'D', 60_000)).ok).toBe(true); // takes over the expired lease
    await releaseLock('t', 'C'); // not C's any more — D keeps it
    expect(await db.select().from(syncLocks).where(eq(syncLocks.name, 't'))).toMatchObject([{ holder: 'D' }]);
  });
});
