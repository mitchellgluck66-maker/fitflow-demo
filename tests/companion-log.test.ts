/**
 * Companion stage 2, item 4 — the logging flow on PGlite with ONE fetch fake routing by method + URL (GHL re-read
 * through the read-only client, writes through the write module): the happy path (three ok steps, the exact
 * requests, the mirror and the transition), idempotency by request id, the stale-stage prompt, partial failure +
 * retry of the missing steps only + the incident, undo inside / outside the window, dry run sends nothing, a person
 * without an appointment, the refusals, the pure text, and the append-only rule.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, appointments, companionActions, contacts, ghlOpportunities, pipelines, stageTransitions, stages, syncIncidents } from '@/db';
import { setSetting } from '@/lib/settings';
import { CREDENTIAL_KEYS } from '@/lib/ghl/config';
import { COMPANION_SETTING_KEYS } from '@/lib/companion/config';
import { setCompanionWriteTransport } from '@/lib/companion/ghlWrite';
import { executeLog, planLog, retryLog, undoLog, actionView, noteText, confirmationText, noteProblem, NOTE_MIN_CHARS } from '@/lib/companion/log';
import { stateOfSteps, effectiveState, UNDO_WINDOW_MS, actionsForEvents, listFailedActions } from '@/lib/companion/actions';
import { callActionsForEvents } from '@/lib/companion/actionsView';
import { COMPANION_INCIDENT_KIND } from '@/lib/companion/logDb';
import { statusOf } from '@/lib/companion/day';
import type { CurrentUser } from '@/lib/auth/currentUser';

const TZ = 'America/Edmonton';
const PIPE = 'UR5P3vNTm9VPuYZFrb6c';
const READ_TOKEN = 'pit-read-0000';
const WRITE_TOKEN = 'pit-write-9999';
const now = new Date('2026-10-16T17:20:00Z'); // 11:20 MDT
const miranda: CurrentUser = { uid: 'user-miranda', role: 'onboarding', name: 'Miranda', email: 'm@example.com', ghlUserId: 'ghl-user-m', preferences: {}, source: 'db' };
const jake: CurrentUser = { uid: 'user-jake', role: 'owner', name: 'Jake', email: 'j@example.com', ghlUserId: null, preferences: {}, source: 'db' };

const STAGES = [
  ['s_applied', 'Applied', 'applied', 0],
  ['s_cbooked', 'Consult Booked', 'consult_booked', 1],
  ['s_cnoshow', 'Consult No Show', 'consult_noshow', 2],
  ['s_cresched', 'Consult Reschedule', 'consult_rescheduled', 3],
  ['s_rbooked', 'Pre-Roadmap Booked', 'roadmap_booked', 4],
  ['s_enrolled', 'Enrolled', 'enrolled', 8],
  ['s_alumni', 'Alumni', 'other', 9],
] as const;

/** The fake GHL: a live opportunity whose stage/status the test sets, and per-call responses for the writes. */
const ghl = {
  liveStage: 's_cbooked',
  liveStatus: 'open',
  appointmentResponse: () => new Response('{"succeeded":true}', { status: 200 }),
  calls: [] as Array<{ method: string; url: string; body: unknown; auth: string }>,
  reset() {
    this.liveStage = 's_cbooked';
    this.liveStatus = 'open';
    this.appointmentResponse = () => new Response('{"succeeded":true}', { status: 200 });
    this.calls = [];
  },
};
const writes = () => ghl.calls.filter((c) => c.method !== 'GET');

const fetchFake = vi.fn(async (url: string, init: RequestInit) => {
  const method = init.method ?? 'GET';
  const headers = init.headers as Record<string, string>;
  ghl.calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.Authorization });
  const path = new URL(url).pathname;
  if (method === 'GET' && path.startsWith('/opportunities/')) {
    return new Response(JSON.stringify({ opportunity: { id: path.split('/')[2], name: 'Jane', pipelineId: PIPE, pipelineStageId: ghl.liveStage, status: ghl.liveStatus, contactId: 'c1' } }), { status: 200 });
  }
  if (method === 'PUT' && path.startsWith('/opportunities/')) return new Response('{"succeeded":true}', { status: 200 });
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) return ghl.appointmentResponse();
  if (method === 'POST' && path.endsWith('/notes')) return new Response('{"id":"note-1"}', { status: 201 });
  return new Response('not found', { status: 404 });
});

