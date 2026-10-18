/**
 * Companion stage 2, item 4 — the database side of a log: the contact's current position in the followed pipeline
 * (the `before`), the mirror update after a successful write (so the funnel and the daily to-do see the move
 * before the next hourly sync), its reverse on undo, and the one `companion_action_failed` incident per log.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, appointments, contacts, ghlOpportunities, stageTransitions, stages, syncIncidents, type CompanionAction, type CompanionPosition, type SemanticRole } from '@/db';
import { outcomeFromGhlStatus } from '../ghl/transitions';
import { readFollowedPipeline, type FollowedPipeline } from './outcomeService';
import { readLiveContact } from './mirror';

export const COMPANION_INCIDENT_KIND = 'companion_action_failed';

export interface ContactPosition {
  ghlContactId: string;
  contactId: string | null;
  name: string;
  origin: string;
  inMirror: boolean;
  pipeline: FollowedPipeline | null;
  /** The contact's opportunity in the followed pipeline (open preferred, else the most recently updated). */
  opportunity: { id: string; stageId: string | null; stageName: string | null; status: string } | null;
}

/** The position the plan starts from — the mirror, with a live name for a contact the mirror has not synced. */
export async function readContactPosition(ghlContactId: string, deps: { pipeline?: () => Promise<FollowedPipeline | null>; liveContact?: typeof readLiveContact } = {}): Promise<ContactPosition> {
  const pipeline = await (deps.pipeline ?? readFollowedPipeline)();
  const rows = await db.select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, origin: contacts.origin }).from(contacts).where(eq(contacts.ghlContactId, ghlContactId)).limit(1);
  const c = rows[0];
  let name = c ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || (c.email ?? '') : '';
  if (!c) {
    const live = await (deps.liveContact ?? readLiveContact)(ghlContactId).catch(() => null);
    name = live?.name ?? '';
  }
  if (!name) name = `Contact ${ghlContactId.slice(0, 6)}…`;
  let opportunity: ContactPosition['opportunity'] = null;
  if (pipeline) {
    const opps = await db
      .select({ id: ghlOpportunities.id, stageId: ghlOpportunities.stageId, status: ghlOpportunities.status, updatedAt: ghlOpportunities.ghlUpdatedAt })
      .from(ghlOpportunities)
      .where(and(eq(ghlOpportunities.ghlContactId, ghlContactId), eq(ghlOpportunities.pipelineId, pipeline.id)))
      .orderBy(sql`case when ${ghlOpportunities.status} = 'open' then 0 else 1 end`, desc(ghlOpportunities.ghlUpdatedAt));
    const o = opps[0];
    if (o) opportunity = { id: o.id, stageId: o.stageId, stageName: pipeline.stages.find((s) => s.id === o.stageId)?.name ?? null, status: o.status };
  }
  return { ghlContactId, contactId: c?.id ?? null, name, origin: c?.origin ?? 'ghl', inMirror: Boolean(c), pipeline, opportunity };
}

/** The mirror's row for an event (the appointment's current status and call context when the client sent none). */
export async function readMirrorAppointment(ghlEventId: string): Promise<{ eventId: string; ghlStatus: string; startIso: string; calendarName: string | null; title: string | null } | null> {
  const rows = await db.select({ eventId: appointments.ghlEventId, ghlStatus: appointments.ghlStatus, startTime: appointments.startTime, calendarName: appointments.calendarName, title: appointments.title }).from(appointments).where(eq(appointments.ghlEventId, ghlEventId)).limit(1);
  const r = rows[0];
  return r ? { eventId: r.eventId, ghlStatus: r.ghlStatus, startIso: r.startTime.toISOString(), calendarName: r.calendarName, title: r.title } : null;
}

async function stageNameAndRole(stageId: string | null): Promise<{ name: string | null; role: SemanticRole | null }> {
  if (!stageId) return { name: null, role: null };
  const rows = await db.select({ name: stages.name, role: stages.semanticRole }).from(stages).where(eq(stages.id, stageId)).limit(1);
  return rows[0] ? { name: rows[0].name, role: rows[0].role ?? null } : { name: null, role: null };
}

/**
 * Reflect the steps that SUCCEEDED in GHL into our rows at once. `direction = 'apply'` moves to `after`,
 * `'revert'` back to `before`. A stage change writes one stage_transitions row (kind 'companion', ON CONFLICT DO
 * NOTHING) so the next sync, observing the same state, writes nothing.
 */
