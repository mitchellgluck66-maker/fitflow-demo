/**
 * Stale sync-run sweep: a serverless function that dies mid-run leaves its
 * sync_runs row stuck at 'running' (seen twice on the 2026-09-01 first real
 * run). Starting any new sync must mark those rows failed with
 * error='timed out (stale)', and fresh running rows must be left alone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, syncRuns } from '@/db';
import { sweepStaleRuns, isStaleRun, STALE_RUN_ERROR, STALE_RUN_MINUTES } from '@/lib/staleRuns';
import { runGhlSync } from '@/lib/ghl/ingest';

beforeAll(async () => {
  await runMigrations();
});

describe('sweepStaleRuns', () => {
  it('fails running rows older than the threshold, leaves fresh and finished ones alone', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (STALE_RUN_MINUTES + 10) * 60_000);
    const inserted = await db
      .insert(syncRuns)
      .values([
        { kind: 'ghl_delta', trigger: 'cron', status: 'running', startedAt: old },
        { kind: 'meta_backfill', trigger: 'manual', status: 'running', startedAt: old },
        { kind: 'ghl_delta', trigger: 'cron', status: 'running', startedAt: new Date(now.getTime() - 60_000) },
        { kind: 'stripe_reconcile', trigger: 'cron', status: 'succeeded', startedAt: old, finishedAt: old },
      ])
      .returning({ id: syncRuns.id });

    const swept = await sweepStaleRuns(now);
    expect(swept).toBe(2);

    const rows = await db
      .select()
      .from(syncRuns)
      .where(inArray(syncRuns.id, inserted.map((r) => r.id)));
    const byKindStart = (kind: string, started: Date) => rows.find((r) => r.kind === kind && r.startedAt.getTime() === started.getTime())!;

    for (const stale of [byKindStart('ghl_delta', old), byKindStart('meta_backfill', old)]) {
      expect(stale.status).toBe('failed');
      expect(stale.error).toBe(STALE_RUN_ERROR);
      expect(stale.finishedAt).not.toBeNull();
    }
    expect(byKindStart('ghl_delta', new Date(now.getTime() - 60_000)).status).toBe('running');
    expect(byKindStart('stripe_reconcile', old).status).toBe('succeeded');

    // Idempotent: nothing left to sweep.
    expect(await sweepStaleRuns(now)).toBe(0);
  });

  it('runs as part of starting any sync', async () => {
    const old = new Date(Date.now() - (STALE_RUN_MINUTES + 5) * 60_000);
    const [stuck] = await db
      .insert(syncRuns)
      .values({ kind: 'ghl_delta', trigger: 'cron', status: 'running', startedAt: old })
      .returning({ id: syncRuns.id });

    // No GHL credentials in this test db — the sync itself fails fast, but the
    // sweep at its start must still have cleaned the stuck row.
    await runGhlSync({ mode: 'delta', trigger: 'cli' });

    const [row] = await db.select().from(syncRuns).where(eq(syncRuns.id, stuck.id));
    expect(row.status).toBe('failed');
    expect(row.error).toBe(STALE_RUN_ERROR);
  });

  it('isStaleRun matches the sweep threshold', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    expect(isStaleRun('running', new Date('2026-09-01T11:45:00Z'), now)).toBe(true);
    expect(isStaleRun('running', new Date('2026-09-01T11:55:00Z'), now)).toBe(false);
    expect(isStaleRun('failed', new Date('2026-09-01T11:00:00Z'), now)).toBe(false);
  });
});
