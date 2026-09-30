/**
 * The Applied ledger job on PGlite (plan item 2): every class from the doc's shapes, the parity
 * guards with the engine (Σ verdict_current = membershipFor().applied; no-form rows =
 * computeAppliedCaveat().withoutFormRecord; X rows with a mirrored contact = otherPipelines),
 * idempotent re-runs, the skip reasons, sample rows excluded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, ghlOpportunities, stageTransitions, appliedLedger, syncRuns } from '@/db';
import { loadMetricsInput } from '@/lib/metrics/load';
import { computeAppliedCaveat, membershipFor } from '@/lib/metrics';
import { runAppliedLedger, readAppliedSummary, lastCompleteWeek, summarizeWeek, type LedgerRowInput } from '@/lib/reconcile/appliedLedger';
import { writeMarker } from '@/lib/sync/markers';
import { setSetting, SETTING_KEYS } from '@/lib/settings';

const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
const d = (iso: string) => new Date(iso);
const TZ = 'America/Edmonton';
const TODAY = '2026-09-29';
const WEEK = { start: '2026-09-20', end: '2026-09-26' };
const FORM = 'New Application 7.10';

beforeAll(async () => {
  await runMigrations();
  await setSetting(SETTING_KEYS.backfillFrom, '2026-09-01');
  await db.insert(pipelines).values([{ id: 'pf', name: '[new] Application Pipeline', isTracked: true, ...prov }, { id: 'pold', name: '{ Off } Sales Funnel', isTracked: false, ...prov }]);
  await db.insert(stages).values([
    { id: 's-app', pipelineId: 'pf', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
    { id: 's-enr', pipelineId: 'pf', name: 'Enrolled', position: 5, semanticRole: 'enrolled', roleSource: 'auto', ...prov },
    { id: 's-prev', pipelineId: 'pf', name: 'Previous Leads', position: 9, semanticRole: 'previous_lead', roleSource: 'auto', ...prov },
    { id: 's-old', pipelineId: 'pold', name: 'Applied - No Call', position: 0, ...prov },
  ]);
  const c = (id: string, opp: string | null, created: string, source: string, extra: Record<string, unknown> = {}) =>
    ({ ghlContactId: `g-${id}`, ghlOpportunityId: opp, pipelineId: 'pf', stageId: 's-app', firstName: id, lastName: '', ghlCreatedAt: d(created), attributionSource: source, ...prov, ...extra });
  await db.insert(contacts).values([
    c('a1', 'o-a1', '2026-09-21T18:00:00Z', FORM, { utmCampaign: '(Sept 7) Scaling' }), // new form applicant
    c('a1x', 'o-a1x', '2026-09-22T18:00:00Z', FORM), // contact date copied from the opportunity (to the second)
    c('a2', 'o-a2', '2025-03-01T18:00:00Z', FORM), // returning, entered at applied
    c('a3', 'o-a3', '2025-03-01T18:00:00Z', FORM, { stageId: 's-enr' }), // pre-existing form contact entered at enrolled
    c('cc', 'o-c', '2024-11-25T18:00:00Z', 'longevity & running', { stageId: 's-enr' }), // manual entry
    c('dd', 'o-d', '2025-07-03T18:00:00Z', 'Facebook'), // non-form at applied
    c('mm', 'o-m', '2026-05-01T18:00:00Z', 'Facebook'), // moved in this week
    c('pp', 'o-p', '2026-09-23T18:00:00Z', FORM, { stageId: 's-prev' }), // parked
    c('ss', 'o-s1', '2026-09-24T18:00:00Z', FORM), // holds o-s1; o-s2 is a second followed opportunity
    c('xx', null, '2026-09-20T18:00:00Z', 'Fit Physician Application (B)', { pipelineId: 'pold', stageId: 's-old' }), // X: only in the unfollowed pipeline
    c('xn', null, '2026-09-20T18:00:00Z', 'Facebook', { pipelineId: 'pold', stageId: 's-old' }), // XN
    c('demo', 'o-demo', '2026-09-22T18:00:00Z', 'Facebook', { origin: 'demo' }), // sample data — excluded
    c('norow', null, '2025-02-01T18:00:00Z', FORM, { opportunityCreatedAt: d('2026-09-25T18:00:00Z') }), // counted (pre-existing) contact without an opportunity row → U
  ]);
  const o = (id: string, contact: string, pipelineId: string, stageId: string, created: string) => ({ id, ghlContactId: `g-${contact}`, pipelineId, stageId, status: 'open', ghlCreatedAt: d(created), ...prov });
  await db.insert(ghlOpportunities).values([
    o('o-a1', 'a1', 'pf', 's-app', '2026-09-21T18:30:00Z'),
    o('o-a1x', 'a1x', 'pf', 's-app', '2026-09-22T18:00:00Z'),
    o('o-a2', 'a2', 'pf', 's-app', '2026-09-22T18:00:00Z'),
    o('o-a3', 'a3', 'pf', 's-enr', '2026-09-23T18:00:00Z'),
    o('o-c', 'cc', 'pf', 's-enr', '2026-09-23T18:00:00Z'),
    o('o-d', 'dd', 'pf', 's-app', '2026-09-24T18:00:00Z'),
    o('o-m', 'mm', 'pf', 's-app', '2026-09-10T18:00:00Z'),
    o('o-p', 'pp', 'pf', 's-prev', '2026-09-23T18:00:00Z'),
    o('o-s1', 'ss', 'pf', 's-app', '2026-09-24T18:30:00Z'),
    o('o-s2', 'ss', 'pf', 's-app', '2026-09-25T18:00:00Z'),
    o('o-x', 'xx', 'pold', 's-old', '2026-09-21T18:00:00Z'),
    o('o-xn', 'xn', 'pold', 's-old', '2026-09-21T18:00:00Z'),
    o('o-unres', 'nobody', 'pold', 's-old', '2026-09-22T18:00:00Z'), // contact not mirrored
    o('o-demo', 'demo', 'pf', 's-app', '2026-09-22T18:00:00Z'),
  ]);
  const idOf = async (ghl: string) => (await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.ghlContactId, ghl)))[0].id;
  const t = async (contact: string, opp: string, pipelineId: string, toStageId: string, at: string, kind = 'initial', fromStageId: string | null = null) => ({ contactId: await idOf(`g-${contact}`), ghlOpportunityId: opp, pipelineId, fromStageId, toStageId, observedAt: d(at), kind, ...prov });
  await db.insert(stageTransitions).values([
    await t('a1', 'o-a1', 'pf', 's-app', '2026-09-21T19:00:00Z'),
    await t('a1x', 'o-a1x', 'pf', 's-app', '2026-09-22T19:00:00Z'),
    await t('a2', 'o-a2', 'pf', 's-app', '2026-09-22T19:00:00Z'),
    await t('a3', 'o-a3', 'pf', 's-enr', '2026-09-23T19:00:00Z'),
    await t('cc', 'o-c', 'pf', 's-enr', '2026-09-23T19:00:00Z'),
    await t('dd', 'o-d', 'pf', 's-app', '2026-09-24T19:00:00Z'),
    await t('mm', 'o-m', 'pold', 's-old', '2026-09-11T19:00:00Z'),
    await t('mm', 'o-m', 'pf', 's-app', '2026-09-22T19:00:00Z', 'diff', 's-old'),
    await t('pp', 'o-p', 'pf', 's-prev', '2026-09-23T19:00:00Z'),
    await t('ss', 'o-s1', 'pf', 's-app', '2026-09-24T19:00:00Z'),
  ]);
});

describe('runAppliedLedger', () => {
  it('skips with a reason before the first complete read of the followed pipeline', async () => {
    expect(await runAppliedLedger({ trigger: 'cli', today: TODAY })).toMatchObject({ ok: true, skipped: expect.stringContaining('no ghl.opportunities marker') });
    await writeMarker({ family: 'ghl.opportunities', runId: null, fetched: 12 });
    await writeMarker({ family: 'ghl.mirrors', runId: null, fetched: 3, completedAt: '2026-09-28T09:00:00.000Z' });
  });

  it('classes every row as the doc would, copies the current verdict from the engine, and excludes sample rows', async () => {
    const r = await runAppliedLedger({ trigger: 'cli', today: TODAY });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/^since 2026-09-01 · 14 rows · A1 3 · A2 1 · U 1 · A3 1 · C 1 · D 1 · M 1 · P 1 · S 1 · X 1 · XN 1 · unresolved 1 · sample 1 · mirror as of 2026-09-28T09:00:00.000Z$/);
    const rows = await db.select().from(appliedLedger);
    const byKey = Object.fromEntries(rows.map((x) => [x.key, x]));
    expect(byKey['o-a1']).toMatchObject({ class: 'A1', verdictCurrent: true, verdictCandidate: true, appliedOn: '2026-09-21', ledgerOn: '2026-09-21', campaignKey: 'sept 7 scaling', contactCreatedEqualsOpportunity: false });
    expect(byKey['o-a1x']).toMatchObject({ class: 'A1', contactCreatedEqualsOpportunity: true });
    expect(byKey['o-a2']).toMatchObject({ class: 'A2', verdictCurrent: true, verdictCandidate: true });
    expect(byKey['o-a3']).toMatchObject({ class: 'A3', verdictCurrent: true, verdictCandidate: false });
    expect(byKey['o-c']).toMatchObject({ class: 'C', verdictCurrent: true, verdictCandidate: false, firstRole: 'enrolled' });
    expect(byKey['o-d']).toMatchObject({ class: 'D', verdictCurrent: true, verdictCandidate: false });
    expect(byKey['o-m']).toMatchObject({ class: 'M', verdictCurrent: true, appliedOn: '2026-09-22', movedInOn: '2026-09-22', ledgerOn: '2026-09-22' });
    expect(byKey['o-p']).toMatchObject({ class: 'P', verdictCurrent: false, parked: true });
    expect(byKey['o-s1']).toMatchObject({ class: 'A1', verdictCurrent: true, holdsPosition: true });
    expect(byKey['o-s2']).toMatchObject({ class: 'S', verdictCurrent: false, holdsPosition: false });
    expect(byKey['o-x']).toMatchObject({ class: 'X', verdictCurrent: false, verdictCandidate: true, pipelineFollowed: false, pipelineName: '{ Off } Sales Funnel' });
    expect(byKey['o-xn']).toMatchObject({ class: 'XN', verdictCurrent: false, verdictCandidate: false });
    expect(byKey['o-unres']).toMatchObject({ class: 'unresolved', verdictCurrent: null, verdictCandidate: null, name: 'Unknown (contact not mirrored)' });
    expect(byKey['o-demo']).toBeUndefined();
    const norow = rows.find((x) => x.key.startsWith('contact:'))!;
    expect(norow).toMatchObject({ class: 'U', verdictCurrent: true, opportunityId: null, appliedOn: '2026-09-25' });
    expect(r.summary).toMatchObject({ sampleExcluded: 1, unresolved: 1, mirrorAsOf: '2026-09-28T09:00:00.000Z', followedPipelines: ['[new] Application Pipeline'] });
    // No email or phone in the ledger's text columns.
    expect(JSON.stringify(rows)).not.toMatch(/@/);
  });

  it('parity with the engine on the same rows: current count, no-form-record rows, other-pipeline applicants', async () => {
    const input = await loadMetricsInput({ start: '2026-09-01', end: TODAY, timezone: TZ });
    const rows = await db.select().from(appliedLedger);
    const inWeek = rows.filter((x) => x.ledgerOn >= WEEK.start && x.ledgerOn <= WEEK.end);
    const real = input.contacts.filter((c) => c.origin !== 'demo');
    const engineApplied = membershipFor({ ...input, contacts: real }, WEEK, 'period').applied.length;
    expect(inWeek.filter((x) => x.verdictCurrent).length).toBe(engineApplied);
    const caveat = computeAppliedCaveat({ ...input, contacts: real }, WEEK);
    expect(inWeek.filter((x) => ['A3', 'C', 'D', 'M'].includes(x.class)).length).toBe(caveat.withoutFormRecord.length);
    expect(inWeek.filter((x) => x.class === 'X' && x.contactId).length).toBe(caveat.otherPipelines.length);
    const week = summarizeWeek(rows as unknown as LedgerRowInput[], { ...WEEK, label: 'w' });
    expect(week.current).toBe(engineApplied);
    expect(week.candidate).toBe(6); // A1 ×3 (a1, a1x, ss) + A2 + U + X — once per person per day
    expect(week.byClass.A1).toEqual({ count: 3, unverified: 1 });
    expect(lastCompleteWeek(TODAY)).toEqual({ start: '2026-09-20', end: '2026-09-26', label: '2026-09-20 – 2026-09-26' });
  });

  it('is once per day (skipped with the time), forced re-runs change only computed_at, and a dropped opportunity leaves the ledger', async () => {
    const before = await db.select().from(appliedLedger);
    expect(await runAppliedLedger({ trigger: 'cli', today: TODAY })).toMatchObject({ skipped: expect.stringMatching(/^already ran today at \d{2}:\d{2}$/) });
    await db.delete(ghlOpportunities).where(eq(ghlOpportunities.id, 'o-xn'));
    const again = await runAppliedLedger({ trigger: 'cli', today: TODAY, force: true });
    expect(again.ok).toBe(true);
    const after = await db.select().from(appliedLedger);
    expect(after.find((x) => x.key === 'o-xn')).toBeUndefined();
    for (const b of before) {
      if (b.key === 'o-xn') continue;
      const a = after.find((x) => x.key === b.key)!;
      const { computedAt: _c1, ...restB } = b;
      const { computedAt: _c2, ...restA } = a;
      expect(restA).toEqual(restB);
    }
    expect((await readAppliedSummary())?.rows).toBe(13);
    const runs = await db.select().from(syncRuns).where(eq(syncRuns.kind, 'applied_ledger'));
    expect(runs.every((x) => x.status === 'succeeded')).toBe(true);
  });
});
