/**
 * Outcome -> GoHighLevel write-back mapping.
 *
 * This is the answer to "what else should this sheet affect in GHL". Marking one
 * appointment is never a single write: it touches the calendar event, the
 * opportunity's pipeline position, the contact's tags, and the audit note.
 *
 * Design rules baked in here:
 *
 *  1. The appointment status write is AUTHORITATIVE and always sequence 0.
 *     GHL has no cross-endpoint transactions, so if later steps fail the
 *     appointment is still correctly marked and the rest can be retried.
 *
 *  2. We never write attribution fields. GHL does not expose them for writing at
 *     all (there is a standing open feature request for it), which conveniently
 *     means a contact update cannot clobber first-touch attribution. We also
 *     never send `source` or a `tags` array on a contact update, both of which
 *     WOULD overwrite existing data.
 *
 *  3. Tags go through the dedicated add/remove endpoints, never the contact PUT.
 *
 *  4. Every outcome produces a note, so the GHL-side record explains itself
 *     without anyone needing to open this dashboard.
 */

import type { GhlAppointmentStatus, GhlOpportunityStatus } from './types';

/** The three buttons a staff member sees on the Today View. */
export type Outcome = 'booked' | 'no_show' | 'not_continuing';

export const OUTCOME_LABELS: Record<Outcome, string> = {
  booked: 'Booked',
  no_show: 'No Show',
  not_continuing: 'Not Continuing',
};

export const OUTCOME_DESCRIPTIONS: Record<Outcome, string> = {
  booked: 'Attended and booked the next step',
  no_show: 'Did not attend',
  not_continuing: 'Attended but is not moving forward',
};

/** A single queued GHL API call. */
export interface SyncOperation {
  operation:
    | 'update_appointment_status'
    | 'create_appointment_note'
    | 'update_opportunity_stage'
    | 'update_opportunity_status'
    | 'add_contact_tag'
    | 'remove_contact_tag';
  endpoint: string;
  method: 'POST' | 'PUT' | 'DELETE';
  payload: Record<string, unknown>;
  sequence: number;
  /** Human-readable line shown in the dry-run preview. */
  description: string;
}

/**
 * Pipeline progression.
 *
 * Local stage names mirror the client's GHL pipeline. `nextOnBooked` is where a
 * lead moves when they attend AND book the following appointment - which is what
 * "Booked" means in this workflow.
 */
export const STAGE_TRANSITIONS: Record<
  string,
  {
    nextOnBooked: string | null;
    nextOnNoShow: string | null;
    nextOnNotContinuing: string | null;
  }
> = {
  Applied: {
    nextOnBooked: 'Consult Booked',
    nextOnNoShow: null,
    nextOnNotContinuing: null,
  },
  'Consult Booked': {
    nextOnBooked: 'Pre-Roadmap Booked',
    nextOnNoShow: 'Consult No Show',
    nextOnNotContinuing: null, // stays put; opportunity is marked lost instead
  },
  'Consult No Show': {
    // A rebooked no-show that then attends goes straight back on track.
    nextOnBooked: 'Pre-Roadmap Booked',
    nextOnNoShow: 'Consult No Show',
    nextOnNotContinuing: null,
  },
  'Pre-Roadmap Booked': {
    nextOnBooked: 'Enrolled',
    nextOnNoShow: 'Roadmap No Show',
    nextOnNotContinuing: 'Roadmap Completed: Objection',
  },
  'Roadmap No Show': {
    nextOnBooked: 'Enrolled',
    nextOnNoShow: 'Roadmap No Show',
    nextOnNotContinuing: 'Roadmap Completed: Objection',
  },
  'Roadmap Completed: Objection': {
    nextOnBooked: 'Enrolled',
    nextOnNoShow: null,
    nextOnNotContinuing: null,
  },
  Enrolled: {
    nextOnBooked: null,
    nextOnNoShow: null,
    nextOnNotContinuing: null,
  },
};

/** Outcome -> GHL appointmentStatus. Exact enum strings, lowercase, no hyphens. */
export const OUTCOME_TO_APPOINTMENT_STATUS: Record<Outcome, GhlAppointmentStatus> = {
  // They turned up, so the calendar event is `showed` regardless of whether they
  // went on to book the next step.
  booked: 'showed',
  no_show: 'noshow',
  not_continuing: 'showed',
};