export async function applyMirror(row: CompanionAction, direction: 'apply' | 'revert', applied: { stage: boolean; appointment: boolean }, now: Date): Promise<{ contactUpdated: boolean; opportunityUpdated: boolean; appointmentUpdated: boolean; transition: boolean }> {
  const target: CompanionPosition = direction === 'apply' ? row.after : row.before;
  const origin: CompanionPosition = direction === 'apply' ? row.before : row.after;
  const out = { contactUpdated: false, opportunityUpdated: false, appointmentUpdated: false, transition: false };
  if (applied.stage && row.ghlOpportunityId) {
    const stageChanged = target.stageId !== origin.stageId;
    const opp = await db
      .update(ghlOpportunities)
      .set({ stageId: target.stageId, status: target.status ?? 'open', ...(stageChanged ? { lastStageChangeAt: now } : {}), ghlUpdatedAt: now, syncedAt: now })
      .where(eq(ghlOpportunities.id, row.ghlOpportunityId))
      .returning({ id: ghlOpportunities.id });
    out.opportunityUpdated = opp.length > 0;
    const c = await db
      .update(contacts)
      .set({ stageId: target.stageId, opportunityStatus: target.status, ...(stageChanged ? { lastStageChangeAt: now } : {}), updatedAt: now })
      .where(and(eq(contacts.ghlContactId, row.ghlContactId), eq(contacts.ghlOpportunityId, row.ghlOpportunityId)))
      .returning({ id: contacts.id, origin: contacts.origin });
    out.contactUpdated = c.length > 0;
    if (stageChanged && target.stageId && (row.contactId || c[0]?.id)) {
      const [from, to] = await Promise.all([stageNameAndRole(origin.stageId), stageNameAndRole(target.stageId)]);
      const inserted = await db
        .insert(stageTransitions)
        .values({
          contactId: row.contactId ?? c[0].id,
          ghlOpportunityId: row.ghlOpportunityId,
          pipelineId: row.pipelineId,
          fromStageId: origin.stageId,
          toStageId: target.stageId,
          fromRole: from.role,
          toRole: to.role,
          observedAt: now,
          previousObservedAt: null,
          kind: 'companion',
          syncRunId: null,
          source: 'companion',
          origin: c[0]?.origin ?? 'ghl',
          syncedAt: now,
          backfilled: false,
        })
        .onConflictDoNothing()
        .returning({ id: stageTransitions.id });
      out.transition = inserted.length > 0;
    }
  }
  if (applied.appointment && row.ghlEventId && target.appointmentStatus) {
    const a = await db
      .update(appointments)
      .set({ ghlStatus: target.appointmentStatus, outcome: outcomeFromGhlStatus(target.appointmentStatus), ghlUpdatedAt: now, syncedAt: now, updatedAt: now })
      .where(eq(appointments.ghlEventId, row.ghlEventId))
      .returning({ id: appointments.id });
    out.appointmentUpdated = a.length > 0;
  }
  return out;
}

/** ONE open incident per failed log (details.actionId); refreshed while failing, resolved by a retry's success or an undo. */
export async function syncActionIncident(row: CompanionAction, now: Date, failure: { step: string; error: string } | null, resolvedBy?: string): Promise<void> {
  const open = await db.select().from(syncIncidents).where(and(eq(syncIncidents.kind, COMPANION_INCIDENT_KIND), isNull(syncIncidents.resolvedAt)));
  const mine = open.filter((i) => (i.details as { actionId?: string } | null)?.actionId === row.id);
  if (!failure) {
    for (const i of mine) await db.update(syncIncidents).set({ resolvedAt: now, details: { ...(i.details ?? {}), resolvedBy: resolvedBy ?? 'completed' } }).where(eq(syncIncidents.id, i.id));
    return;
  }
  const message = `Companion log failed for ${row.clientName}: ${failure.step} step — ${failure.error} (${row.label}, ${row.userName})`;
  const details = { actionId: row.id, step: failure.step, ghlContactId: row.ghlContactId, ghlEventId: row.ghlEventId, state: row.state };
  if (mine[0]) await db.update(syncIncidents).set({ message, details }).where(eq(syncIncidents.id, mine[0].id));
  else await db.insert(syncIncidents).values({ kind: COMPANION_INCIDENT_KIND, severity: 'warning', message, details, createdAt: now });
}
