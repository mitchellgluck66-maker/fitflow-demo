/**
 * GET/POST /api/reconciliation (plan item 4) on PGlite: the not-run state, Reconcile now, the week's
 * classes under both definitions with the candidate labelled "not in use", people one click away
 * (names only), week stepping; and the Setup page mounts the card.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, ghlOpportunities, stageTransitions } from '@/db';
import { GET, POST } from '@/app/api/reconciliation/route';
import { writeMarker } from '@/lib/sync/markers';
import { setSetting, SETTING_KEYS } from '@/lib/settings';

const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
const d = (iso: string) => new Date(iso);
const get = (q = '') => GET(new NextRequest(`http://localhost/api/reconciliation${q}`));

beforeAll(async () => {
  await runMigrations();
  await setSetting(SETTING_KEYS.backfillFrom, '2026-09-01');
  await db.insert(pipelines).values([{ id: 'pf', name: 'Application', isTracked: true, ...prov }, { id: 'pold', name: '{ Off } Sales Funnel', isTracked: false, ...prov }]);
  await db.insert(stages).values([
    { id: 's-app', pipelineId: 'pf', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
    { id: 's-enr', pipelineId: 'pf', name: 'Enrolled', position: 5, semanticRole: 'enrolled', roleSource: 'auto', ...prov },
    { id: 's-old', pipelineId: 'pold', name: 'Old', position: 0, ...prov },
  ]);
  await db.insert(contacts).values([
    { ghlContactId: 'g-a', ghlOpportunityId: 'o-a', pipelineId: 'pf', stageId: 's-app', firstName: 'Diana', lastName: 'Diaz', email: 'diana@example.com', phone: '+14035550100', ghlCreatedAt: d('2026-09-21T18:00:00Z'), attributionSource: 'New Application 7.10', ...prov },
    { ghlContactId: 'g-c', ghlOpportunityId: 'o-c', pipelineId: 'pf', stageId: 's-enr', firstName: 'Jen', lastName: 'Clow', ghlCreatedAt: d('2024-11-25T18:00:00Z'), attributionSource: 'Back To School', ...prov },
    { ghlContactId: 'g-x', ghlOpportunityId: null, pipelineId: 'pold', stageId: 's-old', firstName: 'Erin', lastName: 'FitzPatrick', ghlCreatedAt: d('2026-09-20T18:00:00Z'), attributionSource: 'Fit Physician Application (B)', ...prov },
  ]);
  await db.insert(ghlOpportunities).values([
    { id: 'o-a', ghlContactId: 'g-a', pipelineId: 'pf', stageId: 's-app', status: 'open', ghlCreatedAt: d('2026-09-21T18:30:00Z'), ...prov },
    { id: 'o-c', ghlContactId: 'g-c', pipelineId: 'pf', stageId: 's-enr', status: 'won', ghlCreatedAt: d('2026-09-23T18:00:00Z'), ...prov },
    { id: 'o-x', ghlContactId: 'g-x', pipelineId: 'pold', stageId: 's-old', status: 'open', ghlCreatedAt: d('2026-09-20T18:00:00Z'), ...prov },
  ]);
  const ids = await db.select({ id: contacts.id, ghl: contacts.ghlContactId }).from(contacts);
  const idOf = (g: string) => ids.find((x) => x.ghl === g)!.id;
  await db.insert(stageTransitions).values([
    { contactId: idOf('g-a'), ghlOpportunityId: 'o-a', pipelineId: 'pf', toStageId: 's-app', observedAt: d('2026-09-21T19:00:00Z'), kind: 'initial', ...prov },
    { contactId: idOf('g-c'), ghlOpportunityId: 'o-c', pipelineId: 'pf', toStageId: 's-enr', observedAt: d('2026-09-23T19:00:00Z'), kind: 'initial', ...prov },
  ]);
});

describe('/api/reconciliation', () => {
  it('before any run: not reconciled, the note, empty classes', async () => {
    const body = await (await get('?week=2026-09-20')).json();
    expect(body.summary).toBeNull();
    expect(body.ledger).toMatchObject({ stale: true, current: 0, candidate: 0, candidateLabel: 'candidate — deferred #1, not in use', note: expect.stringContaining('docs/deferred.md #1') });
  });

  it('Reconcile now (POST) waits for the followed-pipeline marker, then builds the ledger; the ratio says Meta is not connected', async () => {
    let res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).ledger.skipped).toContain('no ghl.opportunities marker');
    await writeMarker({ family: 'ghl.opportunities', runId: null, fetched: 3 });
    res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ledger.ok).toBe(true);
    expect(body.ratio).toMatchObject({ notConfigured: true });
  });

  it('the week: classes under both definitions, people with names and links only, other pipelines named', async () => {
    const body = await (await get('?week=2026-09-22')).json(); // any day inside the week normalises to its Sunday
    expect(body.ledger.week).toMatchObject({ start: '2026-09-20', end: '2026-09-26', label: '2026-09-20 – 2026-09-26' });
    expect(body.ledger).toMatchObject({ current: 2, candidate: 2, otherPipelines: 1, unresolved: 0, stale: false });
    expect(body.ledger.byClass.A1).toMatchObject({ count: 1, currentCount: 1, candidateCount: 1, candidateWouldCount: true });
    expect(body.ledger.byClass.C).toMatchObject({ count: 1, currentCount: 1, candidateCount: 0, candidateWouldCount: false, label: 'Manual entry into a later stage (non-form contact)' });
    expect(body.ledger.byClass.X).toMatchObject({ count: 1, currentCount: 0, candidateCount: 1 });
    expect(body.ledger.byClass.A1.people[0]).toMatchObject({ name: 'Diana Diaz', on: '2026-09-21', link: expect.stringMatching(/^\/clients\//), reason: 'new contact created by the application form' });
    expect(body.ledger.byClass.X.people[0]).toMatchObject({ name: 'Erin FitzPatrick', pipeline: '{ Off } Sales Funnel', alsoInFollowed: false });
    const text = JSON.stringify(body);
    expect(text).not.toContain('diana@example.com');
    expect(text).not.toContain('4035550100');
    expect(body.ratio).toBeNull();
  });

  it('steps by week and never past the last complete week', async () => {
    const prev = await (await get('?week=2026-09-13')).json();
    expect(prev.ledger.week.start).toBe('2026-09-13');
    expect(prev.ledger.canStepForward).toBe(true);
    expect(prev.ledger.current).toBe(0);
    const last = await (await get()).json();
    expect(last.ledger.week.isLastComplete).toBe(true);
    expect(last.ledger.canStepForward).toBe(false);
  });

  it('the Setup page mounts the card', () => {
    expect(fs.readFileSync('app/setup/page.tsx', 'utf8')).toContain('<ReconciliationCard />');
    const card = fs.readFileSync('components/setup/ReconciliationCard.tsx', 'utf8');
    expect(card).toContain('Candidate (deferred #1, not in use)');
    expect(card).toContain('Meta days are');
  });
});
