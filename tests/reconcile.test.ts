/** Nightly reconciliation: live GHL per-stage counts vs the mirror, incidents on drift, summary in settings. */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, syncIncidents, syncRuns } from '@/db';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { runReconcile, readReconcileSummary, mismatchThreshold, isMismatch } from '@/lib/ghl/reconcile';

/** Live open counts per stage, mutable per test. */
const live: Record<string, number> = { 'st-a': 10, 'st-b': 4 };
const requests: string[] = [];
const fakeFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (init?.method && init.method !== 'GET') throw new Error('non-GET');
  requests.push(url.search);
  if (url.pathname === '/opportunities/search') {
    const stage = url.searchParams.get('pipeline_stage_id') ?? '';
    return new Response(JSON.stringify({ opportunities: [], meta: { total: String(live[stage] ?? 0) } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('not found', { status: 404 });
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  await setSetting(CREDENTIAL_KEYS.token, 'pit-test', { secret: true });
  await setSetting(CREDENTIAL_KEYS.locationId, 'loc-1');
  const prov = { source: 'ghl', origin: 'ghl' } as const;
  await db.insert(pipelines).values([
    { id: 'p-followed', name: 'App', isTracked: true, ...prov },
    { id: 'p-other', name: 'Other', isTracked: false, ...prov },
  ]);
  await db.insert(stages).values([
    { id: 'st-a', pipelineId: 'p-followed', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
    { id: 'st-b', pipelineId: 'p-followed', name: 'Consult Booked', position: 1, semanticRole: 'consult_booked', roleSource: 'auto', ...prov },
    { id: 'st-x', pipelineId: 'p-other', name: 'Whatever', position: 0, ...prov },
  ]);
  // Mirror: 9 open in Applied (within ±2 of 10), 1 open in Consult Booked (4 live → off by 3 > max(2, 1)).
  const rows = [];
  for (let i = 0; i < 9; i += 1) rows.push({ ghlContactId: `a${i}`, pipelineId: 'p-followed', stageId: 'st-a', opportunityStatus: 'open', ...prov });
  rows.push({ ghlContactId: 'a-won', pipelineId: 'p-followed', stageId: 'st-a', opportunityStatus: 'won', ...prov }); // not open — not counted
  rows.push({ ghlContactId: 'b0', pipelineId: 'p-followed', stageId: 'st-b', opportunityStatus: 'open', ...prov });
  await db.insert(contacts).values(rows);
});
afterAll(() => vi.unstubAllGlobals());

describe('threshold', () => {
  it('max(2, 10%)', () => {
    expect(mismatchThreshold(10, 9)).toBe(2);
    expect(mismatchThreshold(50, 40)).toBe(5);
    expect(isMismatch(10, 8)).toBe(false);
    expect(isMismatch(10, 7)).toBe(true);
    expect(isMismatch(4, 1)).toBe(true);
    expect(isMismatch(100, 91)).toBe(false);
    expect(isMismatch(100, 89)).toBe(true);
  });
});

describe('runReconcile', () => {
  it('reads one live count per followed stage (never the unfollowed pipeline), raises one incident per drifting stage, stores the summary', async () => {
    const r = await runReconcile({ trigger: 'cron' });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ ok: false, stagesChecked: 2, requests: 2 });
    expect(r.summary!.mismatches).toEqual([{ stageId: 'st-b', stageName: 'Consult Booked', pipelineName: 'App', live: 4, mirror: 1 }]);
    expect(requests.every((q) => q.includes('pipeline_id=p-followed') && q.includes('status=open') && q.includes('limit=1'))).toBe(true);
    expect(requests.some((q) => q.includes('st-x'))).toBe(false);

    const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'reconcile_mismatch'), isNull(syncIncidents.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0].message).toContain('"Consult Booked" (App) has 4 open in GHL but 1 here');
    expect(open[0].details).toMatchObject({ stageId: 'st-b', live: 4, mirror: 1, threshold: 2 });

    const stored = await readReconcileSummary();
    expect(stored?.ok).toBe(false);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.kind, 'ghl_reconcile'));
    expect(run.status).toBe('succeeded');
    expect(run.stats).toMatchObject({ stagesChecked: 2, mismatches: 1 });
  });

  it('re-running while still drifting keeps ONE open incident (refreshed); catching up resolves it', async () => {
    await runReconcile({ trigger: 'cron' });
    expect(await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'reconcile_mismatch'), isNull(syncIncidents.resolvedAt)))).toHaveLength(1);
    live['st-b'] = 1; // GHL now agrees
    const r = await runReconcile({ trigger: 'manual' });
    expect(r.summary?.ok).toBe(true);
    expect(await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, 'reconcile_mismatch'), isNull(syncIncidents.resolvedAt)))).toHaveLength(0);
  });

  it('a stage GHL cannot count is skipped with a note, not treated as zero', async () => {
    delete live['st-a'];
    fakeFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ opportunities: [], meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await runReconcile({ trigger: 'manual' });
    expect(r.ok).toBe(true);
    expect(r.summary!.skipped.length).toBe(1);
    expect(r.summary!.skipped[0]).toContain('Applied');
    expect(r.summary!.stagesChecked).toBe(1);
  });
});
