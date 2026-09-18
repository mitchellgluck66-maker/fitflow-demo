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
import { sweepIncidentNoise } from '@/lib/incidents/noise';
import { pipelines } from '@/db';

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

  it('resolves a whole group at once via PATCH {ids} ("Resolve all")', async () => {
    const rows = await db
      .insert(syncIncidents)
      .values([
        { kind: 'error', severity: 'critical', message: 'Meta 500 unknown error' },
        { kind: 'error', severity: 'critical', message: 'Meta 500 unknown error' },
        { kind: 'error', severity: 'critical', message: 'Meta 500 unknown error' },
      ])
      .returning({ id: syncIncidents.id });

    const res = await incidentsPatch(patch('/api/incidents', { ids: rows.map((r) => r.id) }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(3);
    const open = await (await incidentsGet(new NextRequest('http://localhost/api/incidents'))).json();
    for (const r of rows) expect(open.incidents.some((i: { id: string }) => i.id === r.id)).toBe(false);

    const empty = await incidentsPatch(patch('/api/incidents', { ids: [] }));
    expect(empty.status).toBe(400);
  });
});

describe('incident grouping (Setup log)', () => {
  const row = (id: string, message: string, createdAt: string, kind = 'error', resolvedAt: string | null = null) => ({
    id,
    kind,
    severity: 'critical',
    message,
    createdAt,
    resolvedAt,
  });

  it('collapses consecutive identical errors with ×N and first/last timestamps', async () => {
    const { groupIncidents } = await import('@/components/setup/incidentGrouping');
    const groups = groupIncidents([
      row('e', 'Meta 500', '2026-09-01T12:04:00Z'),
      row('d', 'Meta 500', '2026-09-01T12:03:00Z'),
      row('c', 'zero leads', '2026-09-01T12:02:00Z', 'silence'),
      row('b', 'Meta 500', '2026-09-01T12:01:00Z'),
      row('a', 'Meta 500', '2026-09-01T12:00:00Z'),
    ]);
    // The interrupting 'zero leads' splits Meta 500 into two episodes.
    expect(groups.map((g) => [g.message, g.count])).toEqual([
      ['Meta 500', 2],
      ['zero leads', 1],
      ['Meta 500', 2],
    ]);
    expect(groups[0].firstAt).toBe('2026-09-01T12:03:00Z');
    expect(groups[0].lastAt).toBe('2026-09-01T12:04:00Z');
    expect(groups[0].ids).toEqual(['e', 'd']);
  });

  it('never merges an open incident with a resolved twin, and sorts newest-first itself', async () => {
    const { groupIncidents } = await import('@/components/setup/incidentGrouping');
    const groups = groupIncidents([
      row('a', 'Meta 500', '2026-09-01T12:00:00Z'),
      row('b', 'Meta 500', '2026-09-01T12:01:00Z', 'error', '2026-09-01T13:00:00Z'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].id).toBe('b'); // newest first even though input was oldest-first
    expect(groups[0].resolved).toBe(true);
    expect(groups[1].resolved).toBe(false);
  });
});

describe('incident hygiene (auto-resolve + noise sweep)', () => {
  beforeAll(async () => {
    // The lifecycle suite mapped the mystery stage; unmap it and let a sync raise a fresh incident.
    await db.update(stages).set({ semanticRole: null, roleSource: 'unmapped' }).where(eq(stages.id, 'st-weird'));
    await pipelinesPatch(patch('/api/ghl/pipelines', { pipelineId: 'pipe-1', isTracked: true }));
    await runGhlSync({ mode: 'delta', trigger: 'cron' });
  });

  it('unfollowing a pipeline auto-resolves its unmapped-stage incidents; refollowing re-raises exactly one', async () => {
    const openBefore = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'unmapped_stage'));
    expect(openBefore.some((i) => i.resolvedAt === null)).toBe(true);
    await pipelinesPatch(patch('/api/ghl/pipelines', { pipelineId: 'pipe-1', isTracked: false }));
    const afterUnfollow = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'unmapped_stage'));
    expect(afterUnfollow.every((i) => i.resolvedAt !== null)).toBe(true);
    // A sync while unfollowed raises nothing.
    await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect((await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'unmapped_stage'))).every((i) => i.resolvedAt !== null)).toBe(true);
    // Follow again → one fresh incident.
    await pipelinesPatch(patch('/api/ghl/pipelines', { pipelineId: 'pipe-1', isTracked: true }));
    await runGhlSync({ mode: 'delta', trigger: 'cron' });
    const open = (await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'unmapped_stage'))).filter((i) => i.resolvedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].details?.stageId).toBe('st-weird');
  });

  it('mapping the stage (even directly in the DB) resolves the incident on the next sweep', async () => {
    await db.update(stages).set({ semanticRole: 'other', roleSource: 'manual' }).where(eq(stages.id, 'st-weird'));
    const r = await sweepIncidentNoise();
    expect(r.unmappedResolved).toBe(1);
    expect((await db.select().from(syncIncidents).where(eq(syncIncidents.kind, 'unmapped_stage'))).every((i) => i.resolvedAt !== null)).toBe(true);
    await db.update(stages).set({ semanticRole: null, roleSource: 'unmapped' }).where(eq(stages.id, 'st-weird'));
  });

  it('the sweep retires stale silence notices and duplicate errors but keeps the newest error and anything real', async () => {
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
    await db.insert(syncIncidents).values([
      { kind: 'silence', severity: 'info', message: 'Sync window contained zero calendar events.', createdAt: old },
      { kind: 'silence', severity: 'info', message: 'Sync window contained zero calendar events.' }, // fresh — stays
      { kind: 'error', severity: 'critical', message: 'Meta sync failed: 500', createdAt: old },
      { kind: 'error', severity: 'critical', message: 'Meta sync failed: 500', createdAt: new Date(old.getTime() + 1000) },
      { kind: 'error', severity: 'critical', message: 'Meta sync failed: 500' }, // newest — stays
      { kind: 'error', severity: 'critical', message: 'Stripe sync failed: 401' }, // different — stays
      { kind: 'unmapped_stage', severity: 'warning', message: 'orphan', details: { stageId: 'st-gone' } }, // stage no longer exists — noise
    ]);
    const r = await sweepIncidentNoise();
    expect(r).toMatchObject({ silenceResolved: 1, duplicateErrorsResolved: 2, unmappedResolved: 1 });
    const open = await db.select().from(syncIncidents).where(isNull(syncIncidents.resolvedAt));
    const messages = open.map((i) => i.message).sort();
    expect(messages.filter((m) => m === 'Meta sync failed: 500')).toHaveLength(1);
    expect(messages).toContain('Stripe sync failed: 401');
    expect(messages.filter((m) => m === 'Sync window contained zero calendar events.')).toHaveLength(1);
    expect(r.openAfter).toBe(open.length);
    // Idempotent.
    expect((await sweepIncidentNoise()).total).toBe(0);
  });

  it('PATCH {noise:true} is the bulk action', async () => {
    await db.insert(syncIncidents).values({ kind: 'unmapped_stage', severity: 'warning', message: 'orphan 2', details: { stageId: 'st-gone-2' } });
    const res = await incidentsPatch(patch('/api/incidents', { noise: true }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, unmappedResolved: 1 });
    expect(typeof body.openAfter).toBe('number');
    expect((await db.select().from(pipelines)).length).toBeGreaterThan(0);
  });
});
