import { describe, it, expect, beforeAll } from 'vitest';
import { parseTableState, serializeTableState, toggleFilterValue, applyClient, facetOptions, compareValues, EMPTY_TABLE_STATE } from '@/components/tableState';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, appointments } from '@/db';
import { listClients } from '@/lib/queries/clients';

describe('table state ↔ URL', () => {
  it('round-trips multi-value facets, sort, page and q with a prefix', () => {
    const state = { q: 'ann', sort: 'spend', dir: 'asc' as const, filters: { platform: ['meta', 'google'], from: ['api'] }, page: 3 };
    const params = serializeTableState(new URLSearchParams('range=last_week&compare=off'), state, 'c_', ['platform', 'from']);
    expect(params.get('c_q')).toBe('ann');
    expect(params.get('c_sort')).toBe('spend');
    expect(params.get('c_dir')).toBe('asc');
    expect(params.get('c_page')).toBe('3');
    expect(params.get('c_platform')).toBe('meta,google');
    expect(params.get('range')).toBe('last_week'); // global picker keys untouched
    expect(parseTableState(params, 'c_', ['platform', 'from'])).toEqual(state);
    // A second table with another prefix sees nothing of it.
    expect(parseTableState(params, 'p_', ['status'])).toEqual(EMPTY_TABLE_STATE);
  });

  it('drops defaults and encodes values with commas', () => {
    const params = serializeTableState(new URLSearchParams('c_q=x&c_platform=meta'), { ...EMPTY_TABLE_STATE, filters: { campaign: ['Brand, search'] } }, 'c_', ['platform', 'campaign']);
    expect(params.get('c_q')).toBeNull();
    expect(params.get('c_platform')).toBeNull();
    expect(params.get('c_dir')).toBeNull();
    expect(parseTableState(params, 'c_', ['platform', 'campaign']).filters).toEqual({ campaign: ['Brand, search'] });
  });

  it('toggles values and resets the page', () => {
    let s = { ...EMPTY_TABLE_STATE, page: 4 };
    s = toggleFilterValue(s, 'status', 'failed');
    expect(s.filters).toEqual({ status: ['failed'] });
    expect(s.page).toBe(1);
    s = toggleFilterValue(s, 'status', 'succeeded');
    s = toggleFilterValue(s, 'status', 'failed');
    expect(s.filters).toEqual({ status: ['succeeded'] });
    s = toggleFilterValue(s, 'status', 'succeeded');
    expect(s.filters).toEqual({});
  });
});

interface Row {
  name: string;
  email: string | null;
  platform: string;
  status: string;
  spend: number | null;
}
const ROWS: Row[] = [
  { name: 'Summer Shred', email: 'a@x.com', platform: 'meta', status: 'active', spend: 300 },
  { name: 'Retarget', email: null, platform: 'meta', status: 'paused', spend: 100 },
  { name: 'Brand search', email: 'brand@x.com', platform: 'google', status: 'active', spend: null },
  { name: 'Manual entry', email: 'm@x.com', platform: 'other', status: 'active', spend: 50 },
];
const OPTS = {
  search: [(r: Row) => r.name, (r: Row) => r.email],
  facets: { platform: (r: Row) => r.platform, status: (r: Row) => r.status },
  sorts: { spend: (r: Row) => r.spend, name: (r: Row) => r.name },
  defaultSort: { key: 'spend', dir: 'desc' as const },
};

describe('applyClient', () => {
  it('text search spans every accessor and every term must match', () => {
    expect(applyClient(ROWS, { ...EMPTY_TABLE_STATE, q: 'brand' }, OPTS).map((r) => r.name)).toEqual(['Brand search']);
    expect(applyClient(ROWS, { ...EMPTY_TABLE_STATE, q: 'x.com' }, OPTS)).toHaveLength(3);
    expect(applyClient(ROWS, { ...EMPTY_TABLE_STATE, q: 'summer x.com' }, OPTS).map((r) => r.name)).toEqual(['Summer Shred']);
    expect(applyClient(ROWS, { ...EMPTY_TABLE_STATE, q: 'nothing' }, OPTS)).toEqual([]);
  });

  it('facets: OR within a facet, AND across facets; unknown facets ignored', () => {
    const within = applyClient(ROWS, { ...EMPTY_TABLE_STATE, filters: { platform: ['meta', 'google'] } }, OPTS);
    expect(within.map((r) => r.name)).toEqual(['Summer Shred', 'Retarget', 'Brand search']);
    const across = applyClient(ROWS, { ...EMPTY_TABLE_STATE, filters: { platform: ['meta', 'google'], status: ['active'] } }, OPTS);
    expect(across.map((r) => r.name)).toEqual(['Summer Shred', 'Brand search']);
    expect(applyClient(ROWS, { ...EMPTY_TABLE_STATE, filters: { nope: ['x'] } }, OPTS)).toHaveLength(4);
  });

  it('sorts asc/desc with nulls last, default sort when none chosen, stable ties', () => {
    expect(applyClient(ROWS, EMPTY_TABLE_STATE, OPTS).map((r) => r.spend)).toEqual([300, 100, 50, null]);
    expect(applyClient(ROWS, { ...EMPTY_TABLE_STATE, sort: 'spend', dir: 'asc' }, OPTS).map((r) => r.spend)).toEqual([50, 100, 300, null]);
    expect(applyClient(ROWS, { ...EMPTY_TABLE_STATE, sort: 'name', dir: 'asc' }, OPTS).map((r) => r.name)).toEqual(['Brand search', 'Manual entry', 'Retarget', 'Summer Shred']);
    expect(compareValues('a10', 'a9', 'asc')).toBeGreaterThan(0); // numeric-aware
  });

  it('facetOptions counts and labels', () => {
    expect(facetOptions(ROWS, (r) => r.platform)).toEqual([
      { value: 'meta', label: 'meta', count: 2 },
      { value: 'google', label: 'google', count: 1 },
      { value: 'other', label: 'other', count: 1 },
    ]);
    expect(facetOptions(ROWS, (r) => r.status, (v) => v.toUpperCase())[0]).toEqual({ value: 'active', label: 'ACTIVE', count: 3 });
  });
});