/** Outcome -> opportunity status. Only "not continuing" closes the opportunity. */
export const OUTCOME_TO_OPPORTUNITY_STATUS: Record<Outcome, GhlOpportunityStatus | null> = {
  booked: null, // stays open, just moves stage
  no_show: null, // stays open - a no-show is recoverable
  not_continuing: 'lost',
};

/**
 * Tags applied in GHL so the outcome is filterable in smart lists and, more
 * importantly, usable as a workflow trigger.
 *
 * These are treated as MUTUALLY EXCLUSIVE STATE, not as an accumulating log.
 * Marking a new outcome removes the tags that no longer apply before adding
 * the ones that do.
 *
 * Why that matters: if tags only ever accumulated, someone who no-showed in
 * March and then attended and rebooked in April would permanently carry
 * `fitflow-no-show`. Any workflow triggered on that tag would keep firing at a
 * client who has already converted - i.e. "sorry we missed you" emails to
 * someone who is now enrolled. The audit log and appointment notes hold the
 * history; the tags hold the current state.
 */
export const OUTCOME_TO_TAGS: Record<Outcome, string[]> = {
  booked: ['fitflow-attended', 'fitflow-booked-next'],
  no_show: ['fitflow-no-show'],
  not_continuing: ['fitflow-attended', 'fitflow-not-continuing'],
};

/** Every tag this app owns. Anything here is safe for the app to remove. */
export const ALL_OUTCOME_TAGS: string[] = Array.from(
  new Set(Object.values(OUTCOME_TO_TAGS).flat()),
);

/** Tags to strip when moving to `outcome` - the ones that no longer describe them. */
export function tagsToRemoveFor(outcome: Outcome): string[] {
  const keep = new Set(OUTCOME_TO_TAGS[outcome]);
  return ALL_OUTCOME_TAGS.filter((t) => !keep.has(t));
}

export function resolveNextStage(
  currentStage: string,
  outcome: Outcome,
): string | null {
  const transitions = STAGE_TRANSITIONS[currentStage];
  if (!transitions) return null;

  switch (outcome) {
    case 'booked':
      return transitions.nextOnBooked;
    case 'no_show':
      return transitions.nextOnNoShow;
    case 'not_continuing':
      return transitions.nextOnNotContinuing;
  }
}

export interface BuildOperationsInput {
  outcome: Outcome;
  appointmentType: string;
  leadName: string;
  currentStage: string;
  markedBy: string;
  markedAt: string;
  notes?: string;
  ghl: {
    eventId?: string | null;
    contactId?: string | null;
    opportunityId?: string | null;
    pipelineId?: string | null;
    /** Resolved GHL stage UUID for the destination stage, if known. */
    nextStageId?: string | null;
    /** GHL user id of the staff member, so the note is attributed to a human. */
    userId?: string | null;
    lostReasonId?: string | null;
  };
  notifyOnWrite: boolean;
}

/**
 * Build the ordered list of GHL calls for one marked appointment.
 * Operations referencing ids we don't have yet are skipped rather than queued
 * with nulls - the queue only ever contains calls that can actually succeed.
 */
