/**
 * Companion stage 2 — the LIVE proof. Writes to GoHighLevel. Mitchell runs it once, on the test contact Jake names.
 *
 *   npm run companion:live-test -- --contact <ghl contact id> [--event <ghl event id>] --i-understand-this-writes
 *
 * Refuses to start unless: the flag is present; dry run is OFF (Setup → Companion); a write key is saved; the
 * contact is in the followed pipeline (an opportunity in the mirror — run a sync first). Then, as the first active
 * onboarding login (or --user <email>):
 *
 *   1. every Consult outcome, then every Roadmap outcome, then one Move to… — each: log → re-read GHL (the
 *      opportunity by id, the event, the newest contact note) → PASS/FAIL per check → undo → re-read → PASS/FAIL
 *   2. a forced failure: the appointment step's transport answers 500 once → the log is `partial` → retry → `ok`
 *      → undo
 *   3. the contact ends where it started (every log is undone); the summary prints PASS/FAIL per check and the
 *      number of GHL writes sent.
 *
 * Every write goes through lib/companion/ghlWrite (the allow-list); every re-read through the read-only client.
 * Without --event the appointment checks are reported as SKIP (the appointment step is skipped by the log too).
 */
import { eq, sql } from 'drizzle-orm';
import { db, appUsers } from '../db';
import { getTimezone } from '../lib/settings';
import { getOpportunity, listContactNotes, listAppointments, listCalendars } from '../lib/ghl/client';
import { readDryRun } from '../lib/companion/config';
import { getCompanionWriteCount, hasWriteKey, setCompanionWriteTransport, type Transport } from '../lib/companion/ghlWrite';
import { readOutcomeCatalogue } from '../lib/companion/outcomeService';
import { outcomesFor, resolveOutcome } from '../lib/companion/outcomes';
import { readContactPosition, readMirrorAppointment } from '../lib/companion/logDb';
import { executeLog, retryLog, undoLog, type CallContext } from '../lib/companion/log';
import { callTypeOf } from '../lib/companion/calendars';
import type { CurrentUser } from '../lib/auth/currentUser';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const results: Array<{ check: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }> = [];
function record(check: string, ok: boolean | null, detail: string) {
  const status = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  results.push({ check, status, detail });
  console.log(`${status.padEnd(4)} ${check} · ${detail}`);
}

async function readLiveState(opportunityId: string | null, eventId: string | null, contactId: string, calendarId: string | null, startIso: string | null) {
  const opp = opportunityId ? await getOpportunity(opportunityId) : null;
  let eventStatus: string | null = null;
  if (eventId && calendarId && startIso) {
    const t = Date.parse(startIso);
    const r = await listAppointments({ startTimeMs: t - 36 * 3_600_000, endTimeMs: t + 36 * 3_600_000, calendarId });
    eventStatus = r.events.find((e) => e.id === eventId)?.appointmentStatus ?? null;
  }
  const notes = await listContactNotes(contactId);
  return { stageId: opp?.opportunity?.pipelineStageId ?? null, status: opp?.opportunity?.status ?? null, eventStatus, newestNote: notes.notes[0]?.body ?? null, oppError: opp?.error ?? null, notesError: notes.error ?? null };
}

