/**
 * Companion stage 2 — canned log-panel states for the screenshots (`npm run screenshots -- --companion`), served by
 * GET /api/companion/preview?state= ONLY with COMPANION_PREVIEW=1 outside production. Demo names only; nothing here
 * reads the database or GoHighLevel.
 */

import type { ActionView, LogPlan } from './log';
import type { OutcomesForCall } from './outcomeService';

export const COMPANION_PREVIEW_STATES = ['confirm', 'success', 'partial', 'dryrun'] as const;
export type CompanionPreviewState = (typeof COMPANION_PREVIEW_STATES)[number];

const STAGES = [
  { id: 'demo-stage-consult-booked', name: 'Consult Booked', role: 'consult_booked' },
  { id: 'demo-stage-consult-noshow', name: 'Consult No Show', role: 'consult_noshow' },
  { id: 'demo-stage-roadmap-booked', name: 'Pre-Roadmap Booked', role: 'roadmap_booked' },
  { id: 'demo-stage-enrolled', name: 'Enrolled', role: 'enrolled' },
];

function outcomes(dryRun: boolean): OutcomesForCall {
  return {
    dryRun: { on: dryRun, invalidValue: null },
    callType: 'Consult',
    outcomes: [
      { key: 'consult_showed_booked', label: 'Showed, roadmap booked', stageRole: 'roadmap_booked', toStage: { id: 'demo-stage-roadmap-booked', name: 'Pre-Roadmap Booked' }, appointment: 'showed', opportunityStatus: 'open', unavailable: null },
      { key: 'consult_noshow', label: 'No-show', stageRole: 'consult_noshow', toStage: { id: 'demo-stage-consult-noshow', name: 'Consult No Show' }, appointment: 'noshow', opportunityStatus: 'open', unavailable: null },
      { key: 'consult_reschedule', label: 'Reschedule', stageRole: 'consult_rescheduled', toStage: null, appointment: 'cancelled', opportunityStatus: 'open', unavailable: 'No stage in [demo] Application Pipeline is mapped to the role consult_rescheduled — map it in Setup → Pipelines.' },
      { key: 'consult_cancelled', label: 'Cancelled', stageRole: null, toStage: null, appointment: 'cancelled', opportunityStatus: 'open', unavailable: null },
      { key: 'consult_not_fit', label: 'Not a fit', stageRole: null, toStage: null, appointment: 'showed', opportunityStatus: 'lost', unavailable: null },
    ],
    moveTo: { pipeline: { id: 'demo-pipeline', name: '[demo] Application Pipeline' }, stages: STAGES, appointments: ['showed', 'noshow', 'cancelled', 'leave'] },
  };
}

const NOTE = 'Great energy, wants to start before the holidays. Booked the roadmap for Thursday.';
const START = '2026-10-16T16:00:00.000Z';

