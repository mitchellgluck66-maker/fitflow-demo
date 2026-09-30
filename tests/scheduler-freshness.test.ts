/**
 * Ingestion v2 (2026-09-30): freshness from MARKERS only, 3 h on the hourly schedule, and a scheduler-silent
 * check — Vercel Pro crons are primary; a silent scheduler used to look like calm data.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, syncRuns, syncIncidents } from '@/db';
import { setSetting, SETTING_KEYS } from '@/lib/settings';
import { META_KEYS } from '@/lib/meta/config';
import { markerFreshness } from '@/lib/sync/freshness';
import { writeMarker } from '@/lib/sync/markers';
import { schedulerVia, schedulerSilence, checkSchedulerSilence, recordScheduledRun, readSchedulerLastRun } from '@/lib/sync/scheduler';
import { GET as statusGet } from '@/app/api/sync/status/route';
import { GET as syncGhlCron } from '@/app/api/cron/sync-ghl/route';

const H = 3_600_000;
const NOW = Date.parse('2026-09-30T18:00:00Z');

beforeAll(async () => {
  await runMigrations();
});

describe('markerFreshness (pure)', () => {
  it('2 h fresh · 4 h stale (3 h threshold) · no marker = never completed = stale; the detail carries the marker', () => {
    const m = (hoursAgo: number) => ({ completedAt: new Date(NOW - hoursAgo * H).toISOString(), fetched: 401, detail: '1 followed pipeline · 401 opportunities' });
    expect(markerFreshness({ label: 'opportunities', marker: m(2), now: NOW })).toMatchObject({ stale: false, fetched: 401, detail: 'opportunities: last completed 2 h ago (1 followed pipeline · 401 opportunities)' });
    expect(markerFreshness({ label: 'opportunities', marker: m(4), now: NOW }).stale).toBe(true);
    expect(markerFreshness({ label: 'opportunities', marker: null, now: NOW })).toMatchObject({ stale: true, detail: 'opportunities: never completed' });
  });
});

describe('scheduler', () => {
  const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
  it('names who called: Vercel cron, the GitHub fallback, or other', () => {
    expect(schedulerVia(headers({ 'user-agent': 'vercel-cron/1.0' }))).toBe('vercel');
    expect(schedulerVia(headers({ 'user-agent': 'curl/8.5', 'x-fitflow-trigger': 'github-heartbeat' }))).toBe('github');
    expect(schedulerVia(headers({ 'user-agent': 'curl/8.5' }))).toBe('other');
  });

  it('silent after 3 h or never (pure)', () => {
    expect(schedulerSilence(null, NOW)).toMatchObject({ silent: true, detail: 'No scheduled sync has ever run — check the Vercel cron jobs (Project → Settings → Cron Jobs).' });
    expect(schedulerSilence({ route: '/api/cron/dispatch', at: new Date(NOW - 50 * 60_000).toISOString(), via: 'vercel' }, NOW)).toMatchObject({ silent: false, detail: 'Last scheduled run 50 min ago (vercel, /api/cron/dispatch).' });
    expect(schedulerSilence({ route: '/api/cron/sync-ghl', at: new Date(NOW - 4 * H).toISOString(), via: 'github' }, NOW).detail).toBe('No scheduled sync since 2026-09-30T14:00:00.000Z (4 h, last via github) — check the Vercel cron jobs.');
  });

  it('opens ONE critical scheduler_silent incident, refreshes it, and resolves it on the next scheduled run', async () => {
    const open = () => db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'scheduler_silent'), isNull(syncIncidents.resolvedAt)));
    await checkSchedulerSilence(new Date(NOW));
    await checkSchedulerSilence(new Date(NOW + H));
    expect(await open()).toHaveLength(1);
    expect((await open())[0]).toMatchObject({ severity: 'critical' });
    await recordScheduledRun('/api/cron/dispatch', 'vercel', new Date(NOW + 2 * H));
    expect(await open()).toHaveLength(0);
    expect((await checkSchedulerSilence(new Date(NOW + 3 * H))).silent).toBe(false);
    expect((await checkSchedulerSilence(new Date(NOW + 6 * H))).silent).toBe(true); // 4 h after the last run
  });

  it('a cron call records itself (who and when)', async () => {
    const before = Date.now();
    await syncGhlCron(new NextRequest('http://localhost/api/cron/sync-ghl', { headers: { 'user-agent': 'vercel-cron/1.0' } }));
    const last = await readSchedulerLastRun();
    expect(last).toMatchObject({ route: '/api/cron/sync-ghl', via: 'vercel' });
    expect(Date.parse(last!.at)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('/api/sync/status reads markers only', () => {
  it('a SUCCEEDED run with no marker does not make a source fresh; its marker does; the scheduler verdict is included', async () => {
    await setSetting(META_KEYS.token, 'EAAG-token-for-status-test', { secret: true });
    await setSetting(META_KEYS.adAccountId, '123');
    // What the old banner trusted: a recent succeeded run row.
    await db.insert(syncRuns).values({ kind: 'meta_delta', trigger: 'cron', status: 'succeeded', startedAt: new Date(), finishedAt: new Date() });
    let body = await (await statusGet()).json();
    const meta = () => body.sources.find((s: { key: string }) => s.key === 'meta');
    expect(meta()).toMatchObject({ configured: true, stale: true, lastSuccessAt: null, detail: 'Meta Ads spend: never completed' });

    await writeMarker({ family: 'meta.spend', runId: 'r1', fetched: 42, detail: '2026-09-27 – 2026-09-30 · CAD' });
    body = await (await statusGet()).json();
    expect(meta()).toMatchObject({ stale: false, fetched: 42 });
    expect(body.staleAfterHours).toBe(3);
    expect(body.scheduler).toMatchObject({ silent: false });
    await setSetting(SETTING_KEYS.schedulerLastRun, '');
  });
});
