import { NextRequest, NextResponse } from 'next/server';
import { db, appointments, leads, leadEvents, ghlSyncQueue } from '@/db';
import { eq, and, inArray } from 'drizzle-orm';
import {
  buildSyncOperations,
  describeOutcomeEffects,
  resolveNextStage,
  OUTCOME_LABELS,
  type Outcome,
} from '@/lib/ghl/mapping';
import { getGhlConfig } from '@/lib/ghl/config';
import { getSetting, SETTING_KEYS } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const VALID_OUTCOMES: Outcome[] = ['booked', 'no_show', 'not_continuing'];

/**
 * POST /api/appointments/[id]/outcome
 * Body: { outcome: 'booked'|'no_show'|'not_continuing', notes?, markedBy? }
 *
 * Marks attendance. This does four things atomically-ish from the user's point
 * of view:
 *   1. Records the outcome on the appointment
 *   2. Advances the lead's local pipeline stage
 *   3. Writes an immutable audit event
 *   4. Enqueues the GHL write-back operations (drained at midnight)
 *
 * Re-marking is allowed - a mis-click before midnight replaces the queued
 * operations rather than stacking a second contradictory set on top.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const outcome = body.outcome as Outcome;

    if (!VALID_OUTCOMES.includes(outcome)) {
      return NextResponse.json(
        { error: `outcome must be one of: ${VALID_OUTCOMES.join(', ')}` },
        { status: 400 },
      );
    }

    const rows = await db
      .select()
      .from(appointments)
      .innerJoin(leads, eq(appointments.leadId, leads.id))
      .where(eq(appointments.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Appointment not found' }, { status: 404 });
    }

    const appointment = rows[0].appointments;
    const lead = rows[0].leads;

    const markedBy = body.markedBy ?? appointment.assignedTo ?? 'staff';
    const now = new Date().toISOString();
    const config = await getGhlConfig();

    // --- Clear any previously queued (unsent) operations for this appointment.
    // If someone marked "No Show" then corrects it to "Booked" at 4pm, only the
    // corrected version should ever reach GHL.
    await db
      .delete(ghlSyncQueue)
      .where(
        and(
          eq(ghlSyncQueue.appointmentId, id),
          inArray(ghlSyncQueue.status, ['pending', 'failed']),
        ),
      );

    // --- 1. Record the outcome
    await db
      .update(appointments)
      .set({
        outcome,
        outcomeNotes: body.notes ?? null,
        outcomeMarkedAt: now,
        outcomeMarkedBy: markedBy,
        ghlAppointmentStatus: outcome === 'no_show' ? 'noshow' : 'showed',
        syncStatus: 'queued',
        updatedAt: now,
      })
      .where(eq(appointments.id, id));

    // --- 2. Advance the local pipeline stage
    const priorStage = lead.stage;
    const nextStage = resolveNextStage(priorStage, outcome);

    if (nextStage && nextStage !== priorStage) {
      await db
        .update(leads)
        .set({
          stage: nextStage,
          lastActionAt: now,
          updatedAt: now,
          appointmentStatus: outcome === 'no_show' ? 'no_show' : 'attended',
          ...(appointment.type === 'Consult'
            ? { consultOutcome: OUTCOME_LABELS[outcome] }
            : { roadmapOutcome: OUTCOME_LABELS[outcome] }),
        })
        .where(eq(leads.id, lead.id));
    }

    // --- 3. Immutable audit event
    await db.insert(leadEvents).values({
      leadId: lead.id,
      action:
        outcome === 'booked'
          ? 'MarkAttended'
          : outcome === 'no_show'
            ? 'MarkNoShow'
            : 'MarkNotContinuing',
      priorStage,
      newStage: nextStage ?? priorStage,
      appointmentStatus: outcome === 'no_show' ? 'noshow' : 'showed',
      actor: markedBy,
      notes: body.notes ?? `${OUTCOME_LABELS[outcome]} - ${appointment.type}`,
      metadata: JSON.stringify({
        appointmentId: id,
        appointmentType: appointment.type,
        outcome,
      }),
      syncStatus: 'local',
      createdAt: now,
    });

    // --- 4. Queue the GHL write-back
    const stageMapRaw = await getSetting(SETTING_KEYS.ghlStageMap);
    let stageMap: Record<string, string> = {};
    try {
      stageMap = stageMapRaw ? (JSON.parse(stageMapRaw) as Record<string, string>) : {};
    } catch {
      stageMap = {};
    }

    const operations = buildSyncOperations({
      outcome,
      appointmentType: appointment.type,
      leadName: `${lead.firstName} ${lead.lastName}`,
      currentStage: priorStage,
      markedBy,
      markedAt: now,
      notes: body.notes,
      ghl: {
        eventId: appointment.ghlEventId,
        contactId: appointment.ghlContactId,
        opportunityId: appointment.ghlOpportunityId,
        pipelineId: await getSetting(SETTING_KEYS.ghlPipelineId),
        nextStageId: nextStage ? (stageMap[nextStage] ?? null) : null,
        userId: appointment.ghlAssignedUserId,
      },
      notifyOnWrite: config.notifyOnWrite,
    });

    if (operations.length > 0) {
      await db.insert(ghlSyncQueue).values(
        operations.map((op) => ({
          appointmentId: id,
          leadId: lead.id,
          operation: op.operation,
          endpoint: op.endpoint,
          method: op.method,
          payload: JSON.stringify(op.payload),
          sequence: op.sequence,
          status: 'pending' as const,
          createdAt: now,
        })),
      );
    }

    return NextResponse.json({
      ok: true,
      appointmentId: id,
      outcome,
      label: OUTCOME_LABELS[outcome],
      priorStage,
      newStage: nextStage ?? priorStage,
      stageChanged: Boolean(nextStage && nextStage !== priorStage),
      queuedOperations: operations.length,
      dryRun: config.dryRun,
      // Shown in the confirmation toast so staff see the downstream effect.
      effects: describeOutcomeEffects(outcome, priorStage),
      operations: operations.map((op) => ({
        operation: op.operation,
        description: op.description,
        endpoint: op.endpoint,
        method: op.method,
        payload: op.payload,
      })),
    });
  } catch (error) {
    console.error('Failed to mark outcome:', error);
    return NextResponse.json(
      { error: 'Failed to mark outcome', detail: String(error) },
      { status: 500 },
    );
  }
}

/** DELETE - clear an outcome (undo a mis-click). */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const now = new Date().toISOString();

    await db
      .delete(ghlSyncQueue)
      .where(
        and(
          eq(ghlSyncQueue.appointmentId, id),
          inArray(ghlSyncQueue.status, ['pending', 'failed']),
        ),
      );

    await db
      .update(appointments)
      .set({
        outcome: null,
        outcomeNotes: null,
        outcomeMarkedAt: null,
        outcomeMarkedBy: null,
        syncStatus: 'pending',
        updatedAt: now,
      })
      .where(eq(appointments.id, id));

    return NextResponse.json({ ok: true, appointmentId: id, cleared: true });
  } catch (error) {
    console.error('Failed to clear outcome:', error);
    return NextResponse.json(
      { error: 'Failed to clear outcome', detail: String(error) },
      { status: 500 },
    );
  }
}