function plan(dryRun: boolean): LogPlan {
  return {
    clientName: 'Jordan Rivers',
    callType: 'Consult',
    outcome: { key: 'consult_showed_booked', label: 'Showed, roadmap booked', toStage: { id: 'demo-stage-roadmap-booked', name: 'Pre-Roadmap Booked', role: 'roadmap_booked', position: 3 }, stageRole: 'roadmap_booked', appointment: 'showed', opportunityStatus: 'open' },
    opportunity: { id: 'demo-opp-1', pipelineName: '[demo] Application Pipeline', from: { id: 'demo-stage-consult-booked', name: 'Consult Booked' }, to: { id: 'demo-stage-roadmap-booked', name: 'Pre-Roadmap Booked' }, status: { from: 'open', to: 'open' } },
    appointment: { eventId: 'demo-event-1', from: 'confirmed', to: 'showed', startIso: START, callType: 'Consult' },
    noteText: `Onboarding call · Consult · Oct 16, 10:00 AM · Miranda Demo\nOutcome: Showed, roadmap booked (Consult Booked → Pre-Roadmap Booked)\nNote: ${NOTE}`,
    confirmation: `Move Jordan Rivers from Consult Booked to Pre-Roadmap Booked, mark the 10:00 AM Consult showed, add this note. This may send GoHighLevel messages to the client.${dryRun ? ' Dry run — nothing will be sent.' : ''}`,
    expectedStageId: 'demo-stage-consult-booked',
    dryRun,
    steps: [
      { name: 'stage', request: { method: 'PUT', path: '/opportunities/demo-opp-1', body: { pipelineId: 'demo-pipeline', pipelineStageId: 'demo-stage-roadmap-booked' } }, skipReason: null, summary: 'Stage Consult Booked → Pre-Roadmap Booked' },
      { name: 'appointment', request: { method: 'PUT', path: '/calendars/events/appointments/demo-event-1', body: { appointmentStatus: 'showed' } }, skipReason: null, summary: 'Appointment confirmed → showed' },
      { name: 'note', request: { method: 'POST', path: '/contacts/demo-contact-1/notes', body: { body: '…' } }, skipReason: null, summary: 'Note added to the contact' },
    ],
    before: { stageId: 'demo-stage-consult-booked', stageName: 'Consult Booked', status: 'open', appointmentStatus: 'confirmed' },
    after: { stageId: 'demo-stage-roadmap-booked', stageName: 'Pre-Roadmap Booked', status: 'open', appointmentStatus: 'showed' },
    contactId: 'demo-contact-ff-1',
    pipelineId: 'demo-pipeline',
    callStartAt: START,
  };
}

function action(state: 'ok' | 'partial' | 'dry_run', now: Date): ActionView {
  const p = plan(state === 'dry_run');
  const stepStatus = (name: 'stage' | 'appointment' | 'note'): ActionView['steps'][number]['status'] => (state === 'dry_run' ? 'dry_run' : state === 'ok' ? 'ok' : name === 'stage' ? 'ok' : name === 'appointment' ? 'failed' : 'pending');
  return {
    id: 'demo-action-1',
    state,
    stale: false,
    label: p.outcome.label,
    outcomeKey: p.outcome.key,
    clientName: p.clientName,
    userName: 'Miranda Demo',
    dryRun: state === 'dry_run',
    createdAt: now.toISOString(),
    undoUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
    canUndo: true,
    canRetry: state === 'partial',
    error: state === 'partial' ? 'GHL 422 PUT /calendars/events/appointments/demo-event-1: {"message":"Appointment status cannot be updated for a past event"}' : null,
    failedStep: state === 'partial' ? 'appointment' : null,
    before: p.before,
    after: p.after,
    steps: p.steps.map((s) => ({ name: s.name, status: stepStatus(s.name), summary: s.summary, detail: state === 'partial' && s.name === 'appointment' ? 'GHL 422 PUT /calendars/events/appointments/demo-event-1: {"message":"Appointment status cannot be updated for a past event"}' : state === 'partial' && s.name === 'note' ? 'not attempted — the appointment step failed' : null, httpStatus: stepStatus(s.name) === 'ok' ? 200 : stepStatus(s.name) === 'failed' ? 422 : null, request: s.request })),
    undoSteps: null,
    undoneAt: null,
    undoneBy: null,
  };
}

export function companionPreview(state: string, now: Date = new Date()): { phase: unknown; outcomes: OutcomesForCall; note?: string } | null {
  switch (state) {
    case 'confirm':
      return { phase: { kind: 'confirm', plan: plan(false), requestId: 'preview-request-id-0001', stale: null }, outcomes: outcomes(false), note: NOTE };
    case 'success':
      return { phase: { kind: 'result', action: action('ok', now) }, outcomes: outcomes(false) };
    case 'partial':
      return { phase: { kind: 'result', action: action('partial', now) }, outcomes: outcomes(false) };
    case 'dryrun':
      return { phase: { kind: 'result', action: action('dry_run', now) }, outcomes: outcomes(true) };
    default:
      return null;
  }
}
