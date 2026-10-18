/**
 * Companion stage 2 — the request bodies of the log routes, validated at the boundary (Zod).
 */

import { z } from 'zod';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'a GoHighLevel id');
const CallTypeSchema = z.enum(['Consult', 'Roadmap', 'Other']);

export const CallContextSchema = z.object({
  eventId: Id,
  ghlStatus: z.string().max(40).nullable().default(null),
  startIso: z.string().max(40).nullable().default(null),
  callType: CallTypeSchema.nullable().default(null),
  calendarName: z.string().max(200).nullable().default(null),
});

export const OutcomeChoiceSchema = z.union([
  z.object({ key: z.string().min(1).max(60) }),
  z.object({ move: z.object({ stageId: Id, appointment: z.enum(['showed', 'noshow', 'cancelled', 'leave']) }) }),
]);

export const PlanBodySchema = z.object({
  contact: Id,
  call: CallContextSchema.nullable().default(null),
  outcome: OutcomeChoiceSchema,
  note: z.string().max(4000),
});

export const ExecuteBodySchema = PlanBodySchema.extend({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, 'requestId must be 8–80 url-safe characters'),
  expectedStageId: Id.nullable().default(null),
  acceptedStageId: Id.nullable().optional(),
});

export function firstIssue(error: z.ZodError): string {
  const i = error.issues[0];
  return i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'invalid body';
}
