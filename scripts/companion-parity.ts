/**
 * Companion stage 5, item 6 — PARITY WITH A MANUAL DRAG. Writes to GoHighLevel, on a TEST contact only.
 *
 *   npm run companion:parity -- --contact <ghlContactId> --i-understand-this-writes
 *       [--outcomes consult_showed_booked,consult_reschedule,…] [--event <ghlEventId>] [--wait 90] [--user <email>]
 *
 * Evidence (Bridget Voigt, 2026-10-30): a PUT to the stage she was already in re-sent her consult-confirmation set a
 * minute later. A person dragging a card never re-saves the current stage. This script proves, per outcome, exactly
 * what FitFlow sends now and what GHL does in return:
 *
 *   for each outcome: read the live state → log it through the REAL companion path (`executeLog`; dry run forced OFF
 *   for this process only — the saved setting is never touched) → wait --wait seconds (default 90) → list every
 *   OUTBOUND message GHL logged for the contact in that window (read path: /conversations/search +
 *   /conversations/{id}/messages — time, channel, subject / first line, workflow id or name when GHL provides it) →
 *   restore the stage (and deal status) it started in with a MINIMAL PUT — the restore is itself a move and may
 *   trigger that stage's automations, so its window is listed too.
 *
 * Refuses without the flag, without a saved write key, for a contact whose name does not contain "test"
 * (case-insensitive), or for a contact with no opportunity in the followed pipeline. The appointment status is left
 * as the outcome set it (restoring it would be one more status change; the Setup switch is OFF by default anyway).
 * Exit 1 if any request FitFlow sent had a no-op body (every field equal to the live value) — that is the bug class.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, appUsers, appointments } from '../db';
import { getTimezone } from '../lib/settings';
import { getAppointment, getOpportunity, listContactConversations, listConversationMessages } from '../lib/ghl/client';
import type { GhlConversationMessage } from '../lib/ghl/schemas';
import { readDryRun } from '../lib/companion/config';
import { getCompanionWriteCount, hasWriteKey, updateOpportunity } from '../lib/companion/ghlWrite';
import { readOutcomeCatalogue } from '../lib/companion/outcomeService';
import { outcomesFor } from '../lib/companion/outcomes';
import { isNoopOpportunityPatch } from '../lib/companion/patch';
import { readContactPosition, readMirrorAppointment } from '../lib/companion/logDb';
import { executeLog, type CallContext } from '../lib/companion/log';
import { callTypeOf } from '../lib/companion/calendars';
import type { CurrentUser } from '../lib/auth/currentUser';
import type { CompanionStepRecord } from '../db';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

// ---- pure helpers (tested in tests/companion-stage5.test.ts) ---------------------------------------------------

/** The guard: only a contact whose name says "test" (case-insensitive) may be written to by this script. */
export function isTestContactName(name: string | null | undefined): boolean {
  return /test/i.test(name ?? '');
}

export interface LiveBefore {
  pipelineId: string | null;
  stageId: string | null;
  status: string | null;
  appointmentStatus: string | null;
}

/** A sent request whose body equals the live state it was sent against — the Bridget shape. */
export function isNoopRequest(name: 'stage' | 'appointment' | 'note', request: NonNullable<CompanionStepRecord['request']>, live: LiveBefore): boolean {
  if (name === 'stage') return isNoopOpportunityPatch(request.body as { pipelineId?: string; pipelineStageId?: string; status?: 'open' | 'won' | 'lost' }, live);
  if (name === 'appointment') return (request.body as { appointmentStatus?: string }).appointmentStatus === live.appointmentStatus;
  return false;
}

export function messageAtMs(m: GhlConversationMessage): number | null {
  const t = m.dateAdded ? Date.parse(m.dateAdded) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Outbound messages dated inside [fromMs, toMs]. */
export function messagesInWindow(messages: readonly GhlConversationMessage[], fromMs: number, toMs: number): GhlConversationMessage[] {
  return messages.filter((m) => {
    const t = messageAtMs(m);
    return t !== null && t >= fromMs && t <= toMs && (m.direction ?? 'outbound').toLowerCase() === 'outbound';
  });
}

/** "12:28 PM · email · (Watch This) Before Your Consult! · workflow abc123" — the workflow column only when GHL carries one. */
export function summarizeMessage(m: GhlConversationMessage, timezone: string): string {
  const t = messageAtMs(m);
  const when = t === null ? '?' : new Date(t).toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const channel = (m.messageType ?? (typeof m.type === 'string' ? m.type : m.type !== null && m.type !== undefined ? `type ${m.type}` : null) ?? '?').replace(/^TYPE_/, '').toLowerCase();
  const text = (m.subject?.trim() || (m.body ?? '').split('\n').find((l) => l.trim())?.trim() || '(no text)').slice(0, 70);
  const extra = m as Record<string, unknown>;
  const workflowKeys = Object.keys(extra).filter((k) => /workflow/i.test(k));
  const metaWorkflow = m.meta ? Object.entries(m.meta).filter(([k]) => /workflow/i.test(k)) : [];
  const workflow = [...workflowKeys.map((k) => `${k}=${JSON.stringify(extra[k])}`), ...metaWorkflow.map(([k, v]) => `meta.${k}=${JSON.stringify(v)}`)].join(' ');
  return `${when} · ${channel} · ${text}${m.source ? ` · source ${m.source}` : ''}${workflow ? ` · ${workflow}` : ''}`;
}

// ---- the run --------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readLive(opportunityId: string, eventId: string | null): Promise<LiveBefore & { error: string | null }> {
  const o = await getOpportunity(opportunityId);
  const a = eventId ? await getAppointment(eventId) : null;
  return {
    pipelineId: o.opportunity?.pipelineId ?? null,
    stageId: o.opportunity?.pipelineStageId ?? null,
    status: o.opportunity?.status ?? null,
    appointmentStatus: a?.appointment?.appointmentStatus ?? null,
    error: o.error ?? a?.error ?? null,
  };
}