const prov = { source: 'ghl', origin: 'ghl', syncedAt: new Date('2026-10-16T13:00:00Z'), backfilled: false } as const;
const call = { eventId: 'ev1', ghlStatus: 'confirmed', startIso: '2026-10-16T16:00:00.000Z', callType: 'Consult' as const, calendarName: '15-Minute Fit Physician Consult' };
const base = { ghlContactId: 'c1', call, note: 'Great energy, booked the roadmap for Thursday.', user: miranda, timezone: TZ, now };
let seq = 0;
const rid = () => `req-${String(++seq).padStart(4, '0')}-abcdef`;

async function resetData() {
  await db.delete(companionActions);
  await db.delete(syncIncidents);
  await db.delete(stageTransitions);
  await db.update(contacts).set({ stageId: 's_cbooked', opportunityStatus: 'open' }).where(eq(contacts.ghlContactId, 'c1'));
  await db.update(ghlOpportunities).set({ stageId: 's_cbooked', status: 'open' }).where(eq(ghlOpportunities.id, 'opp1'));
  await db.update(appointments).set({ ghlStatus: 'confirmed', outcome: null }).where(eq(appointments.ghlEventId, 'ev1'));
}

beforeAll(async () => {
  await runMigrations();
  await setSetting('timezone', TZ);
  await setSetting(CREDENTIAL_KEYS.token, READ_TOKEN, { secret: true });
  await setSetting(CREDENTIAL_KEYS.locationId, 'loc_test');
  await setSetting(COMPANION_SETTING_KEYS.writeToken, WRITE_TOKEN, { secret: true });
  await db.insert(pipelines).values({ id: PIPE, name: '[new] Application Pipeline', isTracked: true, ...prov });
  await db.insert(stages).values(STAGES.map(([id, name, role, position]) => ({ id, pipelineId: PIPE, name, position, semanticRole: role, roleSource: 'manual', ...prov })));
  const [c] = await db.insert(contacts).values({ ghlContactId: 'c1', ghlOpportunityId: 'opp1', pipelineId: PIPE, stageId: 's_cbooked', opportunityStatus: 'open', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', ...prov }).returning({ id: contacts.id });
  await db.insert(ghlOpportunities).values({ id: 'opp1', ghlContactId: 'c1', contactId: c.id, pipelineId: PIPE, stageId: 's_cbooked', status: 'open', ghlUpdatedAt: new Date('2026-10-15T00:00:00Z'), ...prov });
  await db.insert(appointments).values({ ghlEventId: 'ev1', ghlCalendarId: 'cal-consult', calendarName: '15-Minute Fit Physician Consult', ghlContactId: 'c1', contactId: c.id, type: 'Consult', startTime: new Date('2026-10-16T16:00:00Z'), endTime: new Date('2026-10-16T16:15:00Z'), timezone: TZ, assignedUserId: 'ghl-user-m', ghlStatus: 'confirmed', ...prov });
  vi.stubGlobal('fetch', fetchFake);
  setCompanionWriteTransport(null);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(async () => {
  ghl.reset();
  await setSetting(COMPANION_SETTING_KEYS.dryRun, 'false');
  await resetData();
});

describe('pure', () => {
  it('note rule, note text, confirmation text, step states', () => {
    expect(noteProblem('short')).toBe(`The note needs at least ${NOTE_MIN_CHARS} characters (5 / ${NOTE_MIN_CHARS}).`);
    expect(noteProblem('   nine chars   ')).toBeNull(); // trimmed to exactly 10
    expect(noteProblem('  nine char  ')).toBe(`The note needs at least ${NOTE_MIN_CHARS} characters (9 / ${NOTE_MIN_CHARS}).`);
    expect(noteProblem('long enough note')).toBeNull();
    expect(noteText({ callType: 'Consult', startIso: '2026-10-16T16:00:00Z', timezone: TZ, userName: 'Miranda', label: 'Showed, roadmap booked', from: 'Consult Booked', to: 'Pre-Roadmap Booked', note: ' Great call. ' })).toBe('Onboarding call · Consult · Oct 16, 10:00 AM · Miranda\nOutcome: Showed, roadmap booked (Consult Booked → Pre-Roadmap Booked)\nNote: Great call.');
    expect(noteText({ callType: 'none', startIso: null, timezone: TZ, userName: 'Miranda', label: 'Move to Alumni', from: 'Enrolled', to: 'Alumni', note: 'x'.repeat(10) })).toContain('Onboarding call · no call · no appointment · Miranda');
    expect(confirmationText({ clientName: 'Jane Doe', from: 'Consult Booked', to: 'Pre-Roadmap Booked', statusFrom: 'open', statusTo: 'open', hasOpportunity: true, appointment: { startIso: '2026-10-16T16:00:00Z', callType: 'Consult', to: 'showed' }, timezone: TZ, dryRun: false })).toBe('Move Jane Doe from Consult Booked to Pre-Roadmap Booked, mark the 10:00 AM Consult showed, add this note. This may send GoHighLevel messages to the client.');
    expect(confirmationText({ clientName: 'Jane Doe', from: 'Consult Booked', to: 'Consult Booked', statusFrom: 'open', statusTo: 'lost', hasOpportunity: true, appointment: { startIso: '2026-10-16T16:00:00Z', callType: 'Consult', to: 'showed' }, timezone: TZ, dryRun: true })).toBe("Mark Jane Doe's opportunity lost, mark the 10:00 AM Consult showed, add this note. This may send GoHighLevel messages to the client. Dry run — nothing will be sent.");
    expect(confirmationText({ clientName: 'Jane Doe', from: 'Consult Booked', to: 'Consult Booked', statusFrom: 'open', statusTo: 'open', hasOpportunity: true, appointment: { startIso: null, callType: 'Consult', to: 'leave' }, timezone: TZ, dryRun: false })).toBe('Keep Jane Doe in Consult Booked, add this note. This may send GoHighLevel messages to the client.');
    const ok = { status: 'ok', request: null, httpStatus: 200, body: null, error: null, reason: null, at: null } as const;
    const failed = { ...ok, status: 'failed' as const, error: 'x' };
    const pending = { ...ok, status: 'pending' as const };
    expect(stateOfSteps({ stage: ok, appointment: ok, note: ok }, false)).toBe('ok');
    expect(stateOfSteps({ stage: ok, appointment: failed, note: pending }, false)).toBe('partial');
    expect(stateOfSteps({ stage: failed, appointment: pending, note: pending }, false)).toBe('failed');
    expect(stateOfSteps({ stage: ok, appointment: pending, note: pending }, false)).toBe('running');
    expect(stateOfSteps({ stage: { ...ok, status: 'dry_run' }, appointment: { ...ok, status: 'skipped' }, note: { ...ok, status: 'dry_run' } }, true)).toBe('dry_run');
    expect(effectiveState({ state: 'running', updatedAt: new Date(now.getTime() - 3 * 60_000), steps: { stage: ok } }, now)).toEqual({ state: 'partial', stale: true });
    expect(effectiveState({ state: 'running', updatedAt: new Date(now.getTime() - 30_000), steps: {} }, now)).toEqual({ state: 'running', stale: false });
  });
});

describe('plan', () => {
  it('resolves the move, the appointment change and the note; refuses a short note, a wrong-type outcome, an unmapped role', async () => {
    const r = await planLog({ ...base, outcome: { key: 'consult_showed_booked' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.clientName).toBe('Jane Doe');
    expect(r.plan.opportunity).toMatchObject({ id: 'opp1', from: { id: 's_cbooked', name: 'Consult Booked' }, to: { id: 's_rbooked', name: 'Pre-Roadmap Booked' }, status: { from: 'open', to: 'open' } });
    expect(r.plan.appointment).toMatchObject({ eventId: 'ev1', from: 'confirmed', to: 'showed' });
    expect(r.plan.steps.map((s) => [s.name, s.skipReason, s.request?.body])).toEqual([
      ['stage', null, { pipelineId: PIPE, pipelineStageId: 's_rbooked' }],
      ['appointment', null, { appointmentStatus: 'showed' }],
      ['note', null, { body: r.plan.noteText, userId: 'ghl-user-m' }],
    ]);
    expect(r.plan.confirmation).toBe('Move Jane Doe from Consult Booked to Pre-Roadmap Booked, mark the 10:00 AM Consult showed, add this note. This may send GoHighLevel messages to the client.');
    expect(r.plan.expectedStageId).toBe('s_cbooked');
    expect(r.plan.dryRun).toBe(false);
    expect(await planLog({ ...base, note: 'too short', outcome: { key: 'consult_noshow' } })).toEqual({ ok: false, status: 422, error: `The note needs at least ${NOTE_MIN_CHARS} characters (9 / ${NOTE_MIN_CHARS}).` });
    expect(await planLog({ ...base, outcome: { key: 'roadmap_enrolled' } })).toEqual({ ok: false, status: 422, error: '"Enrolled" is a Roadmap outcome; this is a Consult call.' });
    expect(await planLog({ ...base, outcome: { key: 'consult_reschedule' } })).toEqual({ ok: true, plan: expect.objectContaining({ dryRun: false }) }); // consult_rescheduled is mapped
    expect(await planLog({ ...base, call: { ...call, callType: 'Roadmap' }, outcome: { key: 'roadmap_showed_objection' } })).toEqual({ ok: false, status: 422, error: 'No stage in [new] Application Pipeline is mapped to the role roadmap_showed — map it in Setup → Pipelines.' });
    // "Not a fit": stage unchanged, opportunity lost → the stage step carries only the status.
    const nf = await planLog({ ...base, outcome: { key: 'consult_not_fit' } });
    expect(nf.ok && nf.plan.steps[0]).toMatchObject({ name: 'stage', request: { body: { pipelineId: PIPE, status: 'lost' } }, summary: 'Opportunity open → lost' });
    expect(nf.ok && nf.plan.confirmation).toBe("Mark Jane Doe's opportunity lost, mark the 10:00 AM Consult showed, add this note. This may send GoHighLevel messages to the client.");
    // "Cancelled": nothing changes on the opportunity → the stage step is skipped.
    const cc = await planLog({ ...base, outcome: { key: 'consult_cancelled' } });
    expect(cc.ok && cc.plan.steps[0]).toMatchObject({ name: 'stage', skipReason: 'stage unchanged' });
    expect(writes()).toEqual([]); // planning never writes
  });

  it('no write key with dry run off → 412; with dry run on the plan still works', async () => {
    await setSetting(COMPANION_SETTING_KEYS.writeToken, '', { secret: true });
    expect(await planLog({ ...base, outcome: { key: 'consult_noshow' } })).toEqual({ ok: false, status: 412, error: 'No Companion write key — the owner adds it in Setup → Companion.' });
    await setSetting(COMPANION_SETTING_KEYS.dryRun, 'true');
    expect((await planLog({ ...base, outcome: { key: 'consult_noshow' } })).ok).toBe(true);
    await setSetting(COMPANION_SETTING_KEYS.writeToken, WRITE_TOKEN, { secret: true });
  });
});

describe('execute', () => {
  it('happy path: GHL re-read, three ok steps with the exact requests, the mirror and the transition follow, no incident', async () => {
    const r = await executeLog({ ...base, outcome: { key: 'consult_showed_booked' }, requestId: rid(), expectedStageId: 's_cbooked' });
    expect(r.ok && r.created).toBe(true);
    if (!r.ok) return;
    const a = r.action;
    expect(a.state).toBe('ok');
    expect(a.before).toEqual({ stageId: 's_cbooked', stageName: 'Consult Booked', status: 'open', appointmentStatus: 'confirmed' });
    expect(a.after).toEqual({ stageId: 's_rbooked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'showed' });
    expect([a.steps.stage?.status, a.steps.appointment?.status, a.steps.note?.status]).toEqual(['ok', 'ok', 'ok']);
    expect(a.steps.stage).toMatchObject({ httpStatus: 200, body: '{"succeeded":true}', request: { method: 'PUT', path: '/opportunities/opp1', body: { pipelineId: PIPE, pipelineStageId: 's_rbooked' } } });
    // The order on the wire: the re-read (read key), then stage → appointment → note (write key).
    expect(ghl.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /opportunities/opp1', 'PUT /opportunities/opp1', 'PUT /calendars/events/appointments/ev1', 'POST /contacts/c1/notes']);
    expect(ghl.calls[0].auth).toBe(`Bearer ${READ_TOKEN}`);
    expect(writes().every((c) => c.auth === `Bearer ${WRITE_TOKEN}`)).toBe(true);
    expect(writes()[2].body).toEqual({ body: 'Onboarding call · Consult · Oct 16, 10:00 AM · Miranda\nOutcome: Showed, roadmap booked (Consult Booked → Pre-Roadmap Booked)\nNote: Great energy, booked the roadmap for Thursday.', userId: 'ghl-user-m' });
    // Mirror.
    const [c] = await db.select().from(contacts).where(eq(contacts.ghlContactId, 'c1'));
    expect(c.stageId).toBe('s_rbooked');
    expect(c.lastStageChangeAt?.toISOString()).toBe(now.toISOString());
    const [o] = await db.select().from(ghlOpportunities).where(eq(ghlOpportunities.id, 'opp1'));
    expect(o.stageId).toBe('s_rbooked');
    const [ap] = await db.select().from(appointments).where(eq(appointments.ghlEventId, 'ev1'));
    expect([ap.ghlStatus, ap.outcome]).toEqual(['showed', 'showed']);
    const t = await db.select().from(stageTransitions);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ fromStageId: 's_cbooked', toStageId: 's_rbooked', fromRole: 'consult_booked', toRole: 'roadmap_booked', kind: 'companion', source: 'companion', ghlOpportunityId: 'opp1' });
    expect(await db.select().from(syncIncidents)).toEqual([]);
    // The chip.
    const chips = await callActionsForEvents(['ev1'], now);
    expect(chips.get('ev1')).toMatchObject({ id: a.id, state: 'ok', label: 'Showed, roadmap booked', failedStep: null });
    expect(statusOf({ startIso: call.startIso, endIso: null, outcomeInGhl: 'showed', action: chips.get('ev1') }, now)).toBe('logged');
    const view = actionView(a, now, miranda);
    expect(view.canUndo).toBe(true);
    expect(view.canRetry).toBe(false);
    expect(view.steps.map((s) => s.summary)).toEqual(['Stage Consult Booked → Pre-Roadmap Booked', 'Appointment confirmed → showed', 'Note on the contact']);
  });

  it('the same request id twice applies once (a double-click / a resent POST finds the row)', async () => {
    const requestId = rid();
    const first = await executeLog({ ...base, outcome: { key: 'consult_noshow' }, requestId, expectedStageId: 's_cbooked' });
    const sent = writes().length;
    ghl.liveStage = 's_cnoshow'; // GHL now reflects the move — a naive second run would see a "stale" stage
    const second = await executeLog({ ...base, outcome: { key: 'consult_noshow' }, requestId, expectedStageId: 's_cbooked', acceptedStageId: 's_cnoshow' });
    expect(second.ok && !second.created && first.ok && second.action.id === first.action.id).toBe(true);
    expect(writes()).toHaveLength(sent);
    expect(await db.select().from(companionActions)).toHaveLength(1);
  });

  it('a stage that moved in GHL since the sheet opened → 409 naming it; accepted → applied from the live stage', async () => {
    ghl.liveStage = 's_cnoshow';
    const r = await executeLog({ ...base, outcome: { key: 'consult_showed_booked' }, requestId: rid(), expectedStageId: 's_cbooked' });
    expect(r).toEqual({ ok: false, status: 409, error: 'Stage changed to Consult No Show since you opened this — continue?', staleStage: { stageId: 's_cnoshow', stageName: 'Consult No Show' } });
    expect(writes()).toEqual([]);
    expect(await db.select().from(companionActions)).toEqual([]);
    const ok = await executeLog({ ...base, outcome: { key: 'consult_showed_booked' }, requestId: rid(), expectedStageId: 's_cbooked', acceptedStageId: 's_cnoshow' });
    expect(ok.ok && ok.action.state).toBe('ok');
    expect(ok.ok && ok.action.before.stageName).toBe('Consult No Show');
    const t = await db.select().from(stageTransitions);
    expect(t[0]).toMatchObject({ fromStageId: 's_cnoshow', toStageId: 's_rbooked' });
  });

  it('GHL cannot be re-read → 502, nothing written, no row', async () => {
    fetchFake.mockImplementationOnce(async () => new Response('Unauthorized', { status: 401 }));
    const r = await executeLog({ ...base, outcome: { key: 'consult_noshow' }, requestId: rid(), expectedStageId: 's_cbooked' });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(r.ok === false && r.error).toContain('nothing was changed');
    expect(writes()).toEqual([]);
    expect(await db.select().from(companionActions)).toEqual([]);
  });

  it('appointment step fails → partial (stage mirrored, note not attempted, incident open, red chip); retry re-runs ONLY the missing steps and resolves the incident', async () => {
    ghl.appointmentResponse = () => new Response('{"message":"Appointment status cannot be updated"}', { status: 422 });
    const r = await executeLog({ ...base, outcome: { key: 'consult_showed_booked' }, requestId: rid(), expectedStageId: 's_cbooked' });
    expect(r.ok && r.action.state).toBe('partial');
    if (!r.ok) return;
    expect([r.action.steps.stage?.status, r.action.steps.appointment?.status, r.action.steps.note?.status]).toEqual(['ok', 'failed', 'pending']);
    expect(r.action.steps.appointment).toMatchObject({ httpStatus: 422, error: 'GHL 422 PUT /calendars/events/appointments/ev1: {"message":"Appointment status cannot be updated"}' });
    expect(r.action.error).toBe(r.action.steps.appointment?.error);
    expect(writes().map((c) => c.method)).toEqual(['PUT', 'PUT']); // the note was never sent
    // What landed is mirrored; what did not is not.
    expect((await db.select().from(contacts).where(eq(contacts.ghlContactId, 'c1')))[0].stageId).toBe('s_rbooked');
    expect((await db.select().from(appointments).where(eq(appointments.ghlEventId, 'ev1')))[0].ghlStatus).toBe('confirmed');
    const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, COMPANION_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0].message).toBe('Companion log failed for Jane Doe: appointment step — GHL 422 PUT /calendars/events/appointments/ev1: {"message":"Appointment status cannot be updated"} (Showed, roadmap booked, Miranda)');
    expect(open[0].severity).toBe('warning');
    const chip = (await callActionsForEvents(['ev1'], now)).get('ev1');
    expect(chip).toMatchObject({ state: 'partial', failedStep: 'appointment' });
    expect(statusOf({ startIso: call.startIso, endIso: null, outcomeInGhl: null, action: chip }, now)).toBe('failed');
    expect((await listFailedActions(now)).map((f) => [f.clientName, f.failedStep, f.state])).toEqual([['Jane Doe', 'appointment', 'partial']]);
    const view = actionView(r.action, now, miranda);
    expect(view.canRetry).toBe(true);
    expect(view.failedStep).toBe('appointment');

    // Retry: the appointment now succeeds; the stage step is NOT re-sent.
    ghl.reset();
    const again = await retryLog(r.action.id, miranda, new Date(now.getTime() + 60_000));
    expect(again.ok && again.action.state).toBe('ok');
    expect(ghl.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['PUT /calendars/events/appointments/ev1', 'POST /contacts/c1/notes']);
    expect((await db.select().from(appointments).where(eq(appointments.ghlEventId, 'ev1')))[0].ghlStatus).toBe('showed');
    const resolved = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, COMPANION_INCIDENT_KIND));
    expect(resolved[0].resolvedAt).not.toBeNull();
    expect((resolved[0].details as { resolvedBy: string }).resolvedBy).toContain('completed');
    expect(await listFailedActions(now)).toEqual([]);
    expect(await retryLog(r.action.id, miranda)).toEqual({ ok: false, status: 409, error: 'Nothing to retry — this log is ok.' });
    // Another technician cannot touch it; the owner can see it.
    const other: CurrentUser = { ...miranda, uid: 'user-other' };
    expect(await retryLog(r.action.id, other)).toMatchObject({ ok: false, status: 404 });
    expect(actionView(again.ok ? again.action : r.action, now, jake).canUndo).toBe(true);
  });

  it('undo inside the window reverses the applied steps in reverse order, adds "Undone by", reverts the mirror; after the window → 410', async () => {
    const r = await executeLog({ ...base, outcome: { key: 'consult_showed_booked' }, requestId: rid(), expectedStageId: 's_cbooked' });
    if (!r.ok) throw new Error('setup');
    ghl.reset();
    const u = await undoLog(r.action.id, miranda, new Date(now.getTime() + 2 * 60_000));
    expect(u.ok && u.action.state).toBe('undone');
    if (!u.ok) return;
    expect(u.action.undoneBy).toBe('Miranda');
    expect(ghl.calls.map((c) => [`${c.method} ${new URL(c.url).pathname}`, c.body])).toEqual([
      ['PUT /calendars/events/appointments/ev1', { appointmentStatus: 'confirmed' }],
      ['PUT /opportunities/opp1', { pipelineId: PIPE, pipelineStageId: 's_cbooked', status: 'open' }],
      ['POST /contacts/c1/notes', { body: `Undone by Miranda — Showed, roadmap booked logged ${now.toISOString()} was reversed.`, userId: 'ghl-user-m' }],
    ]);
    expect([u.action.undoSteps?.appointment?.status, u.action.undoSteps?.stage?.status, u.action.undoSteps?.note?.status]).toEqual(['ok', 'ok', 'ok']);
    expect((await db.select().from(contacts).where(eq(contacts.ghlContactId, 'c1')))[0].stageId).toBe('s_cbooked');
    expect((await db.select().from(ghlOpportunities).where(eq(ghlOpportunities.id, 'opp1')))[0].stageId).toBe('s_cbooked');
    const [ap] = await db.select().from(appointments).where(eq(appointments.ghlEventId, 'ev1'));
    expect([ap.ghlStatus, ap.outcome]).toEqual(['confirmed', null]);
    const t = await db.select().from(stageTransitions).orderBy(stageTransitions.createdAt);
    expect(t.map((x) => [x.fromStageId, x.toStageId])).toEqual([['s_cbooked', 's_rbooked'], ['s_rbooked', 's_cbooked']]);
    // Undone rows no longer drive the chip.
    expect((await actionsForEvents(['ev1'])).size).toBe(0);
    expect(await undoLog(r.action.id, miranda, new Date(now.getTime() + 3 * 60_000))).toEqual({ ok: false, status: 409, error: 'Already undone.' });
    // The window.
    const late = await executeLog({ ...base, outcome: { key: 'consult_noshow' }, requestId: rid(), expectedStageId: 's_cbooked' });
    if (!late.ok) throw new Error('setup');
    const after = new Date(now.getTime() + UNDO_WINDOW_MS + 1000);
    expect(await undoLog(late.action.id, miranda, after)).toEqual({ ok: false, status: 410, error: `Undo closed at ${new Date(now.getTime() + UNDO_WINDOW_MS).toISOString()} (5 minutes after the log).` });
    expect(actionView(late.action, after, miranda).canUndo).toBe(false);
  });

  it('undo of a partial log reverses only what was applied', async () => {
    ghl.appointmentResponse = () => new Response('nope', { status: 500 });
    const r = await executeLog({ ...base, outcome: { key: 'consult_showed_booked' }, requestId: rid(), expectedStageId: 's_cbooked' });
    if (!r.ok) throw new Error('setup');
    expect(r.action.state).toBe('partial');
    ghl.reset();
    const u = await undoLog(r.action.id, miranda, new Date(now.getTime() + 60_000));
    expect(u.ok && u.action.state).toBe('undone');
    expect(ghl.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['PUT /opportunities/opp1', 'POST /contacts/c1/notes']);
    expect(u.ok && u.action.undoSteps?.appointment).toBeUndefined();
    const inc = await db.select().from(syncIncidents).where(eq(syncIncidents.kind, COMPANION_INCIDENT_KIND));
    expect(inc[0].resolvedAt).not.toBeNull();
    expect((inc[0].details as { resolvedBy: string }).resolvedBy).toContain('undone by Miranda');
  });

  it('dry run: the row is written with every request, NOTHING is sent, the mirror is untouched, the chip says dry run', async () => {
    await setSetting(COMPANION_SETTING_KEYS.dryRun, 'true');
    const r = await executeLog({ ...base, outcome: { key: 'roadmap_enrolled' }, call: { ...call, callType: 'Roadmap' }, requestId: rid(), expectedStageId: 's_cbooked' });
    expect(r.ok && r.action.state).toBe('dry_run');
    if (!r.ok) return;
    expect(r.action.dryRun).toBe(true);
    expect([r.action.steps.stage?.status, r.action.steps.appointment?.status, r.action.steps.note?.status]).toEqual(['dry_run', 'dry_run', 'dry_run']);
    expect(r.action.steps.stage?.request).toEqual({ method: 'PUT', path: '/opportunities/opp1', body: { pipelineId: PIPE, pipelineStageId: 's_enrolled', status: 'won' } });
    expect(writes()).toEqual([]);
    expect(ghl.calls.map((c) => c.method)).toEqual(['GET']); // the re-read only
    expect((await db.select().from(contacts).where(eq(contacts.ghlContactId, 'c1')))[0].stageId).toBe('s_cbooked');
    expect(await db.select().from(stageTransitions)).toEqual([]);
    expect(await db.select().from(syncIncidents)).toEqual([]);
    const chip = (await callActionsForEvents(['ev1'], now)).get('ev1');
    expect(statusOf({ startIso: call.startIso, endIso: null, outcomeInGhl: null, action: chip }, now)).toBe('dry_run');
    // Undo of a dry run sends nothing either.
    const u = await undoLog(r.action.id, miranda, new Date(now.getTime() + 60_000));
    expect(u.ok && u.action.state).toBe('undone');
    expect(writes()).toEqual([]);
  });

  it('a person without an appointment: Move to… runs the stage and the note, the appointment step is skipped', async () => {
    const r = await executeLog({ ...base, call: null, outcome: { move: { stageId: 's_alumni', appointment: 'leave' } }, requestId: rid(), expectedStageId: 's_cbooked' });
    expect(r.ok && r.action.state).toBe('ok');
    if (!r.ok) return;
    expect(r.action.label).toBe('Move to Alumni');
    expect(r.action.callType).toBe('none');
    expect([r.action.steps.stage?.status, r.action.steps.appointment?.status, r.action.steps.note?.status]).toEqual(['ok', 'skipped', 'ok']);
    expect(r.action.steps.appointment?.reason).toBe('no appointment');
    expect(r.action.after).toMatchObject({ stageId: 's_alumni', status: 'open', appointmentStatus: null });
    expect(writes().map((c) => c.method)).toEqual(['PUT', 'POST']);
    // A Consult outcome without a call is refused.
    expect(await planLog({ ...base, call: null, outcome: { key: 'consult_noshow' } })).toEqual({ ok: false, status: 422, error: '"No-show" needs a Consult call — use Move to… for a person without a call.' });
  });
});

describe('append-only', () => {
  it('no code path deletes a REAL companion_actions row — the only deletes are the demo seed\'s own rows (request_id demo:…)', () => {
    const hits = execSync("grep -rn 'delete(companionActions)' lib app scripts db || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    // Stage 3: the demo tenant plants Companion logs (db/seed-demo) and the wipe removes them (lib/provenance) — both
    // scoped to request ids that start with `demo:`, which no real log can carry (they are UUIDs minted by the client).
    expect(hits.map((h) => h.split(':')[0]).sort()).toEqual(['db/seed-demo.ts', 'lib/provenance.ts']);
    for (const h of hits) expect(h).toContain("'demo:%'");
  });
});
