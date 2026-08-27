import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, stageTransitions, appointments, payments } from '@/db';
import { getClientProfile, listClients, buildGhlUrl } from '@/lib/queries/clients';
import { GET as getClient } from '@/app/api/clients/[id]/route';

const prov = { source: 'ghl', origin: 'ghl', syncedAt: new Date(), backfilled: false } as const;
let annId = '';
let bobId = '';

beforeAll(async () => {
  await runMigrations();
  await db.insert(pipelines).values({ id: 'p1', name: 'Application', ...prov });
  await db.insert(stages).values([
    { id: 's-applied', pipelineId: 'p1', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
    { id: 's-consult', pipelineId: 'p1', name: 'Consult Booked', position: 1, semanticRole: 'consult_booked', roleSource: 'auto', ...prov },
    { id: 's-enrolled', pipelineId: 'p1', name: 'Enrolled', position: 2, semanticRole: 'enrolled', roleSource: 'auto', ...prov },
  ]);
  const [ann] = await db
    .insert(contacts)
    .values({
      ghlContactId: 'ct-ann',
      pipelineId: 'p1',
      stageId: 's-enrolled',
      firstName: 'Ann',
      lastName: 'Apple',
      email: 'ann@example.com',
      phone: '+1 (555) 000-1111',
      phoneNormalized: '15550001111',
      attributionSource: 'Facebook',
      ghlCreatedAt: new Date('2026-08-01T12:00:00Z'),
      ...prov,
    })
    .returning({ id: contacts.id });
  annId = ann.id;
  const [bob] = await db
    .insert(contacts)
    .values({ ghlContactId: 'ct-bob', pipelineId: 'p1', stageId: 's-applied', firstName: 'Bob', lastName: 'Berry', email: 'bob@example.com', attributionSource: 'Google', ghlCreatedAt: new Date('2026-08-10T12:00:00Z'), ...prov })
    .returning({ id: contacts.id });
  bobId = bob.id;

  await db.insert(stageTransitions).values([
    { contactId: annId, pipelineId: 'p1', fromStageId: null, toStageId: 's-applied', toRole: 'applied', observedAt: new Date('2026-08-01T12:00:00Z'), kind: 'initial', ...prov },
    { contactId: annId, pipelineId: 'p1', fromStageId: 's-applied', toStageId: 's-consult', fromRole: 'applied', toRole: 'consult_booked', observedAt: new Date('2026-08-03T12:00:00Z'), previousObservedAt: new Date('2026-08-03T11:00:00Z'), kind: 'diff', ...prov },
    { contactId: annId, pipelineId: 'p1', fromStageId: 's-consult', toStageId: 's-enrolled', fromRole: 'consult_booked', toRole: 'enrolled', observedAt: new Date('2026-08-09T12:00:00Z'), kind: 'diff', ...prov },
  ]);
  await db.insert(appointments).values({
    ghlEventId: 'ev-1',
    contactId: annId,
    type: 'Consult',
    title: 'Consult with Ann',
    startTime: new Date('2026-08-05T15:00:00Z'),
    ghlStatus: 'showed',
    outcome: 'showed',
    ...prov,
  });
  await db.insert(payments).values({
    stripeId: 'ch_1',
    kind: 'charge',
    status: 'succeeded',
    amountCents: 299_900,
    contactId: annId,
    matchSource: 'auto',
    paidAt: new Date('2026-08-10T09:00:00Z'),
    ...prov,
    source: 'stripe',
    origin: 'stripe',
  });
});

describe('getClientProfile', () => {
  it('builds a newest-first unified timeline with tones', async () => {
    const p = await getClientProfile(annId);
    expect(p).not.toBeNull();
    expect(p!.name).toBe('Ann Apple');
    expect(p!.stageName).toBe('Enrolled');
    expect(p!.stageRole).toBe('enrolled');
    expect(p!.timeline.map((t) => t.type)).toEqual(['payment', 'transition', 'appointment', 'transition', 'transition']);
    expect(p!.timeline.map((t) => t.at)).toEqual([...p!.timeline.map((t) => t.at)].sort().reverse());
    expect(p!.timeline[0]).toMatchObject({ tone: 'positive', title: 'Payment $2,999.00 · succeeded' });
    expect(p!.timeline[1]).toMatchObject({ tone: 'positive', title: 'Consult Booked → Enrolled' });
    expect(p!.timeline[2]).toMatchObject({ tone: 'positive', title: 'Consult · Showed' });
    expect(p!.timeline[4]).toMatchObject({ tone: 'neutral', title: 'Entered Applied' });
    expect(p!.stageEnteredAt).toBe('2026-08-09T12:00:00.000Z');
    expect(p!.timeInStageHours).toBeGreaterThan(0);
    expect(p!.lastActivityAt).toBe('2026-08-10T09:00:00.000Z');
    expect(p!.ghlUrl).toBeNull(); // no location id configured
  });

  it('deep-links only with a location id and never for demo rows', () => {
    expect(buildGhlUrl('loc1', 'ct-ann', 'ghl')).toBe('https://app.gohighlevel.com/v2/location/loc1/contacts/detail/ct-ann');
    expect(buildGhlUrl('loc1', 'ct-ann', 'demo')).toBeNull();
    expect(buildGhlUrl(null, 'ct-ann', 'ghl')).toBeNull();
  });

  it('returns null for an unknown id and the route 404s', async () => {
    expect(await getClientProfile('nope')).toBeNull();
    const res = await getClient(new NextRequest('http://localhost/api/clients/nope'), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(404);
  });
});

describe('listClients', () => {
  it('filters by query (email fragment, phone digits) and by stage, with facets', async () => {
    const all = await listClients();
    expect(all.total).toBe(2);
    expect(all.rows.map((r) => r.name)).toEqual(['Bob Berry', 'Ann Apple']); // applied desc
    expect(all.facets.stages.find((s) => s.id === 's-enrolled')?.count).toBe(1);
    expect(all.facets.sources.map((s) => s.source).sort()).toEqual(['Facebook', 'Google']);

    const byEmail = await listClients({ q: 'ann@' });
    expect(byEmail.rows.map((r) => r.id)).toEqual([annId]);
    const byPhone = await listClients({ q: '555-000' });
    expect(byPhone.rows.map((r) => r.id)).toEqual([annId]);
    const byStage = await listClients({ stageId: 's-applied' });
    expect(byStage.rows.map((r) => r.id)).toEqual([bobId]);
    const byDate = await listClients({ from: '2026-08-05', to: '2026-08-31' });
    expect(byDate.rows.map((r) => r.id)).toEqual([bobId]);
    expect(byEmail.rows[0].lastActivityAt).toBe('2026-08-10T09:00:00.000Z');
  });
});