export function buildSyncOperations(input: BuildOperationsInput): SyncOperation[] {
  const ops: SyncOperation[] = [];
  const { outcome, ghl } = input;

  // --- 1. Appointment status (authoritative, must land first) -------------
  if (ghl.eventId) {
    const status = OUTCOME_TO_APPOINTMENT_STATUS[outcome];
    ops.push({
      operation: 'update_appointment_status',
      endpoint: `/calendars/events/appointments/${ghl.eventId}`,
      method: 'PUT',
      payload: { appointmentStatus: status, toNotify: input.notifyOnWrite },
      sequence: 0,
      description: `Set appointment status to "${status}"`,
    });
  }

  // --- 2. Audit note ------------------------------------------------------
  const noteBody = [
    `${OUTCOME_LABELS[outcome]} - ${input.appointmentType} with ${input.leadName}`,
    `Marked by ${input.markedBy} at ${input.markedAt} via FitFlow dashboard.`,
    input.notes ? `Notes: ${input.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  if (ghl.eventId) {
    ops.push({
      operation: 'create_appointment_note',
      endpoint: `/calendars/appointments/${ghl.eventId}/notes`,
      method: 'POST',
      payload: { body: noteBody, ...(ghl.userId ? { userId: ghl.userId } : {}) },
      sequence: 1,
      description: 'Attach attendance note to the appointment',
    });
  } else if (ghl.contactId) {
    // Fall back to a contact note when we have no calendar event to hang it on.
    ops.push({
      operation: 'create_appointment_note',
      endpoint: `/contacts/${ghl.contactId}/notes`,
      method: 'POST',
      payload: { body: noteBody, ...(ghl.userId ? { userId: ghl.userId } : {}) },
      sequence: 1,
      description: 'Attach attendance note to the contact',
    });
  }

  // --- 3. Pipeline movement ----------------------------------------------
  const nextStage = resolveNextStage(input.currentStage, outcome);
  if (nextStage && ghl.opportunityId && ghl.pipelineId && ghl.nextStageId) {
    ops.push({
      operation: 'update_opportunity_stage',
      endpoint: `/opportunities/${ghl.opportunityId}`,
      method: 'PUT',
      payload: {
        pipelineId: ghl.pipelineId,
        pipelineStageId: ghl.nextStageId,
      },
      sequence: 2,
      description: `Move opportunity ${input.currentStage} -> ${nextStage}`,
    });
  }

  // --- 4. Opportunity status (close-out) ----------------------------------
  const oppStatus = OUTCOME_TO_OPPORTUNITY_STATUS[outcome];
  if (oppStatus && ghl.opportunityId) {
    ops.push({
      operation: 'update_opportunity_status',
      endpoint: `/opportunities/${ghl.opportunityId}/status`,
      method: 'PUT',
      payload: {
        status: oppStatus,
        ...(ghl.lostReasonId ? { lostReasonId: ghl.lostReasonId } : {}),
      },
      sequence: 3,
      description: `Set opportunity status to "${oppStatus}"`,
    });
  } else if (outcome === 'booked' && nextStage === 'Enrolled' && ghl.opportunityId) {
    ops.push({
      operation: 'update_opportunity_status',
      endpoint: `/opportunities/${ghl.opportunityId}/status`,
      method: 'PUT',
      payload: { status: 'won' },
      sequence: 3,
      description: 'Set opportunity status to "won" (enrolled)',
    });
  }

  // --- 5. Tags ------------------------------------------------------------
  // Remove-then-add, so the contact carries exactly one outcome state.
  // Both go through the dedicated tag endpoints - a `tags` array on a contact
  // PUT would replace the ENTIRE tag set and wipe tags owned by other systems.
  if (ghl.contactId) {
    const stale = tagsToRemoveFor(outcome);
    if (stale.length > 0) {
      ops.push({
        operation: 'remove_contact_tag',
        endpoint: `/contacts/${ghl.contactId}/tags`,
        method: 'DELETE',
        payload: { tags: stale },
        sequence: 4,
        description: `Clear stale tags: ${stale.join(', ')}`,
      });
    }

    const tags = OUTCOME_TO_TAGS[outcome];
    ops.push({
      operation: 'add_contact_tag',
      endpoint: `/contacts/${ghl.contactId}/tags`,
      method: 'POST',
      payload: { tags },
      sequence: 5,
      description: `Add tags: ${tags.join(', ')}`,
    });
  }

  return ops.sort((a, b) => a.sequence - b.sequence);
}

/**
 * Human-readable preview of everything an outcome will do in GHL.
 * Rendered in the Today View so staff can see the downstream effect before the
 * midnight job runs, and shown in dry-run mode in place of a real response.
 */
export function describeOutcomeEffects(
  outcome: Outcome,
  currentStage: string,
): string[] {
  const effects: string[] = [];
  const status = OUTCOME_TO_APPOINTMENT_STATUS[outcome];

  effects.push(`Appointment marked "${status}" in GoHighLevel`);

  const nextStage = resolveNextStage(currentStage, outcome);
  if (nextStage && nextStage !== currentStage) {
    effects.push(`Pipeline stage: ${currentStage} → ${nextStage}`);
  } else {
    effects.push(`Pipeline stage unchanged (${currentStage})`);
  }

  const oppStatus = OUTCOME_TO_OPPORTUNITY_STATUS[outcome];
  if (oppStatus) {
    effects.push(`Opportunity closed as "${oppStatus}"`);
  } else if (outcome === 'booked' && nextStage === 'Enrolled') {
    effects.push('Opportunity closed as "won"');
  }

  const stale = tagsToRemoveFor(outcome);
  effects.push(`Tags set: ${OUTCOME_TO_TAGS[outcome].join(', ')}`);
  if (stale.length > 0) {
    effects.push(`Stale tags cleared: ${stale.join(', ')}`);
  }
  effects.push('Audit note written to the appointment');

  return effects;
}
