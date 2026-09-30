/**
 * Atomic single-run leases (F5, 2026-09-30). The previous "one GHL run at a time" guard read sync_runs for a
 * live 'running' row and THEN inserted its own — two starts in the same instant both passed. A lease is taken
 * with ONE statement: INSERT … ON CONFLICT (name) DO UPDATE … WHERE the current lease has expired, RETURNING.
 * Exactly one caller gets a row back. A crashed holder's lease simply expires (ttl > the function's maxDuration).
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import { db, syncLocks } from '@/db';

export interface LockResult {
  ok: boolean;
  /** When not acquired: who holds it and until when. */
  heldBy?: string;
  until?: Date;
}

export async function acquireLock(name: string, holder: string, ttlMs: number, now: Date = new Date()): Promise<LockResult> {
  const expiresAt = new Date(now.getTime() + ttlMs);
  const [row] = await db
    .insert(syncLocks)
    .values({ name, holder, acquiredAt: now, expiresAt })
    .onConflictDoUpdate({
      target: syncLocks.name,
      set: { holder, acquiredAt: now, expiresAt },
      setWhere: lt(syncLocks.expiresAt, sql`${now.toISOString()}::timestamptz`),
    })
    .returning({ holder: syncLocks.holder });
  if (row && row.holder === holder) return { ok: true };
  const [current] = await db.select().from(syncLocks).where(eq(syncLocks.name, name)).limit(1);
  return { ok: false, heldBy: current?.holder, until: current?.expiresAt };
}

/** Release only our own lease (a lease that expired and was taken over is not ours to drop). */
export async function releaseLock(name: string, holder: string): Promise<void> {
  await db.delete(syncLocks).where(and(eq(syncLocks.name, name), eq(syncLocks.holder, holder)));
}
