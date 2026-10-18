/**
 * Companion stage 2, item 3 — the outcome map: every default row (both call types), the reschedule rule both ways,
 * Move to, overrides applied / rejected / ignored-with-a-warning, stage resolution by role (missing role refused,
 * lowest position wins), and the catalogue against PGlite (followed pipeline, Setup's PATCH validation).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '@/db/migrate';
import { db, pipelines, stages } from '@/db';
import { getSetting, setSetting } from '@/lib/settings';
import {
  DEFAULT_OUTCOMES,
  MOVE_TO_KEY,
  applyOverrides,
  outcomesFor,
  parseOverrides,
  validateOverrides,
  resolveStage,
  resolveOutcome,
  resolveMoveTo,
  appointmentEffect,
  type StageRef,
} from '@/lib/companion/outcomes';
import { getOutcomesForCall, readFollowedPipeline, readOutcomeCatalogue } from '@/lib/companion/outcomeService';
import { getCompanionAdminState, patchCompanionSettings } from '@/lib/companion/admin';
import { COMPANION_SETTING_KEYS } from '@/lib/companion/config';

const STAGES: StageRef[] = [
  { id: 's_applied', name: 'Applied', role: 'applied', position: 0 },
  { id: 's_cbooked', name: 'Consult Booked', role: 'consult_booked', position: 1 },
  { id: 's_cnoshow', name: 'Consult No Show', role: 'consult_noshow', position: 2 },
  { id: 's_cresched', name: 'Consult Reschedule', role: 'consult_rescheduled', position: 3 },
  { id: 's_rbooked', name: 'Pre-Roadmap Booked', role: 'roadmap_booked', position: 4 },
  { id: 's_rnoshow', name: 'Roadmap No Show', role: 'roadmap_noshow', position: 5 },
  { id: 's_rresched', name: 'Roadmap Reschedule', role: 'roadmap_rescheduled', position: 6 },
  { id: 's_robj', name: 'Roadmap Completed: Objection', role: 'roadmap_showed', position: 7 },
  { id: 's_enrolled', name: 'Enrolled', role: 'enrolled', position: 8 },
  { id: 's_other', name: 'Alumni', role: 'other', position: 9 },
];
const ctx = (reschedule: 'cancelled' | 'leave' = 'cancelled', s = STAGES) => ({ pipelineName: '[new] Application Pipeline', stages: s, reschedule });

const byKey = (key: string) => DEFAULT_OUTCOMES.find((o) => o.key === key)!;
const resolved = (key: string, reschedule: 'cancelled' | 'leave' = 'cancelled') => {
  const r = resolveOutcome(byKey(key), ctx(reschedule));
  if (!r.ok) throw new Error(r.reason);
  return { stage: r.outcome.toStage?.name ?? null, appointment: r.outcome.appointment, status: r.outcome.opportunityStatus };
};

describe('the default map (pure)', () => {
  it('Consult outcomes', () => {
    expect(resolved('consult_showed_booked')).toEqual({ stage: 'Pre-Roadmap Booked', appointment: 'showed', status: 'open' });
    expect(resolved('consult_noshow')).toEqual({ stage: 'Consult No Show', appointment: 'noshow', status: 'open' });
    expect(resolved('consult_reschedule')).toEqual({ stage: 'Consult Reschedule', appointment: 'cancelled', status: 'open' });
    expect(resolved('consult_reschedule', 'leave')).toEqual({ stage: 'Consult Reschedule', appointment: 'leave', status: 'open' });
    expect(resolved('consult_cancelled')).toEqual({ stage: null, appointment: 'cancelled', status: 'open' });
    expect(resolved('consult_not_fit')).toEqual({ stage: null, appointment: 'showed', status: 'lost' });
  });
  it('Roadmap outcomes', () => {
    expect(resolved('roadmap_enrolled')).toEqual({ stage: 'Enrolled', appointment: 'showed', status: 'won' });
    expect(resolved('roadmap_showed_objection')).toEqual({ stage: 'Roadmap Completed: Objection', appointment: 'showed', status: 'open' });
    expect(resolved('roadmap_noshow')).toEqual({ stage: 'Roadmap No Show', appointment: 'noshow', status: 'open' });
    expect(resolved('roadmap_reschedule')).toEqual({ stage: 'Roadmap Reschedule', appointment: 'cancelled', status: 'open' });
    expect(resolved('roadmap_reschedule', 'leave')).toEqual({ stage: 'Roadmap Reschedule', appointment: 'leave', status: 'open' });
    expect(resolved('roadmap_not_fit')).toEqual({ stage: null, appointment: 'showed', status: 'lost' });
  });
  it('the list per call type; Other calls get Move to only', () => {
    expect(outcomesFor('Consult', DEFAULT_OUTCOMES).map((o) => o.label)).toEqual(['Showed, roadmap booked', 'No-show', 'Reschedule', 'Cancelled', 'Not a fit']);
    expect(outcomesFor('Roadmap', DEFAULT_OUTCOMES).map((o) => o.label)).toEqual(['Enrolled', 'Showed, objection', 'No-show', 'Reschedule', 'Not a fit']);
    expect(outcomesFor('Other', DEFAULT_OUTCOMES)).toEqual([]);
    expect(appointmentEffect('reschedule_setting', 'leave')).toBe('leave');
    expect(appointmentEffect('noshow', 'leave')).toBe('noshow');
  });
  it('Move to: any stage of the followed pipeline + an appointment effect; the opportunity status is kept', () => {
    const r = resolveMoveTo({ stageId: 's_other', appointment: 'leave' }, ctx());
    expect(r.ok && r.outcome).toMatchObject({ key: MOVE_TO_KEY, label: 'Move to Alumni', toStage: { id: 's_other' }, appointment: 'leave', opportunityStatus: null });
    expect(resolveMoveTo({ stageId: 'nope', appointment: 'showed' }, ctx())).toEqual({ ok: false, reason: 'Stage nope is not in [new] Application Pipeline.' });
    expect(resolveMoveTo({ stageId: 's_other', appointment: 'confirmed' as never }, ctx()).ok).toBe(false);
  });
});

describe('stage resolution by role (pure)', () => {
  it('a role with no stage is refused with the Setup sentence — never a name match', () => {
    const without = STAGES.filter((s) => s.role !== 'roadmap_booked').map((s) => (s.id === 's_other' ? { ...s, name: 'Pre-Roadmap Booked' } : s));
    const r = resolveOutcome(byKey('consult_showed_booked'), ctx('cancelled', without));
    expect(r).toEqual({ ok: false, reason: 'No stage in [new] Application Pipeline is mapped to the role roadmap_booked — map it in Setup → Pipelines.' });
    expect(resolveStage('roadmap_booked', without)).toBeNull();
  });
  it('several stages with one role → the lowest position', () => {
    const twice = [...STAGES, { id: 's_enrolled2', name: 'Enrolled (legacy)', role: 'enrolled' as const, position: 2 }];
    expect(resolveStage('enrolled', twice)?.id).toBe('s_enrolled2');
    expect(resolveStage('enrolled', twice.map((s) => ({ ...s, position: null })))?.name).toBe('Enrolled');
  });
});

describe('overrides (pure)', () => {
  it('apply, validate strictly, store only what differs from the default', () => {
    const v = validateOverrides({ consult_not_fit: { stageRole: 'previous_lead', appointment: 'showed', opportunityStatus: 'lost' }, consult_noshow: { stageRole: 'consult_noshow', appointment: 'noshow', opportunityStatus: 'open' } });
    expect(v).toEqual({ ok: true, overrides: { consult_not_fit: { stageRole: 'previous_lead', appointment: 'showed', opportunityStatus: 'lost' } } });
    const defs = applyOverrides(v.ok ? v.overrides : {});
    expect(defs.find((d) => d.key === 'consult_not_fit')!.stageRole).toBe('previous_lead');
    expect(defs.find((d) => d.key === 'consult_noshow')).toEqual(byKey('consult_noshow'));
  });
  it.each([
    [{ nope: { stageRole: null, appointment: 'showed', opportunityStatus: null } }, '"nope" is not an outcome'],
    [{ consult_noshow: { stageRole: 'other', appointment: 'showed', opportunityStatus: null } }, '"consult_noshow": stageRole must be a stage role or null'],
    [{ consult_noshow: { stageRole: null, appointment: 'no-show', opportunityStatus: null } }, '"consult_noshow": appointment must be one of showed, noshow, cancelled, leave, reschedule_setting'],
    [{ consult_noshow: { stageRole: null, appointment: 'showed', opportunityStatus: 'abandoned' } }, '"consult_noshow": opportunityStatus must be open, won, lost or null'],
    [[], 'outcomeMap must be an object keyed by outcome.'],
  ])('rejects %j', (input, error) => {
    expect(validateOverrides(input)).toEqual({ ok: false, error });
  });
  it('a stored map with one bad entry keeps the good ones and names the bad', () => {
    const r = parseOverrides(JSON.stringify({ roadmap_not_fit: { stageRole: 'previous_lead', appointment: 'showed', opportunityStatus: 'lost' }, consult_noshow: { stageRole: 'bogus', appointment: 'showed', opportunityStatus: null } }));
    expect(Object.keys(r.overrides)).toEqual(['roadmap_not_fit']);
    expect(r.warnings).toEqual(['Ignored outcome override "consult_noshow": stageRole must be a stage role or null — the default is in use.']);
    expect(parseOverrides('{not json')).toEqual({ overrides: {}, warnings: ['The stored outcome map is not valid JSON — defaults are in use.'] });
    expect(parseOverrides(null)).toEqual({ overrides: {}, warnings: [] });
  });
});

describe('the catalogue against the database', () => {
  beforeAll(async () => {
    await runMigrations();
    await db.insert(pipelines).values([
      { id: 'UR5P3vNTm9VPuYZFrb6c', name: '[new] Application Pipeline', isTracked: true, source: 'ghl', origin: 'ghl' },
      { id: 'p_other', name: 'Alumni', isTracked: false, source: 'ghl', origin: 'ghl' },
    ]).onConflictDoNothing();
    await db.insert(stages).values(STAGES.map((s) => ({ id: s.id, pipelineId: 'UR5P3vNTm9VPuYZFrb6c', name: s.name, position: s.position, semanticRole: s.role, roleSource: 'manual', source: 'ghl', origin: 'ghl' }))).onConflictDoNothing();
    await db.insert(stages).values({ id: 's_arch', pipelineId: 'UR5P3vNTm9VPuYZFrb6c', name: 'Old Enrolled', position: 1, semanticRole: 'enrolled', roleSource: 'manual', archivedAt: new Date(), source: 'ghl', origin: 'ghl' }).onConflictDoNothing();
  });

  it('reads the followed pipeline without archived stages; resolves every default; Other → Move to only', async () => {
    const p = await readFollowedPipeline();
    expect(p?.name).toBe('[new] Application Pipeline');
    expect(p?.stages.map((s) => s.id)).not.toContain('s_arch');
    const consult = await getOutcomesForCall('Consult');
    expect(consult.dryRun.on).toBe(true);
    expect(consult.outcomes.map((o) => [o.label, o.toStage?.name ?? null, o.appointment, o.unavailable])).toEqual([
      ['Showed, roadmap booked', 'Pre-Roadmap Booked', 'showed', null],
      ['No-show', 'Consult No Show', 'noshow', null],
      ['Reschedule', 'Consult Reschedule', 'cancelled', null],
      ['Cancelled', null, 'cancelled', null],
      ['Not a fit', null, 'showed', null],
    ]);
    expect(consult.moveTo.stages.map((s) => s.name)).toContain('Alumni');
    const other = await getOutcomesForCall('Other');
    expect(other.outcomes).toEqual([]);
    expect(other.moveTo.pipeline?.id).toBe('UR5P3vNTm9VPuYZFrb6c');
  });

  it('Setup PATCH: dry run off needs confirm; the reschedule rule and the map round-trip; an unmapped role shows in the table', async () => {
    expect(await patchCompanionSettings({ dryRun: false })).toEqual({ ok: false, status: 400, error: 'Confirm turning dry run off: outcomes will be sent to GoHighLevel.' });
    expect(await patchCompanionSettings({ dryRun: false, confirm: true })).toEqual({ ok: true, changed: ['dryRun'] });
    expect(await getSetting(COMPANION_SETTING_KEYS.dryRun)).toBe('false');
    expect(await patchCompanionSettings({ dryRun: true })).toEqual({ ok: true, changed: ['dryRun'] });
    expect(await patchCompanionSettings({ rescheduleAppointment: 'maybe' })).toMatchObject({ ok: false });
    expect(await patchCompanionSettings({ rescheduleAppointment: 'leave', outcomeMap: { consult_not_fit: { stageRole: 'previous_lead', appointment: 'showed', opportunityStatus: 'lost' } } })).toEqual({ ok: true, changed: ['rescheduleAppointment', 'outcomeMap'] });
    const cat = await readOutcomeCatalogue();
    expect(cat.reschedule).toBe('leave');
    expect(Object.keys(cat.overrides)).toEqual(['consult_not_fit']);
    const consult = await getOutcomesForCall('Consult');
    expect(consult.outcomes.find((o) => o.key === 'consult_reschedule')?.appointment).toBe('leave');
    expect(consult.outcomes.find((o) => o.key === 'consult_not_fit')?.unavailable).toBe('No stage in [new] Application Pipeline is mapped to the role previous_lead — map it in Setup → Pipelines.');
    const state = await getCompanionAdminState();
    expect(state.outcomeMap.overridden).toEqual(['consult_not_fit']);
    expect(state.outcomeMap.outcomes.find((o) => o.key === 'consult_not_fit')?.resolvedStage).toBeNull();
    expect(state.outcomeMap.outcomes.find((o) => o.key === 'roadmap_enrolled')?.resolvedStage?.name).toBe('Enrolled');
    expect(state.outcomeMap.pipeline).toEqual({ id: 'UR5P3vNTm9VPuYZFrb6c', name: '[new] Application Pipeline', stageCount: 10 });
    expect(await patchCompanionSettings({ outcomeMap: {} })).toEqual({ ok: true, changed: ['outcomeMap'] });
    await setSetting(COMPANION_SETTING_KEYS.outcomeMap, '{"consult_noshow":{"stageRole":"bogus","appointment":"showed","opportunityStatus":null}}');
    expect((await getCompanionAdminState()).outcomeMap.warnings).toHaveLength(1);
  });
});
