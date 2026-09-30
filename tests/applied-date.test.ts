/**
 * F14 (2026-09-30, Mitchell's decision): "applied" = an application (opportunity) created in the followed pipeline,
 * dated by its createdAt; a returning contact who re-applies counts again. GHL counted 186 applications in August
 * while dating by contact creation gave 98. A missing application date is a data-health count, never the contact's
 * own creation date. An application first seen in another pipeline is dated by its entry into the followed one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages, contacts, ghlOpportunities, stageTransitions } from '@/db';
import { loadMetricsInput } from '@/lib/metrics/load';
import { computeFunnel } from '@/lib/metrics';

const prov = { source: 'ghl', origin: 'ghl', backfilled: false } as const;
const d = (iso: string) => new Date(iso);
const AUG = { start: '2026-08-01', end: '2026-08-31' };
const SEP = { start: '2026-09-01', end: '2026-09-30' };

beforeAll(async () => {
  await runMigrations();
  await db.insert(pipelines).values([{ id: 'pf', name: 'Applications', isTracked: true, ...prov }, { id: 'pold', name: 'Old', isTracked: false, ...prov }]);
  await db.insert(stages).values([
    { id: 's-app', pipelineId: 'pf', name: 'Applied', position: 0, semanticRole: 'applied', roleSource: 'auto', ...prov },
    { id: 's-old', pipelineId: 'pold', name: 'Old', position: 0, ...prov },
  ]);
  const contact = (id: string, opp: string | null, created: string, extra: Record<string, unknown> = {}) =>
    ({ ghlContactId: id, ghlOpportunityId: opp, pipelineId: 'pf', stageId: 's-app', firstName: id, lastName: '', ghlCreatedAt: d(created), ...prov, ...extra });
  await db.insert(contacts).values([
    contact('new-aug', 'o-new', '2026-08-10T18:00:00Z'),                         // new contact, applied Aug 10
    contact('returning', 'o-ret', '2025-03-01T18:00:00Z'),                        // contact from 2025, re-applied Aug 20
    contact('no-date', 'o-missing', '2026-08-15T18:00:00Z'),                      // opportunity row never stored
    contact('moved', 'o-moved', '2026-01-01T18:00:00Z'),                          // application moved in from "Old"
    contact('demo', null, '2026-08-05T18:00:00Z', { origin: 'demo' }),            // fabricated sample row
    // Audit P1 #2: a contact with no opportunity in ANY pipeline (created by the appointments sync) is not an applicant
    contact('walk-in', null, '2026-08-12T18:00:00Z', { pipelineId: null, stageId: null }),
  ]);
  await db.insert(ghlOpportunities).values([
    { id: 'o-new', ghlContactId: 'new-aug', pipelineId: 'pf', stageId: 's-app', status: 'open', ghlCreatedAt: d('2026-08-10T18:00:00Z'), ...prov },
    { id: 'o-ret', ghlContactId: 'returning', pipelineId: 'pf', stageId: 's-app', status: 'open', ghlCreatedAt: d('2026-08-20T18:00:00Z'), ...prov },
    { id: 'o-moved', ghlContactId: 'moved', pipelineId: 'pf', stageId: 's-app', status: 'open', ghlCreatedAt: d('2026-01-02T18:00:00Z'), ...prov },
  ]);
  const [moved] = await db.select().from(contacts).where((await import('drizzle-orm')).eq(contacts.ghlContactId, 'moved'));
  await db.insert(stageTransitions).values([
    { contactId: moved.id, ghlOpportunityId: 'o-moved', pipelineId: 'pold', toStageId: 's-old', observedAt: d('2026-02-01T18:00:00Z'), kind: 'initial', ...prov },
    { contactId: moved.id, ghlOpportunityId: 'o-moved', pipelineId: 'pf', fromStageId: 's-old', toStageId: 's-app', observedAt: d('2026-09-05T18:00:00Z'), kind: 'diff', ...prov },
  ]);
});

describe('applied = the application (opportunity created in the followed pipeline)', () => {
  it('dates by the opportunity, counts a returning contact who re-applied, never uses the contact date as a stand-in', async () => {
    const input = await loadMetricsInput({ start: '2026-01-01', end: '2026-09-30', timezone: 'America/Edmonton' });
    const on = Object.fromEntries(input.contacts.map((c) => [c.name, c.appliedOn]));
    expect(on['new-aug']).toBe('2026-08-10');
    expect(on['returning']).toBe('2026-08-20'); // contact created 2025 — the old rule never counted this application
    expect(on['no-date']).toBeNull(); // NOT 2026-08-15 (the contact date)
    expect(on['moved']).toBe('2026-09-05'); // entry into the followed pipeline, flagged
    expect(on['demo']).toBe('2026-08-05');
    expect(input.health).toMatchObject({ appliedFromMove: 1, applicantsWithoutDate: [{ name: 'no-date' }] });
    // P1 #2: the no-pipeline contact is outside the funnel scope and NOT in the banner (it is not a followed-pipeline contact)
    expect(input.contacts.some((c) => c.name === 'walk-in')).toBe(false);
    expect(input.health!.applicantsWithoutDate.map((a) => a.name)).toEqual(['no-date']);
    const aug = computeFunnel(input, AUG).stages.find((s) => s.key === 'applied')!.count;
    const sep = computeFunnel(input, SEP).stages.find((s) => s.key === 'applied')!.count;
    expect(aug).toBe(3); // new-aug, returning, demo — no-date is not guessed in
    expect(sep).toBe(1); // moved
  });
});
