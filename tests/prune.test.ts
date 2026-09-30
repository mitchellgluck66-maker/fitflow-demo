/**
 * sync_runs retention: rows older than 30 days go, the newest row per
 * (kind, status) always stays, and the dispatch step runs once per local day.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { db, syncRuns } from '@/db';
import { pruneSyncRuns, runNightlyPrune } from '@/lib/syncRunsPrune';

const NOW = new Date('2026-09-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

beforeAll(async () => {
  await runMigrations();
});

describe('pruneSyncRuns', () => {
  it('deletes rows older than 30 days but keeps the newest per kind + status', async () => {
    await db.insert(syncRuns).values([
      { id: 'd-new', kind: 'dispatch:sweep', status: 'succeeded', startedAt: daysAgo(1) },
      { id: 'd-old', kind: 'dispatch:sweep', status: 'succeeded', startedAt: daysAgo(40) },
      { id: 'd-older', kind: 'dispatch:sweep', status: 'failed', startedAt: daysAgo(50) }, // newest failed → kept
      { id: 'd-oldest', kind: 'dispatch:sweep', status: 'failed', startedAt: daysAgo(60) },
      { id: 'g-only', kind: 'google_spend', status: 'succeeded', startedAt: daysAgo(90) }, // idle source → kept
      { id: 'g-29', kind: 'ghl_delta', status: 'partial', startedAt: daysAgo(29) },
      { id: 'g-31', kind: 'ghl_delta', status: 'partial', startedAt: daysAgo(31) },
    ]);
    expect(await pruneSyncRuns(NOW)).toBe(3);
    const left = (await db.select({ id: syncRuns.id }).from(syncRuns)).map((r) => r.id).sort();
    expect(left).toEqual(['d-new', 'd-older', 'g-29', 'g-only']);
  });

  it('the dispatch step prunes once per local day', async () => {
    await db.insert(syncRuns).values({ id: 'x-old', kind: 'dispatch:sweep', status: 'succeeded', startedAt: daysAgo(45) });
    const first = await runNightlyPrune('2026-09-29', { now: NOW });
    expect(first.removed).toBe(1);
    const again = await runNightlyPrune('2026-09-29', { now: NOW });
    expect(again).toMatchObject({ ok: true, removed: 0 });
    expect(again.skipped).toMatch(/already pruned today/);
    const nextDay = await runNightlyPrune('2026-09-30', { now: NOW });
    expect(nextDay.skipped).toMatch(/nothing older/);
  });
});
