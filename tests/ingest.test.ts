/**
 * End-to-end sync against a mocked GoHighLevel API and an in-memory Postgres
 * (PGlite). Exercises: dynamic pipeline/stage mirror + role mapping, unmapped
 * stage surfacing, contact/appointment upserts (idempotent), stage-transition
 * derivation across two syncs, provenance flags, and the backfill flag.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, appointments, stageTransitions, syncRuns, syncIncidents, payments } from '@/db';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { runGhlSync } from '@/lib/ghl/ingest';
import { DEFAULT_FOLLOWED_PIPELINE_ID } from '@/lib/ghl/followed';

type Json = Record<string, unknown>;

/** Mutable fake of Miranda's account. Tests change it between syncs. */
const account = {
  pipelines: [
    {
      id: 'pipe-1',
      name: 'Application Pipeline',
      stages: [
        { id: 'st-applied', name: 'Applied', position: 0 },
        { id: 'st-consult', name: 'Consult Booked', position: 1 },
        { id: 'st-weird', name: 'Nurture Bucket', position: 2 },
        { id: 'st-enrolled', name: 'Enrolled', position: 3 },
      ],
    },
  ],
  opportunities: [
    {
      id: 'opp-1',
      name: 'Jane Doe',
      pipelineId: 'pipe-1',
      pipelineStageId: 'st-applied',
      status: 'open',
      contactId: 'ct-1',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
      contact: { id: 'ct-1', name: 'Jane Doe', email: 'Jane@Example.com', phone: '(555) 000-1111' },
    },
  ] as Json[],
  calendars: [{ id: 'cal-1', name: 'Discovery Consult', isActive: true }],
  events: [
    {
      id: 'ev-1',
      calendarId: 'cal-1',
      contactId: 'ct-1',
      title: 'Consult with Jane',
      appointmentStatus: 'confirmed',
      startTime: '2026-08-27T15:00:00Z',
      endTime: '2026-08-27T15:30:00Z',
    },
  ] as Json[],
  contacts: {
    'ct-1': {
      id: 'ct-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      phone: '+15550001111',
      source: 'Facebook',
      attributions: [{ utmSource: 'facebook', utmCampaign: 'Summer', isFirst: true }],
      tags: ['lead'],
      dateAdded: '2026-08-20T09:00:00Z',
    },
  } as Record<string, Json>,
  users: [{ id: 'u-1', name: 'Miranda' }],
};

const requests: Array<{ method: string; url: string }> = [];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const fakeFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  requests.push({ method: init?.method ?? 'GET', url: url.pathname });
  if (init?.method && init.method !== 'GET') throw new Error(`non-GET reached the network: ${init.method}`);

  if (url.pathname === '/opportunities/pipelines') return json({ pipelines: account.pipelines });
  if (url.pathname === '/opportunities/search') return json({ opportunities: account.opportunities, meta: {} });
  if (url.pathname === '/calendars/') return json({ calendars: account.calendars });
  if (url.pathname === '/calendars/events') return json({ events: account.events });
  if (url.pathname === '/users/') return json({ users: account.users });
  const m = url.pathname.match(/^\/contacts\/([^/]+)$/);
  if (m) return account.contacts[m[1]] ? json({ contact: account.contacts[m[1]] }) : new Response('nope', { status: 404 });
  return new Response('not found', { status: 404 });
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  await runMigrations();
  await setSetting(CREDENTIAL_KEYS.token, 'pit-test', { secret: true });
  await setSetting(CREDENTIAL_KEYS.locationId, 'loc-1');
});

afterAll(() => vi.unstubAllGlobals());

