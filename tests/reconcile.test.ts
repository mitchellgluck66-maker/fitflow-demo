/**
 * Reconcile v2 (F7, 2026-09-30): live GHL counts per followed stage × status (+ pipeline total) vs
 * ghl_opportunities, exactly; drift → targeted re-fetch through the tracked job's path → re-probe; what still
 * differs is ONE critical incident per (stage, status); a probe with no total is a critical incident and a
 * FAILED run. The v1 blind spots: Enrolled (all "won") always probed 0, and "" in meta.nextPage skipped stages.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, syncIncidents, syncRuns, ghlOpportunities } from '@/db';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { setGhlRateLimitForTests } from '@/lib/ghl/client';
import { runReconcile, readReconcileSummary } from '@/lib/ghl/reconcile';
import { acquireLock, releaseLock } from '@/lib/syncLock';
import { GHL_LOCK } from '@/lib/ghl/ingest';
import { GhlOpportunitySearchResponseSchema } from '@/lib/ghl/schemas';

type Opp = { id: string; name: string; pipelineId: string; pipelineStageId: string; status: string; contactId: string; createdAt: string; updatedAt: string };
const opp = (id: string, stage: string, status = 'open', pipelineId = 'p-app'): Opp => ({ id, name: id, pipelineId, pipelineStageId: stage, status, contactId: `c-${id}`, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z' });

/** Live GoHighLevel. */
const live: Opp[] = [opp('o1', 'st-applied'), opp('o2', 'st-applied'), opp('o3', 'st-enrolled', 'won'), opp('o4', 'st-enrolled', 'won'), opp('x1', 'st-x', 'open', 'p-other')];
/** Extra to add to a probe's meta.total (a count GHL reports but its listing never shows). */
const phantom: Record<string, number> = {};
let noTotalFor: string | null = null;
const requests: string[] = [];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (init?.method && init.method !== 'GET') throw new Error('non-GET');
  requests.push(url.pathname + url.search);
  const q = url.searchParams;
  if (url.pathname === '/opportunities/search') {
    const rows = live.filter((o) => o.pipelineId === q.get('pipeline_id') && (!q.get('pipeline_stage_id') || o.pipelineStageId === q.get('pipeline_stage_id')) && (!q.get('status') || o.status === q.get('status')));
    const key = `${q.get('pipeline_stage_id') ?? '*'}|${q.get('status') ?? '*'}`;
    const limit = Number(q.get('limit') ?? 100);
    const page = Number(q.get('page') ?? 1);
    if (noTotalFor === key) return json({ opportunities: [], meta: { nextPage: '' } }); // the v1 shape that skipped stages
    // meta.nextPage "" on the last page — must not reject the page (F7)
    return json({ opportunities: rows.slice((page - 1) * limit, page * limit), meta: { total: rows.length + (phantom[key] ?? 0), nextPage: '' } });
  }
  const one = url.pathname.match(/^\/opportunities\/([^/]+)$/);
  if (one) {
    const o = live.find((x) => x.id === one[1]);
    return o ? json({ opportunity: o }) : json({ message: 'not found' }, 404);
  }
  if (url.pathname === '/users/') return json({ users: [] });
  const c = url.pathname.match(/^\/contacts\/([^/]+)$/);
  if (c) return json({ contact: { id: c[1], firstName: c[1], dateAdded: '2026-09-01T09:00:00Z' } });
  return json({ message: 'not found' }, 404);
});

const openIncidents = (kind: string) => db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, kind), isNull(syncIncidents.resolvedAt)));