async function outboundSince(contactId: string, fromMs: number, toMs: number, timezone: string): Promise<{ lines: string[]; error: string | null }> {
  const convs = await listContactConversations(contactId);
  if (convs.error) {
    const scope = /401|403|scope/i.test(convs.error) ? ' — the read key needs the conversations.readonly + conversations/message.readonly scopes (GoHighLevel → Private Integrations → Scopes); re-run after adding them' : '';
    return { lines: [], error: `${convs.error}${scope}` };
  }
  const lines: string[] = [];
  for (const c of convs.conversations) {
    const r = await listConversationMessages(c.id, 50);
    if (r.error) return { lines, error: r.error };
    for (const m of messagesInWindow(r.messages, fromMs, toMs)) lines.push(summarizeMessage(m, timezone));
  }
  return { lines: lines.sort(), error: null };
}

async function main() {
  const contactId = arg('contact');
  if (!contactId || !process.argv.includes('--i-understand-this-writes')) {
    console.error('Usage: npm run companion:parity -- --contact <ghl contact id> --i-understand-this-writes [--outcomes a,b] [--event <id>] [--wait 90] [--user <email>]\nThis script WRITES to GoHighLevel (a TEST contact only). It refuses to start without the flag.');
    process.exit(2);
  }
  const waitSec = Math.max(5, Number(arg('wait') ?? 90));
  if (!(await hasWriteKey())) {
    console.error('Refusing: no Companion write key saved (Setup → Companion).');
    process.exit(2);
  }
  const position = await readContactPosition(contactId);
  if (!isTestContactName(position.name)) {
    console.error(`Refusing: "${position.name}" (${contactId}) is not a test contact — the name must contain "test" (case-insensitive). Nothing was written.`);
    process.exit(2);
  }
  if (!position.pipeline || !position.opportunity) {
    console.error(`Refusing: ${position.name} has no opportunity in the followed pipeline${position.pipeline ? ` ${position.pipeline.name}` : ''} in the mirror — run a GHL sync first.`);
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
  const saved = await readDryRun();

  // The call: --event, else the contact's newest mirrored appointment.
  let call: CallContext | null = null;
  const eventId = arg('event') ?? (await db.select({ id: appointments.ghlEventId }).from(appointments).where(and(eq(appointments.ghlContactId, contactId), sql`${appointments.startTime} is not null`)).orderBy(desc(appointments.startTime)).limit(1))[0]?.id ?? null;
  if (eventId) {
    const m = await readMirrorAppointment(eventId);
    if (m) call = { eventId, ghlStatus: m.ghlStatus, startIso: m.startIso, callType: callTypeOf(m.calendarName, m.title), calendarName: m.calendarName };
  }
  const cat = await readOutcomeCatalogue();
  const callType = call?.callType ?? 'Other';
  const wanted = arg('outcomes')?.split(',').map((s) => s.trim()).filter(Boolean) ?? outcomesFor(callType, cat.defs).map((d) => d.key);
  const oppId = position.opportunity.id;
  const start = await readLive(oppId, eventId);
  if (start.error || !start.stageId) {
    console.error(`Refusing: GoHighLevel could not be read before starting: ${start.error ?? 'no stage'}.`);
    process.exit(2);
  }
  const stageName = (id: string | null) => cat.ctx.stages.find((s) => s.id === id)?.name ?? id ?? '—';
  console.log(`Parity · ${position.name} (${contactId}) · ${position.pipeline.name} · starts in ${stageName(start.stageId)} (${start.status}) · appointment ${eventId ?? 'none'} (${start.appointmentStatus ?? 'n/a'}, ${callType}) · as ${user.name} · wait ${waitSec}s`);
  console.log(`Saved dry-run setting: ${saved.on ? 'ON' : 'OFF'} — this process forces it OFF for its own logs and never changes the setting. Appointment updates in Setup: ${cat.appointmentUpdates ? 'ON' : 'OFF'}.`);
  console.log(`Outcomes: ${wanted.join(', ')}`);

  type Row = { outcome: string; requests: string[]; messages: string[]; noop: number; note: string };
  const table: Row[] = [];
  const deps = { dryRun: async () => ({ on: false, invalidValue: null }) };
  let seq = 0;
  const windowEnd = () => Date.now() + 2_000; // GHL timestamps are seconds-grained; a small margin.

  for (const key of wanted) {
    const row: Row = { outcome: key, requests: [], messages: [], noop: 0, note: '' };
    table.push(row);
    const live = await readLive(oppId, eventId);
    if (live.error) {
      row.note = `GHL unreadable: ${live.error}`;
      continue;
    }
    const t0 = Date.now() - 1_000;
    const r = await executeLog({ ghlContactId: contactId, call, outcome: { key }, note: `Parity test ${key} — ${new Date().toISOString()}`, user, timezone, requestId: `parity-${Date.now()}-${++seq}`, expectedStageId: live.stageId, acceptedStageId: live.stageId }, deps);
    if (!r.ok) {
      row.note = `log refused: ${r.status} ${r.error}`;
      console.log(`\n${key}: ${row.note}`);
      continue;
    }
    for (const name of ['stage', 'appointment', 'note'] as const) {
      const s = r.action.steps[name];
      if (!s) continue;
      if (s.request && (s.status === 'ok' || s.status === 'failed')) {
        const noop = isNoopRequest(name, s.request, live);
        if (noop) row.noop += 1;
        row.requests.push(`${s.request.method} ${s.request.path} ${JSON.stringify(s.request.body).slice(0, 160)} → ${s.status}${s.httpStatus ? ` ${s.httpStatus}` : ''}${noop ? ' ⚑ NO-OP BODY' : ''}`);
      } else row.requests.push(`${name}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`);
    }
    console.log(`\n${key} · state ${r.action.state}${r.action.error ? ` · ${r.action.error}` : ''}`);
    for (const line of row.requests) console.log(`    ${line}`);
    console.log(`    waiting ${waitSec}s for GHL's automations…`);
    await sleep(waitSec * 1000);
    const msgs = await outboundSince(contactId, t0, windowEnd(), timezone);
    row.messages = msgs.error ? [`unavailable: ${msgs.error}`] : msgs.lines;
    console.log(`    messages GHL sent: ${msgs.error ? `unavailable — ${msgs.error}` : msgs.lines.length === 0 ? 'none' : ''}`);
    for (const line of msgs.lines) console.log(`      ${line}`);

    // Restore the stage (+ deal status) — a real move; its automations may fire, so its window is listed too.
    const now = await readLive(oppId, eventId);
    const t1 = Date.now() - 1_000;
    const restore = await updateOpportunity(oppId, { pipelineStageId: start.stageId, ...(start.status === 'open' || start.status === 'won' || start.status === 'lost' || start.status === 'abandoned' ? { status: start.status } : {}) }, { dryRun: false, live: { pipelineId: now.pipelineId, stageId: now.stageId, status: now.status } });
    const restoreLine = restore.status === 'skipped' ? `restore: nothing to restore (already in ${stageName(start.stageId)})` : `restore: ${restore.request.method} ${restore.request.path} ${JSON.stringify(restore.request.body)} → ${restore.status}${restore.httpStatus ? ` ${restore.httpStatus}` : ''}${restore.error ? ` — ${restore.error}` : ''} (a move back to ${stageName(start.stageId)} — may trigger that stage's automations)`;
    row.requests.push(restoreLine);
    console.log(`    ${restoreLine}`);
    if (restore.status !== 'skipped') {
      await sleep(waitSec * 1000);
      const after = await outboundSince(contactId, t1, windowEnd(), timezone);
      const lines = after.error ? [`unavailable: ${after.error}`] : after.lines;
      row.messages.push(...lines.map((l) => `(restore) ${l}`));
      console.log(`    messages after the restore: ${after.error ? `unavailable — ${after.error}` : lines.length === 0 ? 'none' : ''}`);
      for (const line of lines) console.log(`      ${line}`);
    }
  }

  const final = await readLive(oppId, eventId);
  console.log(`\n${'outcome'.padEnd(28)} ${'requests sent'.padEnd(60)} messages GHL sent`);
  for (const row of table) {
    const sent = row.requests.filter((l) => / → /.test(l) && !l.startsWith('restore')).length;
    console.log(`${row.outcome.padEnd(28)} ${`${sent} write(s)${row.noop ? ` · ${row.noop} NO-OP` : ''}${row.note ? ` · ${row.note}` : ''}`.padEnd(60)} ${row.messages.filter((m) => !m.startsWith('(restore)')).length} (+${row.messages.filter((m) => m.startsWith('(restore)')).length} after restore)`);
    for (const l of row.requests) console.log(`    ${l}`);
    for (const m of row.messages) console.log(`      ✉ ${m}`);
  }
  const noops = table.reduce((n, r) => n + r.noop, 0);
  console.log(`\nGHL writes sent by this process: ${getCompanionWriteCount()} · contact ends in ${stageName(final.stageId)} (${final.status}) · appointment ${final.appointmentStatus ?? 'n/a'} · no-op bodies: ${noops}`);
  process.exit(noops > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith('companion-parity.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
