/**
 * End-to-end sync against a mocked GoHighLevel API and an in-memory Postgres
 * (PGlite). Exercises: dynamic pipeline/stage mirror + role mapping, unmapped
 * stage surfacing, contact/appointment upserts (idempotent), stage-transition
 * derivation across two syncs, provenance flags, and the backfill flag.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { eq, asc, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, settings, pipelines, stages, contacts, appointments, stageTransitions, syncRuns, syncIncidents, payments, syncLocks, ghlOpportunities } from '@/db';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { runGhlSync, readMirrorCursor, GHL_LOCK, GHL_LOCK_TTL_MS } from '@/lib/ghl/ingest';
import { acquireLock, releaseLock } from '@/lib/syncLock';
import { DEFAULT_FOLLOWED_PIPELINE_ID } from '@/lib/ghl/followed';
import { setGhlRateLimitForTests } from '@/lib/ghl/client';

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
  if (url.pathname === '/opportunities/search') {
    // The real endpoint filters by pipeline_id and pages by `page`/`limit`.
    const pipelineId = url.searchParams.get('pipeline_id');
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const page = Number(url.searchParams.get('page') ?? 1);
    const all = account.opportunities.filter((o) => !pipelineId || o.pipelineId === pipelineId);
    return json({ opportunities: all.slice((page - 1) * limit, page * limit), meta: { total: all.length } });
  }
  if (url.pathname === '/calendars/') return json({ calendars: account.calendars });
  if (url.pathname === '/calendars/events') return json({ events: account.events });
  if (url.pathname === '/users/') return json({ users: account.users });
  const m = url.pathname.match(/^\/contacts\/([^/]+)$/);
  if (m) return account.contacts[m[1]] ? json({ contact: account.contacts[m[1]] }) : new Response('nope', { status: 404 });
  return new Response('not found', { status: 404 });
});

beforeAll(async () => {
  // GHL is faked here: keep the limiter's logic, drop its wall-clock spacing.
  setGhlRateLimitForTests({ minIntervalMs: 0, burstMax: 100_000 });
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

    const result = await runGhlSync({ mode: 'delta', trigger: 'cron', mirrors: 'force' });
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

describe('Ingestion v2: the followed pipeline is read completely on EVERY run (F1)', () => {
  const setting = async (key: string) => (await db.select().from(settings).where(eq(settings.key, key)))[0]?.value ?? null;
  const marker = async (family: string) => { const v = await setting(`marker:${family}`); return v ? JSON.parse(v) : null; };
  const clear = async (key: string) => { await db.delete(settings).where(eq(settings.key, key)); };
  const followedOnly = async () => {
    await db.update(pipelines).set({ isTracked: false });
    await db.update(pipelines).set({ isTracked: true }).where(eq(pipelines.id, 'pipe-1'));
  };

  beforeAll(async () => {
    await setSetting(CREDENTIAL_KEYS.token, 'pit-test', { secret: true });
    await setSetting(CREDENTIAL_KEYS.locationId, 'loc-1');
    // 250 opportunities in the followed pipeline → 3 pages of 100.
    for (let i = 0; i < 249; i += 1) {
      const id = `ct-v2-${i}`;
      account.opportunities.push({ id: `opp-v2-${i}`, name: `P${i}`, pipelineId: 'pipe-1', pipelineStageId: 'st-applied', status: 'open', contactId: id, createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z' });
      account.contacts[id] = { id, firstName: `P${i}`, email: `p${i}@x.com`, dateAdded: '2026-09-20T09:00:00Z' };
    }
    await followedOnly();
  });

  it("LEGACY CURSOR (would have caught F1): a pre-v2 cursor sitting past the followed pipeline is ignored — the run reads it and only THEN writes the marker", async () => {
    await setSetting('ghl_sync_cursor', JSON.stringify({ mode: 'delta', cycleStartedAt: '2026-09-18T12:47:00Z', since: null, order: ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'pipe-1'], index: 7, page: 1, startAfterId: null, startAfter: null, stats: {}, warnings: [], runs: 29, timezone: 'America/Edmonton' }));
    await clear('marker:ghl.opportunities');
    account.opportunities.push({ id: 'opp-new-sep29', name: 'New applicant', pipelineId: 'pipe-1', pipelineStageId: 'st-applied', status: 'open', contactId: 'ct-new-sep29', createdAt: '2026-09-29T15:00:00Z', updatedAt: '2026-09-29T15:00:00Z' });
    account.contacts['ct-new-sep29'] = { id: 'ct-new-sep29', firstName: 'New', email: 'new@x.com', dateAdded: '2026-09-29T15:00:00Z' };
    requests.length = 0;
    const r = await runGhlSync({ mode: 'delta', trigger: 'cron', mirrors: 'skip' });
    expect(r.error, JSON.stringify(r.warnings)).toBeUndefined();
    expect(r).toMatchObject({ ok: true, partial: false, trackedComplete: true });
    expect(requests.filter((q) => q.url === '/opportunities/search').length).toBe(3); // every page of the followed pipeline
    const [created] = await db.select().from(contacts).where(eq(contacts.ghlContactId, 'ct-new-sep29'));
    expect(created).toMatchObject({ pipelineId: 'pipe-1', stageId: 'st-applied' });
    expect(created.opportunityCreatedAt?.toISOString()).toBe('2026-09-29T15:00:00.000Z');
    const m = await marker('ghl.opportunities');
    expect(m).toMatchObject({ runId: r.runId, fetched: 251, liveTotal: 251 });
    expect(await marker('ghl.appointments')).toMatchObject({ runId: r.runId });
    expect(r.progress).toMatch(/^followed pipeline: 251 opportunities refreshed at /);
  });

  it('first run after deploy re-reads every contact (no stored opportunity rows); a quiet next run fetches none', async () => {
    await db.delete(ghlOpportunities);
    const first = await runGhlSync({ mode: 'delta', trigger: 'cron', mirrors: 'skip' });
    expect(first.stats.contactsFetched).toBe(251);
    const quiet = await runGhlSync({ mode: 'delta', trigger: 'cron', mirrors: 'skip' });
    expect(quiet.stats.contactsFetched).toBe(0);
    expect(quiet.stats.opportunities).toBe(251); // still read every opportunity
    expect(await db.select().from(ghlOpportunities).where(eq(ghlOpportunities.pipelineId, 'pipe-1'))).toHaveLength(251);
    // One changed opportunity → exactly that contact is re-fetched.
    const o = account.opportunities.find((x) => x.id === 'opp-v2-7')!;
    o.updatedAt = '2026-09-30T08:00:00Z';
    o.pipelineStageId = 'st-consult';
    const changed = await runGhlSync({ mode: 'delta', trigger: 'cron', mirrors: 'skip' });
    expect(changed.stats.contactsFetched).toBe(1);
    expect(changed.stats.transitions).toBe(1);
  });

  it('a run out of budget in the followed pipeline is PARTIAL with its reason and writes NO marker', async () => {
    const before = await marker('ghl.opportunities');
    const r = await runGhlSync({ mode: 'delta', trigger: 'cron', maxPages: 1 });
    expect(r).toMatchObject({ ok: true, partial: true, trackedComplete: false, phase: 'tracked' });
    expect(r.progress).toMatch(/time budget reached in the followed pipeline "Application Pipeline" after 100 opportunities — no freshness marker written/);
    expect(await marker('ghl.opportunities')).toEqual(before);
    const [row] = await db.select().from(syncRuns).where(eq(syncRuns.id, r.runId));
    expect(row.status).toBe('partial');
    expect((row.stats as Record<string, unknown>).reason).toMatch(/no freshness marker written/);
  });

  it("a walk that reads fewer opportunities than GHL's own meta.total FAILS (the marker would lie)", async () => {
    const before = await marker('ghl.opportunities');
    const real = fakeFetch.getMockImplementation()!;
    fakeFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/opportunities/search') {
        const res = await real(input, init);
        const body = await res.json();
        return json({ ...body, meta: { total: 999 } });
      }
      return real(input, init);
    });
    const r = await runGhlSync({ mode: 'delta', trigger: 'cron', mirrors: 'skip' });
    fakeFetch.mockImplementation(real);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/read 251 of 999 opportunities GHL reports/);
    expect(await marker('ghl.opportunities')).toEqual(before);
    expect((await db.select().from(syncIncidents)).some((i) => /read 251 of 999/.test(i.message))).toBe(true);
  });

  it('mirrors: the weekly pass uses its own cursor, only after ① completed, and only once a week', async () => {
    await clear('marker:ghl.mirrors');
    await clear('ghl_mirror_cursor');
    account.pipelines.push({ id: 'pipe-m1', name: 'Mirror One', stages: [{ id: 'st-m1', name: 'Old', position: 0 }] });
    account.opportunities.push({ id: 'opp-m1', name: 'M', pipelineId: 'pipe-m1', pipelineStageId: 'st-m1', status: 'open', contactId: 'ct-m1', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' });
    account.contacts['ct-m1'] = { id: 'ct-m1', firstName: 'M', dateAdded: '2025-01-01T00:00:00Z' };
    // Pages allowed = the followed walk (3) — nothing left for mirrors: ① complete, mirror pass waits.
    const tight = await runGhlSync({ mode: 'delta', trigger: 'cron', maxPages: 3 });
    expect(tight).toMatchObject({ ok: true, partial: false, trackedComplete: true, phase: 'mirrors' });
    // Two unfollowed pipelines by now: the retired "{ Off } Old Funnel" from an earlier test, and Mirror One.
    expect(tight.progress).toMatch(/mirrors: weekly pass paused at pipeline 1\/2 "\{ Off \} Old Funnel", page 1 — continues next run/);
    const next = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(next.phase).toBe('done');
    expect(next.progress).toMatch(/mirrors: weekly pass complete \(2 runs\)/);
    expect(await marker('ghl.mirrors')).toMatchObject({ fetched: 2 });
    expect(await db.select().from(ghlOpportunities).where(eq(ghlOpportunities.pipelineId, 'pipe-m1'))).toHaveLength(1);
    expect(await setting('ghl_mirror_cursor')).toBe('');
    const later = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(later.progress).toMatch(/mirrors: weekly pass not due/);
    account.pipelines.pop();
  });

  it('a GHL 429 is retried once after Retry-After', async () => {
    const real = fakeFetch.getMockImplementation()!;
    let limited = 0;
    fakeFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/users/' && limited === 0) {
        limited += 1;
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
      }
      return real(input, init);
    });
    const r = await runGhlSync({ mode: 'delta', trigger: 'cron', mirrors: 'skip' });
    fakeFetch.mockImplementation(real);
    expect(limited).toBe(1);
    expect(r.warnings.some((w) => /Users:/.test(w))).toBe(false);
  });
});

describe('one GHL run at a time (F5, 2026-09-30: atomic lease)', () => {
  it('a run that starts while another holds the lease skips without touching the cursor or recording a row', async () => {
    const other = await acquireLock(GHL_LOCK, 'someone-else', GHL_LOCK_TTL_MS);
    expect(other.ok).toBe(true);
    const cursorBefore = await readMirrorCursor();
    const runsBefore = (await db.select().from(syncRuns)).length;
    const r = await runGhlSync({ mode: 'delta', trigger: 'cron' });
    expect(r).toMatchObject({ ok: true, partial: false, trackedComplete: false, requestsUsed: 0 });
    expect(r.skipped).toMatch(/another GHL sync holds the lock until/);
    expect((await db.select().from(syncRuns)).length).toBe(runsBefore);
    expect(await readMirrorCursor()).toEqual(cursorBefore);
    await releaseLock(GHL_LOCK, 'someone-else');
  });

  it('an expired lease (crashed holder) is taken over, and the run releases its own lease', async () => {
    await acquireLock(GHL_LOCK, 'crashed', 1_000, new Date(Date.now() - 60_000));
    const next = await runGhlSync({ mode: 'delta', trigger: 'cron', maxPages: 1 });
    expect(next.skipped).toBeUndefined();
    expect(await db.select().from(syncLocks)).toHaveLength(0); // released
  });

  it('two runs started in the same instant: exactly one works, the other skips', async () => {
    const [a, b] = await Promise.all([runGhlSync({ mode: 'delta', trigger: 'cron', maxPages: 1 }), runGhlSync({ mode: 'delta', trigger: 'manual', maxPages: 1 })]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
  });
});