beforeAll(async () => {
  setGhlRateLimitForTests({ minIntervalMs: 0, burstMax: 100_000 });
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  await setSetting(CREDENTIAL_KEYS.token, 'pit-test', { secret: true });
  await setSetting(CREDENTIAL_KEYS.locationId, 'loc-1');
  const prov = { source: 'ghl', origin: 'ghl' } as const;
  await db.insert(pipelines).values([{ id: 'p-app', name: 'App', isTracked: true, ...prov }, { id: 'p-other', name: 'Other', isTracked: false, ...prov }]);
  await db.insert(stages).values([
    { id: 'st-applied', pipelineId: 'p-app', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
    { id: 'st-enrolled', pipelineId: 'p-app', name: 'Enrolled', position: 1, semanticRole: 'enrolled', roleSource: 'auto', ...prov },
    { id: 'st-x', pipelineId: 'p-other', name: 'Whatever', position: 0, ...prov },
  ]);
  // The mirror as the tracked job leaves it: identical to live.
  for (const o of live) {
    await db.insert(contacts).values({ ghlContactId: o.contactId, ghlOpportunityId: o.id, pipelineId: o.pipelineId, stageId: o.pipelineStageId, opportunityStatus: o.status, ...prov });
    await db.insert(ghlOpportunities).values({ id: o.id, ghlContactId: o.contactId, pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status, ghlUpdatedAt: new Date(o.updatedAt), ...prov });
  }
});
afterAll(() => {
  vi.unstubAllGlobals();
  setGhlRateLimitForTests(null);
});

describe('ghlNumber (F7)', () => {
  it('meta.nextPage "" parses (null) instead of rejecting the page', () => {
    expect(GhlOpportunitySearchResponseSchema.parse({ opportunities: [], meta: { total: 3, nextPage: '' } }).meta?.nextPage).toBeNull();
  });
});

describe('runReconcile v2', () => {
  it('matching mirror: probes every followed stage × open/won/lost/abandoned + the pipeline total (never the unfollowed pipeline), ok', async () => {
    requests.length = 0;
    const r = await runReconcile({ trigger: 'cron' });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ ok: true, stagesChecked: 2, checks: 9, statuses: ['open', 'won', 'lost', 'abandoned'], refetchedStages: 0, skipped: [], mismatches: [] });
    const probes = requests.filter((q) => q.startsWith('/opportunities/search'));
    expect(probes).toHaveLength(9);
    expect(probes.every((q) => q.includes('pipeline_id=p-app') && q.includes('limit=1'))).toBe(true);
    expect(probes.some((q) => q.includes('status=won') && q.includes('pipeline_stage_id=st-enrolled'))).toBe(true); // v1 never asked
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, r.runId!));
    expect(run.status).toBe('succeeded');
    expect((run.stats as Record<string, unknown>).reason).toBe('mirror matches GHL: 9 checks (2 stages × 4 statuses + totals)');
  });

  it('drift is healed by a targeted re-fetch (moves, a new win, a deletion) and the re-probe matches — no incident', async () => {
    live.find((o) => o.id === 'o2')!.pipelineStageId = 'st-enrolled'; // moved + won
    live.find((o) => o.id === 'o2')!.status = 'won';
    live.find((o) => o.id === 'o2')!.updatedAt = '2026-09-30T10:00:00Z';
    live.push(opp('o5', 'st-enrolled', 'won'));                        // new, never mirrored
    live.splice(live.findIndex((o) => o.id === 'o1'), 1);              // deleted in GHL
    const r = await runReconcile({ trigger: 'cron' });
    expect(r.summary).toMatchObject({ ok: true, mismatches: [] });
    expect(r.summary!.refetchedStages).toBeGreaterThan(0);
    const rows = await db.select().from(ghlOpportunities).where(eq(ghlOpportunities.pipelineId, 'p-app'));
    expect(rows.map((x) => `${x.id}:${x.stageId}:${x.status}`).sort()).toEqual(['o2:st-enrolled:won', 'o3:st-enrolled:won', 'o4:st-enrolled:won', 'o5:st-enrolled:won']);
    const [o2contact] = await db.select().from(contacts).where(eq(contacts.ghlContactId, 'c-o2'));
    expect(o2contact.stageId).toBe('st-enrolled'); // the re-fetch went through the tracked path (contacts + positions)
    expect(await openIncidents('reconcile_mismatch')).toHaveLength(0);
  });

  it('drift that survives the re-fetch → ONE critical incident per (stage, status), refreshed; resolved when it matches', async () => {
    phantom['st-enrolled|won'] = 1; // GHL counts one more won than it will ever list
    await runReconcile({ trigger: 'cron' });
    const r = await runReconcile({ trigger: 'cron' });
    expect(r.summary!.mismatches).toEqual([{ stageId: 'st-enrolled', stageName: 'Enrolled', pipelineName: 'App', status: 'won', live: 5, mirror: 4 }]);
    const open = await openIncidents('reconcile_mismatch');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: 'critical', message: 'Mirror differs from GoHighLevel after a re-fetch: "Enrolled · won" (App) has 5 in GHL but 4 here.' });
    delete phantom['st-enrolled|won'];
    expect((await runReconcile({ trigger: 'cron' })).summary!.ok).toBe(true);
    expect(await openIncidents('reconcile_mismatch')).toHaveLength(0);
  });

  it('a probe with no total is NOT treated as 0: critical reconcile_skipped incident + FAILED run; resolved by a clean run', async () => {
    noTotalFor = 'st-applied|lost';
    const r = await runReconcile({ trigger: 'cron' });
    expect(r.ok).toBe(false);
    expect(r.summary!.skipped).toEqual(['App › Applied · lost: response had no meta.total']);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, r.runId!));
    expect(run.status).toBe('failed');
    expect((await openIncidents('reconcile_skipped'))[0]).toMatchObject({ severity: 'critical' });
    expect((await readReconcileSummary())?.ok).toBe(false);
    noTotalFor = null;
    expect((await runReconcile({ trigger: 'cron' })).ok).toBe(true);
    expect(await openIncidents('reconcile_skipped')).toHaveLength(0);
  });

  it('waits (skipped, no run row) while a GHL sync holds the lease', async () => {
    await acquireLock(GHL_LOCK, 'sync-in-progress', 60_000);
    const r = await runReconcile({ trigger: 'cron' });
    await releaseLock(GHL_LOCK, 'sync-in-progress');
    expect(r.ok).toBe(true);
    expect(r.skipped).toMatch(/a GHL sync holds the lock/);
    expect(r.runId).toBeNull();
  });
});