async function main() {
  const contactId = arg('contact');
  const eventId = arg('event');
  if (!contactId || !process.argv.includes('--i-understand-this-writes')) {
    console.error('Usage: npm run companion:live-test -- --contact <ghl contact id> [--event <ghl event id>] --i-understand-this-writes\nThis script WRITES to GoHighLevel. It refuses to start without the flag.');
    process.exit(2);
  }
  const dry = await readDryRun();
  if (dry.on) {
    console.error('Refusing: dry run is ON (Setup → Companion). Turn it off for the live test, then turn it back on.');
    process.exit(2);
  }
  if (!(await hasWriteKey())) {
    console.error('Refusing: no Companion write key saved (Setup → Companion).');
    process.exit(2);
  }
  const email = arg('user');
  const rows = email ? await db.select().from(appUsers).where(eq(sql`lower(${appUsers.email})`, email.toLowerCase())) : await db.select().from(appUsers).where(eq(appUsers.active, true));
  const u = rows.find((r) => r.active && (email || r.role === 'onboarding'));
  if (!u) {
    console.error(email ? `Refusing: no active login for ${email}.` : 'Refusing: no active onboarding login — add one in Setup → Users, or pass --user <email>.');
    process.exit(2);
  }
  const user: CurrentUser = { uid: u.id, role: u.role, name: u.name, email: u.email, ghlUserId: u.ghlUserId, preferences: u.preferences ?? {}, source: 'db' };
  const timezone = await getTimezone();

  const position = await readContactPosition(contactId);
  if (!position.pipeline || !position.opportunity) {
    console.error(`Refusing: ${position.name} (${contactId}) has no opportunity in the followed pipeline${position.pipeline ? ` ${position.pipeline.name}` : ''} in the mirror — run a GHL sync first, or pick another test contact.`);
    process.exit(2);
  }
  const startStage = position.opportunity.stageId;
  const startStatus = position.opportunity.status;
  console.log(`Live test · ${position.name} (${contactId}) · ${position.pipeline.name} · starts in ${position.opportunity.stageName ?? startStage} (${startStatus}) · as ${user.name}`);

  // The appointment (optional): its calendar and start from the mirror, else from a live search of every calendar.
  let call: CallContext | null = null;
  let calendarId: string | null = null;
  if (eventId) {
    const m = await readMirrorAppointment(eventId);
    if (m) {
      call = { eventId, ghlStatus: m.ghlStatus, startIso: m.startIso, callType: callTypeOf(m.calendarName, m.title), calendarName: m.calendarName };
      const cals = await listCalendars();
      calendarId = cals.data?.calendars.find((c) => (m.calendarName ?? '').trim() === (c.name ?? '').trim())?.id ?? null;
    } else {
      console.error(`Refusing: event ${eventId} is not in the mirror — run a GHL sync first.`);
      process.exit(2);
    }
    console.log(`Appointment ${eventId} · ${call.callType} · ${call.startIso} · status ${call.ghlStatus}`);
  } else console.log('No --event: the appointment step is skipped by every log and its checks are SKIP.');

  const cat = await readOutcomeCatalogue();
  const live0 = await readLiveState(position.opportunity.id, eventId, contactId, calendarId, call?.startIso ?? null);
  record('GHL re-read before start', live0.oppError === null, live0.oppError ?? `stage ${live0.stageId} · ${live0.status} · event ${live0.eventStatus ?? 'n/a'}`);

  let seq = 0;
  const rid = () => `live-${Date.now()}-${++seq}`;
  const runOne = async (label: string, outcome: Parameters<typeof executeLog>[0]['outcome'], ctx: CallContext | null, expectStage: string | null, expectStatus: string | null, expectEvent: string | null) => {
    const before = await readLiveState(position.opportunity!.id, eventId, contactId, calendarId, ctx?.startIso ?? null);
    const r = await executeLog({ ghlContactId: contactId, call: ctx, outcome, note: `Live test ${label} — ${new Date().toISOString()}`, user, timezone, requestId: rid(), expectedStageId: before.stageId, acceptedStageId: before.stageId });
    if (!r.ok) {
      record(`${label}: log`, false, `${r.status} ${r.error}`);
      return null;
    }
    const a = r.action;
    record(`${label}: log`, a.state === 'ok', `state ${a.state}${a.error ? ` · ${a.error}` : ''}`);
    const after = await readLiveState(position.opportunity!.id, eventId, contactId, calendarId, ctx?.startIso ?? null);
    record(`${label}: stage in GHL`, expectStage ? after.stageId === expectStage : after.stageId === before.stageId, `expected ${expectStage ?? before.stageId}, GHL has ${after.stageId}`);
    record(`${label}: status in GHL`, expectStatus ? after.status === expectStatus : after.status === before.status, `expected ${expectStatus ?? before.status}, GHL has ${after.status}`);
    record(`${label}: appointment in GHL`, ctx && expectEvent ? after.eventStatus === expectEvent : null, ctx && expectEvent ? `expected ${expectEvent}, GHL has ${after.eventStatus}` : 'no appointment / left as is');
    record(`${label}: note in GHL`, after.notesError ? false : after.newestNote?.includes(`Live test ${label}`) ?? false, after.notesError ?? (after.newestNote ?? 'no note').slice(0, 80));
    const u = await undoLog(a.id, user);
    record(`${label}: undo`, u.ok && u.action.state === 'undone', u.ok ? `state ${u.action.state}${u.action.error ? ` · ${u.action.error}` : ''}` : `${u.status} ${u.error}`);
    const restored = await readLiveState(position.opportunity!.id, eventId, contactId, calendarId, ctx?.startIso ?? null);
    record(`${label}: restored stage`, restored.stageId === before.stageId, `before ${before.stageId}, now ${restored.stageId}`);
    record(`${label}: restored status`, restored.status === before.status, `before ${before.status}, now ${restored.status}`);
    record(`${label}: restored appointment`, ctx && expectEvent ? restored.eventStatus === before.eventStatus : null, ctx && expectEvent ? `before ${before.eventStatus}, now ${restored.eventStatus}` : 'no appointment');
    record(`${label}: "Undone by" note`, restored.newestNote?.startsWith(`Undone by ${user.name}`) ?? false, (restored.newestNote ?? 'no note').slice(0, 80));
    return a;
  };

  // 1. Every outcome of both call types (the call context's type is set to match), then one Move to….
  for (const type of ['Consult', 'Roadmap'] as const) {
    const ctx = call ? { ...call, callType: type } : null;
    for (const def of outcomesFor(type, cat.defs)) {
      const res = resolveOutcome(def, cat.ctx);
      if (!res.ok) {
        record(`${type} · ${def.label}: log`, false, res.reason);
        continue;
      }
      if (!ctx) {
        record(`${type} · ${def.label}: log`, null, 'needs --event (a call of that type)');
        continue;
      }
      const o = res.outcome;
      await runOne(`${type} · ${def.label}`, { key: def.key }, ctx, o.toStage?.id ?? null, o.opportunityStatus, o.appointment === 'leave' ? null : o.appointment);
    }
  }
  const other = cat.ctx.stages.find((s) => s.id !== startStage) ?? null;
  if (other) await runOne(`Move to ${other.name}`, { move: { stageId: other.id, appointment: 'leave' } }, call, other.id, null, null);
  else record('Move to', null, 'the followed pipeline has one stage');

  // 2. The forced failure: the appointment step answers 500 once → partial → retry → ok → undo.
  if (call) {
    const def = outcomesFor('Consult', cat.defs)[0];
    const res = resolveOutcome(def, cat.ctx);
    if (res.ok) {
      let armed = true;
      const real: Transport = (url, init) => fetch(url, init);
      const failing: Transport = async (url, init) => {
        if (armed && init.method === 'PUT' && new URL(url).pathname.startsWith('/calendars/events/appointments/')) {
          armed = false;
          return new Response('{"message":"forced failure by companion-live-test"}', { status: 500 });
        }
        return real(url, init);
      };
      setCompanionWriteTransport(failing);
      const before = await readLiveState(position.opportunity.id, eventId, contactId, calendarId, call.startIso);
      const r = await executeLog({ ghlContactId: contactId, call: { ...call, callType: 'Consult' }, outcome: { key: def.key }, note: `Live test forced failure — ${new Date().toISOString()}`, user, timezone, requestId: rid(), expectedStageId: before.stageId, acceptedStageId: before.stageId });
      setCompanionWriteTransport(null);
      if (r.ok) {
        record('forced failure: partial', r.action.state === 'partial' && r.action.steps.appointment?.status === 'failed' && r.action.steps.note?.status === 'pending', `state ${r.action.state} · appointment ${r.action.steps.appointment?.status} · note ${r.action.steps.note?.status}`);
        const retry = await retryLog(r.action.id, user);
        record('forced failure: retry → ok', retry.ok && retry.action.state === 'ok', retry.ok ? `state ${retry.action.state} · stage step kept ${retry.action.steps.stage?.at === r.action.steps.stage?.at ? '(not re-sent)' : '(RE-SENT)'}` : `${retry.status} ${retry.error}`);
        const after = await readLiveState(position.opportunity.id, eventId, contactId, calendarId, call.startIso);
        record('forced failure: GHL after retry', after.stageId === (res.outcome.toStage?.id ?? before.stageId) && after.eventStatus === res.outcome.appointment, `stage ${after.stageId} · event ${after.eventStatus}`);
        const u = await undoLog(r.action.id, user);
        record('forced failure: undo', u.ok && u.action.state === 'undone', u.ok ? `state ${u.action.state}` : `${u.status} ${u.error}`);
      } else record('forced failure: log', false, `${r.status} ${r.error}`);
    }
  } else record('forced failure', null, 'needs --event');

  // 3. Where the contact ends.
  const end = await readLiveState(position.opportunity.id, eventId, contactId, calendarId, call?.startIso ?? null);
  record('contact ends where it started', end.stageId === startStage && end.status === startStatus, `start ${startStage} (${startStatus}) · end ${end.stageId} (${end.status})`);

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} · ${pass} passed · ${fail} failed · ${skip} skipped · ${getCompanionWriteCount()} GHL writes sent`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
