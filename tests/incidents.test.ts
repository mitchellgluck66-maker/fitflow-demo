/**
 * Incident lifecycle: an unmapped stage raises an incident during sync,
 * assigning a role resolves it; arbitrary incidents resolve via the API;
 * sync-health reports per-source runs and the unmapped list.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, syncIncidents, stages } from '@/db';
import { eq, isNull } from 'drizzle-orm';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { runGhlSync } from '@/lib/ghl/ingest';
import { PATCH as pipelinesPatch } from '@/app/api/ghl/pipelines/route';
import { PATCH as incidentsPatch, GET as incidentsGet } from '@/app/api/incidents/route';
import { GET as healthGet } from '@/app/api/sync-health/route';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.pathname === '/opportunities/pipelines') {
    return json({ pipelines: [{ id: 'pipe-1', name: 'App', stages: [{ id: 'st-applied', name: 'Applied', position: 0 }, { id: 'st-weird', name: 'Mystery Bucket', position: 1 }] }] });
  }
  if (url.pathname === '/opportunities/search') return json({ opportunities: [], meta: {} });
  if (url.pathname === '/calendars/') return json({ calendars: [] });
  if (url.pathname === '/users/') return json({ users: [] });
  return new Response('not found', { status: 404 });
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  await setSetting(CREDENTIAL_KEYS.token, 'pit-test', { secret: true });
  await setSetting(CREDENTIAL_KEYS.locationId, 'loc-1');
});
afterAll(() => vi.unstubAllGlobals());

const patch = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('incident lifecycle', () => {
  it('a sync raises one unmapped_stage incident for the mystery stage (and no duplicate on re-run)', async () => {
    // New pipelines arrive unfollowed — no unmapped noise until a human follows.
    const r0 = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(r0.ok).toBe(true);
    expect(r0.stats.stagesUnmapped).toBe(0);
    expect(await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'unmapped_stage'))).toHaveLength(0);

    await pipelinesPatch(patch('/api/ghl/pipelines', { pipelineId: 'pipe-1', isTracked: true }));
    const r1 = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(r1.ok).toBe(true);
    expect(r1.stats.stagesUnmapped).toBe(1);
    await runGhlSync({ mode: 'delta', trigger: 'cron' });
    const open = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'unmapped_stage'));
    expect(open.filter((i) => i.resolvedAt === null && i.details?.stageId === 'st-weird')).toHaveLength(1);
  });

  it('sync-health lists the source run and the unmapped stage', async () => {
    const data = await (await healthGet()).json();
    const ghl = data.sources.find((s: { key: string }) => s.key === 'ghl');
    expect(ghl.configured).toBe(true);
    expect(ghl.lastRun.status).toBe('succeeded');
    expect(data.unmappedStages.map((u: { id: string }) => u.id)).toEqual(['st-weird']);
    expect(data.incidents.some((i: { kind: string }) => i.kind === 'unmapped_stage')).toBe(true);
    expect(data.sources.find((s: { key: string }) => s.key === 'meta').configured).toBe(false);
  });

  it('assigning a role resolves the incident and records a manual mapping', async () => {
    const res = await pipelinesPatch(patch('/api/ghl/pipelines', { stageId: 'st-weird', semanticRole: 'other' }));
    expect((await res.json()).ok).toBe(true);
    const [stage] = await db.select().from(stages).where(eq(stages.id, 'st-weird'));
    expect(stage).toMatchObject({ semanticRole: 'other', roleSource: 'manual' });
    const stillOpen = await db.select().from(syncIncidents).where(isNull(syncIncidents.resolvedAt));
    expect(stillOpen.filter((i) => i.kind === 'unmapped_stage')).toHaveLength(0);
    const data = await (await healthGet()).json();
    expect(data.unmappedStages).toEqual([]);
  });

  it('an arbitrary incident resolves (and reopens) through /api/incidents', async () => {
    const [row] = await db.insert(syncIncidents).values({ kind: 'silence', severity: 'info', message: 'quiet' }).returning({ id: syncIncidents.id });
    const res = await incidentsPatch(patch('/api/incidents', { id: row.id }));
    expect((await res.json()).ok).toBe(true);
    let open = await (await incidentsGet(new NextRequest('http://localhost/api/incidents'))).json();
    expect(open.incidents.some((i: { id: string }) => i.id === row.id)).toBe(false);
    const resolved = await (await incidentsGet(new NextRequest('http://localhost/api/incidents?resolved=1'))).json();
    expect(resolved.incidents.some((i: { id: string }) => i.id === row.id)).toBe(true);
    await incidentsPatch(patch('/api/incidents', { id: row.id, resolved: false }));
    open = await (await incidentsGet(new NextRequest('http://localhost/api/incidents'))).json();
    expect(open.incidents.some((i: { id: string }) => i.id === row.id)).toBe(true);
    const missing = await incidentsPatch(patch('/api/incidents', { id: 'nope' }));
    expect(missing.status).toBe(404);
  });
});
