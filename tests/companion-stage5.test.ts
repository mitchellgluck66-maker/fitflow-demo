/**
 * Companion stage 5 — stop side-effect emails to clients (docs/plan-companion-stage5.md).
 *   item 1: the Reschedule default is 'leave'; migration 0024 writes the row only when none exists and keeps an
 *           owner's 'cancelled'.
 *   item 2: the pure write decisions from the LIVE state (`lib/companion/decide.ts`) — the integration (Bridget's
 *           exact case through the 409 path) is in tests/companion-log.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, settings } from '@/db';
import { getSetting } from '@/lib/settings';
import { COMPANION_SETTING_KEYS, appointmentUpdatesOf, readAppointmentUpdates, readRescheduleAppointment } from '@/lib/companion/config';
import { APPOINTMENT_UPDATES_OFF_REASON } from '@/lib/companion/logText';
import { planEffectLine } from '@/lib/companion/popoutState';
import { auditFlags } from '../scripts/companion-audit';
import { isNoopRequest, isTestContactName, messagesInWindow, summarizeMessage } from '../scripts/companion-parity';
import { decideAppointment, decideStage } from '@/lib/companion/decide';
import { isNoopOpportunityPatch, minimalOpportunityPatch } from '@/lib/companion/patch';
import { MOVE_TO_KEY, type ResolvedOutcome, type StageRef } from '@/lib/companion/outcomes';

const STAGES: StageRef[] = [
  { id: 's_applied', name: 'Applied', role: 'applied', position: 0 },
  { id: 's_cbooked', name: 'Consult Booked', role: 'consult_booked', position: 2 },
  { id: 's_rbooked', name: 'Pre-Roadmap Booked', role: 'roadmap_booked', position: 6 },
  { id: 's_enrolled', name: 'Enrolled', role: 'enrolled', position: 10 },
  { id: 's_nopos', name: 'Parked', role: null, position: null },
];
const PIPE = { id: 'p1', name: '[new] Application Pipeline' };
const by = (id: string) => STAGES.find((s) => s.id === id)!;
const outcome = (o: Partial<ResolvedOutcome>): ResolvedOutcome => ({ key: 'consult_showed_booked', label: 'Showed, roadmap booked', toStage: by('s_rbooked'), stageRole: 'roadmap_booked', appointment: 'showed', opportunityStatus: 'open', ...o });

const KEY = COMPANION_SETTING_KEYS.rescheduleAppointment;

async function replay0024() {
  const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '0024_companion_reschedule_leave.sql'), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await db.execute(stmt);
}

beforeAll(async () => {
  await runMigrations();
});

describe('item 2 — decisions from the live state (pure)', () => {
  it('decideStage: a real move sends; the same stage AND status skips "already in"; a status-only change sends only the status', () => {
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_cbooked', status: 'open' }, pipeline: PIPE, resolved: outcome({}), stages: STAGES })).toEqual({ send: true, body: { pipelineStageId: 's_rbooked' }, stageChange: true, statusChange: false, backward: false, summary: 'Stage Consult Booked → Pre-Roadmap Booked' });
    // Bridget: the live stage is already the target → nothing to send, whatever the mirror believed.
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_rbooked', status: 'open' }, pipeline: PIPE, resolved: outcome({}), stages: STAGES })).toEqual({ send: false, reason: 'already in Pre-Roadmap Booked', backward: false, summary: 'Stage — Pre-Roadmap Booked' });
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_cbooked', status: 'open' }, pipeline: PIPE, resolved: outcome({ key: 'consult_not_fit', toStage: null, stageRole: null, opportunityStatus: 'lost' }), stages: STAGES })).toMatchObject({ send: true, body: { status: 'lost' }, stageChange: false, statusChange: true, summary: 'Opportunity open → lost' });
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_cbooked', status: 'lost' }, pipeline: PIPE, resolved: outcome({ toStage: null, stageRole: null, opportunityStatus: 'lost' }), stages: STAGES })).toMatchObject({ send: false, reason: 'already lost' });
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_cbooked', status: 'open' }, pipeline: PIPE, resolved: outcome({ toStage: null, stageRole: null, opportunityStatus: 'open' }), stages: STAGES })).toMatchObject({ send: false, reason: 'stage unchanged' });
    expect(decideStage({ live: null, pipeline: PIPE, resolved: outcome({}), stages: STAGES })).toEqual({ send: false, reason: 'no opportunity in [new] Application Pipeline', backward: false, summary: 'Stage — skipped' });
    expect(decideStage({ live: null, pipeline: null, resolved: outcome({}), stages: STAGES })).toMatchObject({ send: false, reason: 'no followed pipeline' });
  });

  it('decideStage: a mapped outcome never moves backward; Move to… may, and is marked; unknown positions are not judged', () => {
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_enrolled', status: 'won' }, pipeline: PIPE, resolved: outcome({}), stages: STAGES })).toEqual({ send: false, reason: 'already past Pre-Roadmap Booked (in Enrolled)', backward: false, summary: 'Stage — Enrolled' });
    // Enrolled → Enrolled + won with the deal already won: nothing to send either.
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_enrolled', status: 'won' }, pipeline: PIPE, resolved: outcome({ key: 'roadmap_enrolled', toStage: by('s_enrolled'), stageRole: 'enrolled', opportunityStatus: 'won' }), stages: STAGES })).toMatchObject({ send: false, reason: 'already in Enrolled' });
    const back = decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_enrolled', status: 'won' }, pipeline: PIPE, resolved: outcome({ key: MOVE_TO_KEY, label: 'Move to Consult Booked', toStage: by('s_cbooked'), stageRole: 'consult_booked', opportunityStatus: null }), stages: STAGES });
    expect(back).toMatchObject({ send: true, body: { pipelineStageId: 's_cbooked' }, backward: true });
    // A live stage with no known position (or outside the map) cannot be "past" anything: the move is sent.
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 's_nopos', status: 'open' }, pipeline: PIPE, resolved: outcome({}), stages: STAGES })).toMatchObject({ send: true, backward: false, summary: 'Stage Parked → Pre-Roadmap Booked' });
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p1', stageId: 'gone', status: 'open' }, pipeline: PIPE, resolved: outcome({}), stages: STAGES })).toMatchObject({ send: true, summary: 'Stage no stage → Pre-Roadmap Booked' });
  });

  it('item 6 — the body is minimal, like a manual drag: pipelineId only when the pipeline differs; nothing equal to the live state is sent', () => {
    expect(minimalOpportunityPatch({ pipelineId: 'p1', pipelineStageId: 's_rbooked', status: 'open' }, { pipelineId: 'p1', stageId: 's_cbooked', status: 'open' })).toEqual({ pipelineStageId: 's_rbooked' });
    expect(minimalOpportunityPatch({ pipelineId: 'p1', pipelineStageId: 's_rbooked', status: 'open' }, { pipelineId: 'p1', stageId: 's_rbooked', status: 'open' })).toEqual({}); // Bridget's shape → empty → never sent
    expect(isNoopOpportunityPatch({ pipelineId: 'p1', pipelineStageId: 's_rbooked' }, { pipelineId: 'p1', stageId: 's_rbooked', status: 'open' })).toBe(true);
    expect(minimalOpportunityPatch({ pipelineId: 'p1', status: 'lost' }, { pipelineId: 'p1', stageId: 's_cbooked', status: 'open' })).toEqual({ status: 'lost' });
    expect(minimalOpportunityPatch({ pipelineId: 'p1', pipelineStageId: 's_enrolled', status: 'won' }, { pipelineId: 'p1', stageId: 's_rbooked', status: 'open' })).toEqual({ pipelineStageId: 's_enrolled', status: 'won' });
    // The opportunity sits in another pipeline → pipelineId travels with the stage; a pipeline id alone is nothing.
    expect(minimalOpportunityPatch({ pipelineId: 'p1', pipelineStageId: 's_rbooked' }, { pipelineId: 'p_other', stageId: 's_x', status: 'open' })).toEqual({ pipelineId: 'p1', pipelineStageId: 's_rbooked' });
    expect(minimalOpportunityPatch({ pipelineId: 'p1' }, { pipelineId: 'p_other', stageId: 's_x', status: 'open' })).toEqual({});
    // An unknown live pipeline keeps the id as given (never guessed).
    expect(minimalOpportunityPatch({ pipelineId: 'p1', pipelineStageId: 's_rbooked' }, { pipelineId: null, stageId: 's_cbooked', status: 'open' })).toEqual({ pipelineId: 'p1', pipelineStageId: 's_rbooked' });
    // decideStage builds that body: the followed pipeline is the live one → no pipelineId.
    expect(decideStage({ live: { id: 'o1', pipelineId: 'p_other', stageId: 's_cbooked', status: 'open' }, pipeline: PIPE, resolved: outcome({}), stages: STAGES })).toMatchObject({ send: true, body: { pipelineId: 'p1', pipelineStageId: 's_rbooked' } });
  });

  it('decideAppointment: sends only when the live status differs; leave / no call / already-there skip with the reason', () => {
    expect(decideAppointment({ call: { liveStatus: 'confirmed' }, effect: 'showed', enabled: true })).toEqual({ send: true, status: 'showed', summary: 'Appointment confirmed → showed' });
    expect(decideAppointment({ call: { liveStatus: 'showed' }, effect: 'showed', enabled: true })).toEqual({ send: false, reason: 'already showed', summary: 'Appointment — already showed' });
    expect(decideAppointment({ call: { liveStatus: 'cancelled' }, effect: 'cancelled', enabled: true })).toMatchObject({ send: false, reason: 'already cancelled' });
    expect(decideAppointment({ call: { liveStatus: 'confirmed' }, effect: 'leave', enabled: true })).toEqual({ send: false, reason: 'left as is', summary: 'Appointment — left confirmed' });
    expect(decideAppointment({ call: null, effect: 'showed', enabled: true })).toEqual({ send: false, reason: 'no appointment', summary: 'Appointment — none' });
  });

  it('item 5 — the Setup switch: off (the default) skips the appointment step for every effect with the reason; only the literal true turns it on', () => {
    expect(appointmentUpdatesOf(null)).toBe(false);
    expect(appointmentUpdatesOf('')).toBe(false);
    expect(appointmentUpdatesOf('yes')).toBe(false);
    expect(appointmentUpdatesOf('false')).toBe(false);
    expect(appointmentUpdatesOf('true')).toBe(true);
    for (const effect of ['showed', 'noshow', 'cancelled', 'leave'] as const) {
      expect(decideAppointment({ call: { liveStatus: 'confirmed' }, effect, enabled: false })).toEqual({ send: false, reason: APPOINTMENT_UPDATES_OFF_REASON, summary: 'Appointment — left confirmed (updates off)' });
    }
    expect(decideAppointment({ call: null, effect: 'showed', enabled: false })).toMatchObject({ reason: 'no appointment' });
    // The footer treats the off reason like a left-alone appointment.
    expect(planEffectLine({ steps: [{ name: 'stage', request: { method: 'PUT' }, skipReason: null }, { name: 'appointment', request: null, skipReason: APPOINTMENT_UPDATES_OFF_REASON }, { name: 'note', request: { method: 'POST' }, skipReason: null }], before: { stageId: 's_cbooked', status: 'open' }, after: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'confirmed' }, backward: false, hasCall: true, dryRun: false })).toBe('Moves to Pre-Roadmap Booked · appointment unchanged · adds note');
  });
});

describe('item 4 — the audit flags (pure)', () => {
  const positions = new Map([['s_applied', 0], ['s_cbooked', 2], ['s_cresched', 4], ['s_rbooked', 6], ['s_enrolled', 10]]);
  const ok = (request: { method: 'PUT' | 'POST'; path: string; body: Record<string, unknown> }) => ({ status: 'ok' as const, request, httpStatus: 200, body: null, error: null, reason: null, at: null });
  it("flags Bridget's same-stage PUT, Sindhu's cancelled appointment, a backward move; a clean row has none; an unsent request is marked", () => {
    const bridget = auditFlags({ outcomeKey: 'consult_showed_booked', state: 'ok', before: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'confirmed' }, after: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'showed' }, steps: { stage: ok({ method: 'PUT', path: '/opportunities/o1', body: { pipelineId: 'p', pipelineStageId: 's_rbooked' } }), appointment: ok({ method: 'PUT', path: '/calendars/events/appointments/e1', body: { appointmentStatus: 'showed' } }), note: ok({ method: 'POST', path: '/contacts/c/notes', body: {} }) } }, positions);
    expect(bridget.map((f) => [f.kind, f.sent])).toEqual([['same_stage_put', true]]);
    const sindhu = auditFlags({ outcomeKey: 'consult_reschedule', state: 'ok', before: { stageId: 's_applied', stageName: 'Applied', status: 'open', appointmentStatus: 'confirmed' }, after: { stageId: 's_cresched', stageName: 'Consult Reschedule', status: 'open', appointmentStatus: 'cancelled' }, steps: { stage: ok({ method: 'PUT', path: '/opportunities/o2', body: { pipelineId: 'p', pipelineStageId: 's_cresched' } }), appointment: ok({ method: 'PUT', path: '/calendars/events/appointments/e2', body: { appointmentStatus: 'cancelled' } }) } }, positions);
    expect(sindhu.map((f) => f.kind)).toEqual(['appointment_cancelled']);
    const back = auditFlags({ outcomeKey: 'move_to', state: 'ok', before: { stageId: 's_enrolled', stageName: 'Enrolled', status: 'won', appointmentStatus: null }, after: { stageId: 's_cbooked', stageName: 'Consult Booked', status: 'won', appointmentStatus: null }, steps: { stage: ok({ method: 'PUT', path: '/opportunities/o3', body: { pipelineId: 'p', pipelineStageId: 's_cbooked' } }) } }, positions);
    expect(back.map((f) => f.kind)).toEqual(['backward_move']);
    expect(back[0].detail).toContain('via Move to…');
    const clean = auditFlags({ outcomeKey: 'consult_showed_booked', state: 'ok', before: { stageId: 's_cbooked', stageName: 'Consult Booked', status: 'open', appointmentStatus: 'confirmed' }, after: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'showed' }, steps: { stage: ok({ method: 'PUT', path: '/opportunities/o4', body: { pipelineId: 'p', pipelineStageId: 's_rbooked' } }), appointment: ok({ method: 'PUT', path: '/calendars/events/appointments/e4', body: { appointmentStatus: 'showed' } }) } }, positions);
    expect(clean).toEqual([]);
    const skipped = auditFlags({ outcomeKey: 'consult_showed_booked', state: 'ok', before: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'confirmed' }, after: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'showed' }, steps: { stage: { status: 'skipped', request: null, httpStatus: null, body: null, error: null, reason: 'already in Pre-Roadmap Booked', at: null } } }, positions);
    expect(skipped).toEqual([]); // what stage 5 now writes for Bridget's situation
    const pending = auditFlags({ outcomeKey: 'roadmap_reschedule', state: 'failed', before: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'confirmed' }, after: { stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'cancelled' }, steps: { appointment: { status: 'pending', request: { method: 'PUT', path: '/calendars/events/appointments/e5', body: { appointmentStatus: 'cancelled' } }, httpStatus: null, body: null, error: null, reason: null, at: null } } }, positions);
    expect(pending.map((f) => [f.kind, f.sent])).toEqual([['appointment_cancelled', false]]);
  });
});

describe('item 6 — the parity script\'s pure parts', () => {
  it('only a contact named test; a no-op request is the Bridget shape; outbound messages inside the window, summarised', () => {
    expect(isTestContactName('Jake Test')).toBe(true);
    expect(isTestContactName('TESTING account')).toBe(true);
    expect(isTestContactName('Bridget Voigt')).toBe(false);
    expect(isTestContactName(null)).toBe(false);
    const live = { pipelineId: 'p1', stageId: 's_rbooked', status: 'open', appointmentStatus: 'confirmed' };
    expect(isNoopRequest('stage', { method: 'PUT', path: '/opportunities/o', body: { pipelineStageId: 's_rbooked' } }, live)).toBe(true);
    expect(isNoopRequest('stage', { method: 'PUT', path: '/opportunities/o', body: { pipelineStageId: 's_enrolled' } }, live)).toBe(false);
    expect(isNoopRequest('appointment', { method: 'PUT', path: '/calendars/events/appointments/e', body: { appointmentStatus: 'confirmed' } }, live)).toBe(true);
    expect(isNoopRequest('appointment', { method: 'PUT', path: '/calendars/events/appointments/e', body: { appointmentStatus: 'showed' } }, live)).toBe(false);
    expect(isNoopRequest('note', { method: 'POST', path: '/contacts/c/notes', body: { body: 'x' } }, live)).toBe(false);
    const msgs = [
      { id: 'm1', direction: 'outbound', messageType: 'TYPE_EMAIL', dateAdded: '2026-10-30T18:28:10.000Z', subject: '(Watch This) Before Your Consult!', body: 'Hi…', source: 'workflow', meta: { workflowId: 'wf-1' } },
      { id: 'm2', direction: 'outbound', messageType: 'TYPE_SMS', dateAdded: '2026-10-30T18:28:12.000Z', body: 'Confirming your consult\nsecond line' },
      { id: 'm3', direction: 'inbound', messageType: 'TYPE_SMS', dateAdded: '2026-10-30T18:28:30.000Z', body: 'thanks' },
      { id: 'm4', direction: 'outbound', messageType: 'TYPE_SMS', dateAdded: '2026-10-30T17:00:00.000Z', body: 'earlier' },
    ];
    const inWindow = messagesInWindow(msgs, Date.parse('2026-10-30T18:27:39Z'), Date.parse('2026-10-30T18:29:09Z'));
    expect(inWindow.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(summarizeMessage(msgs[0], 'America/Edmonton')).toBe('12:28:10 PM · email · (Watch This) Before Your Consult! · source workflow · meta.workflowId="wf-1"');
    expect(summarizeMessage(msgs[1], 'America/Edmonton')).toBe('12:28:12 PM · sms · Confirming your consult');
  });
});

describe('item 1 — reschedule never cancels', () => {
  it('a fresh database carries the explicit leave row after the migrations; the catalogue reads leave', async () => {
    expect(await getSetting(KEY)).toBe('leave');
    expect(await readRescheduleAppointment()).toBe('leave');
    expect(await readAppointmentUpdates()).toBe(false); // item 5: OFF until Mitchell turns it on
  });

  it('0024: no row → leave written; an owner\'s cancelled → kept; leave → unchanged', async () => {
    await db.delete(settings).where(eq(settings.key, KEY));
    await replay0024();
    expect(await getSetting(KEY)).toBe('leave');

    await db.update(settings).set({ value: 'cancelled' }).where(eq(settings.key, KEY));
    await replay0024();
    expect(await getSetting(KEY)).toBe('cancelled');
    expect(await readRescheduleAppointment()).toBe('cancelled');

    await db.update(settings).set({ value: 'leave' }).where(eq(settings.key, KEY));
    await replay0024();
    expect(await getSetting(KEY)).toBe('leave');
  });
});