describe('listClients multi-value filters', () => {
  const prov = { source: 'ghl', origin: 'ghl', syncedAt: new Date(), backfilled: false } as const;

  beforeAll(async () => {
    await runMigrations();
    await db.insert(pipelines).values({ id: 'pf', name: 'P', ...prov });
    await db.insert(stages).values([
      { id: 'sf-applied', pipelineId: 'pf', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
      { id: 'sf-consult', pipelineId: 'pf', name: 'Consult Booked', position: 1, semanticRole: 'consult_booked', roleSource: 'auto', ...prov },
      { id: 'sf-enrolled', pipelineId: 'pf', name: 'Enrolled', position: 2, semanticRole: 'enrolled', roleSource: 'auto', ...prov },
    ]);
    const rows = await db
      .insert(contacts)
      .values([
        { ghlContactId: 'f1', pipelineId: 'pf', stageId: 'sf-applied', firstName: 'Ada', lastName: 'A', email: 'ada@x.com', attributionSource: 'Facebook', opportunityStatus: 'open', ghlCreatedAt: new Date('2026-08-01T12:00:00Z'), ...prov },
        { ghlContactId: 'f2', pipelineId: 'pf', stageId: 'sf-consult', firstName: 'Ben', lastName: 'B', email: 'ben@x.com', attributionSource: 'Google', opportunityStatus: 'open', ghlCreatedAt: new Date('2026-08-05T12:00:00Z'), ...prov },
        { ghlContactId: 'f3', pipelineId: 'pf', stageId: 'sf-enrolled', firstName: 'Cy', lastName: 'C', email: 'cy@x.com', attributionSource: null, opportunityStatus: 'won', ghlCreatedAt: new Date('2026-08-09T12:00:00Z'), ...prov },
      ])
      .returning({ id: contacts.id, ghl: contacts.ghlContactId });
    const ben = rows.find((r) => r.ghl === 'f2')!.id;
    const cy = rows.find((r) => r.ghl === 'f3')!.id;
    await db.insert(appointments).values([
      { ghlEventId: 'fe1', contactId: ben, type: 'Consult', startTime: new Date('2026-08-07T15:00:00Z'), ghlStatus: 'confirmed', ...prov },
      { ghlEventId: 'fe2', contactId: cy, type: 'Consult', startTime: new Date('2026-08-10T15:00:00Z'), ghlStatus: 'showed', outcome: 'showed', ...prov },
      { ghlEventId: 'fe3', contactId: cy, type: 'Roadmap', startTime: new Date('2026-08-14T15:00:00Z'), ghlStatus: 'showed', outcome: 'showed', ...prov },
    ]);
  });

  it('multi-value stage (OR) and appointment type facets combine (AND)', async () => {
    const twoStages = await listClients({ stageId: ['sf-consult', 'sf-enrolled'] });
    expect(twoStages.rows.map((r) => r.name).sort()).toEqual(['Ben B', 'Cy C']);
    const roadmap = await listClients({ apptType: 'Roadmap' });
    expect(roadmap.rows.map((r) => r.name)).toEqual(['Cy C']);
    const both = await listClients({ stageId: ['sf-consult', 'sf-enrolled'], apptType: ['Consult'] });
    expect(both.rows.map((r) => r.name).sort()).toEqual(['Ben B', 'Cy C']);
    const none = await listClients({ stageId: 'sf-applied', apptType: 'Consult' });
    expect(none.total).toBe(0);
  });

  it('source "Unknown" matches null, status filters, comma-list strings, and sort/dir', async () => {
    expect((await listClients({ source: 'Unknown' })).rows.map((r) => r.name)).toEqual(['Cy C']);
    expect((await listClients({ source: 'Facebook,Google' })).total).toBe(2);
    expect((await listClients({ status: ['won'] })).rows.map((r) => r.name)).toEqual(['Cy C']);
    expect((await listClients({ sort: 'name', dir: 'asc' })).rows.map((r) => r.name)).toEqual(['Ada A', 'Ben B', 'Cy C']);
    expect((await listClients({ sort: 'applied', dir: 'desc' })).rows.map((r) => r.name)).toEqual(['Cy C', 'Ben B', 'Ada A']);
    expect((await listClients({ sort: 'stage', dir: 'desc' })).rows[0].name).toBe('Cy C');
    const facets = (await listClients({})).facets;
    expect(facets.apptTypes).toEqual([
      { type: 'Consult', count: 2 },
      { type: 'Roadmap', count: 1 },
    ]);
    expect(facets.statuses.map((s) => s.status).sort()).toEqual(['open', 'won']);
  });
});