describe('runGhlSync', () => {
  it('backfill mirrors pipelines/stages, maps roles, surfaces unmapped stages, imports rows flagged backfilled', async () => {
    // New pipelines arrive UNFOLLOWED: rows are still mirrored and imported,
    // but unmapped-stage warnings stay quiet until a human follows.
    const first = await runGhlSync({ mode: 'backfill', trigger: 'cli', since: '2026-06-16' });
    expect(first.ok).toBe(true);
    expect(first.stats).toMatchObject({ pipelines: 1, stages: 4, stagesUnmapped: 0, opportunities: 1 });
    expect((await db.select().from(pipelines))[0].isTracked).toBe(false);
    expect((await db.select().from(syncIncidents)).some((i) => i.kind === 'unmapped_stage')).toBe(false);

    // Follow it (what Setup's toggle does) and sync again.
    await db.update(pipelines).set({ isTracked: true }).where(eq(pipelines.id, 'pipe-1'));
    const result = await runGhlSync({ mode: 'backfill', trigger: 'cli', since: '2026-06-16' });
    expect(result.ok).toBe(true);
    expect(result.stats).toMatchObject({ pipelines: 1, stages: 4, stagesUnmapped: 1, opportunities: 1, appointmentsUpserted: 1 });

    const stageRows = await db.select().from(stages).orderBy(asc(stages.position));
    expect(stageRows.map((s) => [s.name, s.semanticRole, s.roleSource])).toEqual([
      ['Applied', 'applied', 'auto'],
      ['Consult Booked', 'consult_booked', 'auto'],
      ['Nurture Bucket', null, 'unmapped'],
      ['Enrolled', 'enrolled', 'auto'],
    ]);
    expect(stageRows.every((s) => s.source === 'ghl' && s.backfilled && s.origin === 'ghl')).toBe(true);

    const incidents = await db.select().from(syncIncidents);
    expect(incidents.some((i) => i.kind === 'unmapped_stage' && i.details?.stageId === 'st-weird')).toBe(true);

    const [c] = await db.select().from(contacts);
    expect(c).toMatchObject({
      ghlContactId: 'ct-1',
      ghlOpportunityId: 'opp-1',
      stageId: 'st-applied',
      firstName: 'Jane',
      emailNormalized: 'jane@example.com',
      phoneNormalized: '15550001111',
      attributionSource: 'Facebook',
      utmCampaign: 'Summer',
      backfilled: true,
      source: 'ghl',
      // Phase G: paid/organic derived from the first-touch signals at sync.
      attributionClass: 'paid',
      attributionReason: 'utm_source "facebook" matches a paid pattern',
      attributionClassSource: 'auto',
    });

    const [a] = await db.select().from(appointments);
    expect(a).toMatchObject({ ghlEventId: 'ev-1', type: 'Consult', contactId: c.id, outcome: null, ghlStatus: 'confirmed', backfilled: true });

    const [t] = await db.select().from(stageTransitions);
    expect(t).toMatchObject({ fromStageId: null, toStageId: 'st-applied', toRole: 'applied', kind: 'backfill' });
    expect(t.observedAt.toISOString()).toBe('2026-08-20T10:00:00.000Z');

    // Only GETs ever reached the network.
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('re-running the backfill is idempotent', async () => {
    const before = {
      contacts: (await db.select().from(contacts)).length,
      appointments: (await db.select().from(appointments)).length,
      transitions: (await db.select().from(stageTransitions)).length,
    };
    const result = await runGhlSync({ mode: 'backfill', trigger: 'cli', since: '2026-06-16' });
    expect(result.ok).toBe(true);
    expect((await db.select().from(contacts)).length).toBe(before.contacts);
    expect((await db.select().from(appointments)).length).toBe(before.appointments);
    // Transition already recorded for this position → no new row.
    expect((await db.select().from(stageTransitions)).length).toBe(before.transitions);
  });

  it('delta sync derives a stage transition and mirrors an appointment outcome', async () => {
    account.opportunities[0] = {
      ...account.opportunities[0],
      pipelineStageId: 'st-consult',
      updatedAt: '2026-08-26T12:00:00Z',
      lastStageChangeAt: '2026-08-26T12:00:00Z',
    };
    account.events[0] = { ...account.events[0], appointmentStatus: 'noshow' };

    const result = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(result.ok).toBe(true);
    expect(result.stats.transitions).toBe(1);

    const moves = await db.select().from(stageTransitions).orderBy(asc(stageTransitions.observedAt));
    expect(moves).toHaveLength(2);
    expect(moves[1]).toMatchObject({ fromStageId: 'st-applied', toStageId: 'st-consult', fromRole: 'applied', toRole: 'consult_booked', kind: 'diff', backfilled: false });

    const [c] = await db.select().from(contacts);
    expect(c.stageId).toBe('st-consult');
    expect(c.backfilled).toBe(false);

    const [a] = await db.select().from(appointments);
    expect(a.outcome).toBe('no_show');
    expect(a.ghlStatus).toBe('noshow');

    const runs = await db.select().from(syncRuns).where(eq(syncRuns.kind, 'ghl_delta'));
    expect(runs[0].status).toBe('succeeded');
  });

  it('a manual attribution override survives a sync that re-fetches the contact', async () => {
    const [before] = await db.select().from(contacts).where(eq(contacts.ghlContactId, 'ct-1'));
    await db.update(contacts).set({ attributionClass: 'organic', attributionReason: 'manual override', attributionClassSource: 'manual' }).where(eq(contacts.id, before.id));
    // Backfill re-fetches every contact, so the sync has fresh (paid) evidence — the override must still win.
    const result = await runGhlSync({ mode: 'backfill', trigger: 'cli', since: '2026-06-16' });
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(contacts).where(eq(contacts.ghlContactId, 'ct-1'));
    expect(after).toMatchObject({ attributionClass: 'organic', attributionReason: 'manual override', attributionClassSource: 'manual' });
    await db.update(contacts).set({ attributionClass: 'paid', attributionClassSource: 'auto' }).where(eq(contacts.id, before.id));
  });

  it('a manual role override survives the next sync, and a renamed stage is re-mapped', async () => {
    await db.update(stages).set({ semanticRole: 'other', roleSource: 'manual' }).where(eq(stages.id, 'st-weird'));
    account.pipelines[0].stages[1] = { id: 'st-consult', name: 'Discovery Call Booked', position: 1 };

    const result = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(result.ok).toBe(true);

    const weird = (await db.select().from(stages).where(eq(stages.id, 'st-weird')))[0];
    expect(weird).toMatchObject({ semanticRole: 'other', roleSource: 'manual' });
    const consult = (await db.select().from(stages).where(eq(stages.id, 'st-consult')))[0];
    expect(consult).toMatchObject({ name: 'Discovery Call Booked', semanticRole: 'consult_booked' });
    expect((await db.select().from(pipelines)).length).toBe(1);
  });

  it('mirrors unfollowed/{ Off } pipelines without letting them drive position or warnings', async () => {
    account.pipelines.push({
      id: 'pipe-off',
      name: '{ Off } Old Funnel',
      stages: [{ id: 'st-off-1', name: 'Some Random Bucket', position: 0 }],
    });
    // A NEWER opportunity for Jane in the retired pipeline must not win her
    // position away from the followed pipeline.
    account.opportunities.push({
      id: 'opp-off',
      name: 'Jane Doe',
      pipelineId: 'pipe-off',
      pipelineStageId: 'st-off-1',
      status: 'open',
      contactId: 'ct-1',
      createdAt: '2026-08-28T09:00:00Z',
      updatedAt: '2026-08-28T09:00:00Z',
    });

    const result = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(result.ok).toBe(true);
    expect(result.stats.opportunities).toBe(2);
    expect(result.stats.stagesUnmapped).toBe(0); // 'Some Random Bucket' is unfollowed noise

    const [offPipe] = await db.select().from(pipelines).where(eq(pipelines.id, 'pipe-off'));
    expect(offPipe.isTracked).toBe(false); // mirrored, never auto-followed
    expect((await db.select().from(stages).where(eq(stages.id, 'st-off-1')))).toHaveLength(1);
    expect((await db.select().from(syncIncidents)).some((i) => i.details?.stageId === 'st-off-1')).toBe(false);

    const [jane] = await db.select().from(contacts).where(eq(contacts.ghlContactId, 'ct-1'));
    expect(jane.pipelineId).toBe('pipe-1');
  });

  it('the hard-default funnel pipeline is followed on first sight; a later unfollow is respected', async () => {
    account.pipelines.push({
      id: DEFAULT_FOLLOWED_PIPELINE_ID,
      name: '[new] Application Pipeline',
      stages: [
        { id: 'st-new-applied', name: 'Applied', position: 0 },
        { id: 'st-new-resched', name: 'Consult Rescheduled', position: 1 },
        { id: 'st-new-prev', name: 'Previous Leads', position: 2 },
      ],
    });
    const result = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(result.ok).toBe(true);
    const [row] = await db.select().from(pipelines).where(eq(pipelines.id, DEFAULT_FOLLOWED_PIPELINE_ID));
    expect(row.isTracked).toBe(true);
    const roles = Object.fromEntries((await db.select().from(stages).where(eq(stages.pipelineId, DEFAULT_FOLLOWED_PIPELINE_ID))).map((s) => [s.name, s.semanticRole]));
    expect(roles).toEqual({ Applied: 'applied', 'Consult Rescheduled': 'consult_rescheduled', 'Previous Leads': 'previous_lead' });

    // A human unfollows it; the next sync must not re-follow.
    await db.update(pipelines).set({ isTracked: false }).where(eq(pipelines.id, DEFAULT_FOLLOWED_PIPELINE_ID));
    await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect((await db.select().from(pipelines).where(eq(pipelines.id, DEFAULT_FOLLOWED_PIPELINE_ID)))[0].isTracked).toBe(false);
    account.pipelines.pop();
  });

  it('re-matches unmatched Stripe payments as soon as a sync lands contacts', async () => {
    // A payment synced before any contacts existed (first real run: 0/324
    // matched). The next GHL sync must pick it up — not the next reconcile.
    await db.insert(payments).values([
      {
        stripeId: 'ch_wait',
        kind: 'charge',
        status: 'succeeded',
        amountCents: 50000,
        email: 'jane@example.com',
        emailNormalized: 'jane@example.com',
        paidAt: new Date('2026-08-21T10:00:00Z'),
        source: 'stripe',
        origin: 'stripe',
      },
      {
        stripeId: 'ch_manual_none',
        kind: 'charge',
        status: 'succeeded',
        amountCents: 100,
        emailNormalized: 'jane@example.com',
        contactId: null,
        matchSource: 'manual', // human said "no match" — never overwritten
        paidAt: new Date('2026-08-21T10:00:00Z'),
        source: 'stripe',
        origin: 'stripe',
      },
    ]);

    const result = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(result.ok).toBe(true);
    expect(result.stats.paymentsMatched).toBe(1);

    const [jane] = await db.select().from(contacts).where(eq(contacts.ghlContactId, 'ct-1'));
    const [matched] = await db.select().from(payments).where(eq(payments.stripeId, 'ch_wait'));
    expect(matched.contactId).toBe(jane.id);
    expect(matched.matchSource).toBe('auto');
    const [manual] = await db.select().from(payments).where(eq(payments.stripeId, 'ch_manual_none'));
    expect(manual.contactId).toBeNull();
    expect(manual.matchSource).toBe('manual');
  });

  it('records a failed run without credentials', async () => {
    await setSetting(CREDENTIAL_KEYS.token, '', { secret: true });
    const result = await runGhlSync({ mode: 'delta', trigger: 'manual' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credentials/i);
  });
});
