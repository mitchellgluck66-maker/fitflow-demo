/**
 * "Sync now" (POST /api/sync, Ingestion v2 2026-09-30). Works: it refreshes the followed pipeline inside the
 * request and says "Followed pipeline: N opportunities refreshed at <time>". Fails: the reason, never a bare
 * "Sync complete". The weekly mirror pass is never walked from here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, ghlOpportunities } from '@/db';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { setGhlRateLimitForTests } from '@/lib/ghl/client';
import { acquireLock, releaseLock } from '@/lib/syncLock';
import { GHL_LOCK } from '@/lib/ghl/ingest';
import { POST } from '@/app/api/sync/route';
import { eq } from 'drizzle-orm';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const opps = [
  { id: 'o1', name: 'A', pipelineId: 'pf', pipelineStageId: 's1', status: 'open', contactId: 'c1', createdAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-29T10:00:00Z' },
  { id: 'o2', name: 'B', pipelineId: 'pf', pipelineStageId: 's1', status: 'open', contactId: 'c2', createdAt: '2026-09-29T11:00:00Z', updatedAt: '2026-09-29T11:00:00Z' },
  { id: 'om', name: 'M', pipelineId: 'pm', pipelineStageId: 'sm', status: 'open', contactId: 'c3', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
];
const searches: string[] = [];
let failSearch = false;
const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.pathname === '/opportunities/pipelines') return json({ pipelines: [{ id: 'pf', name: 'Applications', stages: [{ id: 's1', name: 'Applied', position: 0 }] }, { id: 'pm', name: 'Old', stages: [{ id: 'sm', name: 'Old', position: 0 }] }] });
  if (url.pathname === '/opportunities/search') {
    const pid = url.searchParams.get('pipeline_id')!;
    searches.push(pid);
    if (failSearch) return json({ message: 'Internal error' }, 500);
    const all = opps.filter((o) => o.pipelineId === pid);
    return json({ opportunities: all, meta: { total: all.length } });
  }
  if (url.pathname === '/calendars/') return json({ calendars: [] });
  if (url.pathname === '/users/') return json({ users: [] });
  const m = url.pathname.match(/^\/contacts\/([^/]+)$/);
  if (m) return json({ contact: { id: m[1], firstName: m[1], dateAdded: '2026-09-29T09:00:00Z' } });
  return json({}, 404);
});

beforeAll(async () => {
  setGhlRateLimitForTests({ minIntervalMs: 0, burstMax: 100_000 });
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  await setSetting(CREDENTIAL_KEYS.token, 'pit-test', { secret: true });
  await setSetting(CREDENTIAL_KEYS.locationId, 'loc-1');
  // First sync mirrors the pipelines; follow 'pf' as a human would.
  await POST(new NextRequest('http://localhost/api/sync', { method: 'POST', body: '{}' }));
  await db.update(pipelines).set({ isTracked: true }).where(eq(pipelines.id, 'pf'));
});
afterAll(() => {
  vi.unstubAllGlobals();
  setGhlRateLimitForTests(null);
});

const post = async (body: unknown = {}) => {
  const res = await POST(new NextRequest('http://localhost/api/sync', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe('POST /api/sync ("Sync now")', () => {
  it('works: refreshes the followed pipeline (never the mirrors) and says "Followed pipeline: N opportunities refreshed at <time>"', async () => {
    searches.length = 0;
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, refreshed: true, opportunities: 2 });
    expect(r.body.message).toMatch(/^Followed pipeline: 2 opportunities refreshed at Sep \d+, \d+:\d\d (AM|PM) M[DS]T\.$/); // Edmonton
    expect(searches).toEqual(['pf']); // the mirror pipeline 'pm' is not walked from "Sync now"
    expect(await db.select().from(ghlOpportunities).where(eq(ghlOpportunities.pipelineId, 'pf'))).toHaveLength(2);
  });

  it('fails visibly: a GHL error returns 502 with the reason', async () => {
    failSearch = true;
    const r = await post();
    failSearch = false;
    expect(r.status).toBe(502);
    expect(r.body.refreshed).toBe(false);
    expect(r.body.message).toMatch(/^Sync failed: GHL 500 GET \/opportunities\/search/);
  });

  it('while another sync holds the lease: "Not started … Try again in a minute."', async () => {
    await acquireLock(GHL_LOCK, 'cron-run', 60_000);
    const r = await post();
    await releaseLock(GHL_LOCK, 'cron-run');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ refreshed: false });
    expect(r.body.message).toMatch(/^Not started: another GHL sync holds the lock until .*\. Try again in a minute\.$/);
  });
});
