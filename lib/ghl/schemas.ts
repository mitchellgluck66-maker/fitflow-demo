/**
 * Zod schemas for every GoHighLevel response we consume (CLAUDE.md rule 7).
 *
 * Deliberately permissive on unknown keys (`.passthrough()` is not used, but
 * Zod strips extras by default) and permissive on optional fields — the docs
 * are incomplete and real responses carry undocumented fields. What we DO
 * insist on is the identity fields we key rows by. If those are missing the
 * row is rejected and counted, rather than inserted with a null key.
 *
 * Quirks encoded here: `noshow` is one word, `cancelled` is double-L.
 */

import { z } from 'zod';

export const GhlAppointmentStatusSchema = z.enum([
  'new',
  'confirmed',
  'cancelled',
  'showed',
  'noshow',
  'invalid',
  'completed',
  'active',
]);
export type GhlAppointmentStatus = z.infer<typeof GhlAppointmentStatusSchema>;

export const GhlOpportunityStatusSchema = z.enum(['open', 'won', 'lost', 'abandoned']);
export type GhlOpportunityStatus = z.infer<typeof GhlOpportunityStatusSchema>;

/** ISO-ish datetime string; GHL mixes `Z` and `+05:30` offsets. */
const dateString = z.string().min(1);
const optionalString = z.string().nullish();

export const GhlPipelineStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  position: z.number().nullish(),
});

export const GhlPipelineSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  locationId: optionalString,
  stages: z.array(GhlPipelineStageSchema).default([]),
});
export type GhlPipeline = z.infer<typeof GhlPipelineSchema>;

export const GhlPipelinesResponseSchema = z.object({
  pipelines: z.array(GhlPipelineSchema).default([]),
});

/** Contact summary embedded in opportunity search results. */
export const GhlEmbeddedContactSchema = z.object({
  id: z.string().min(1),
  name: optionalString,
  companyName: optionalString,
  email: optionalString,
  phone: optionalString,
  tags: z.array(z.string()).nullish(),
});

export const GhlOpportunitySchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  pipelineId: z.string().min(1),
  pipelineStageId: z.string().min(1),
  status: z.string().default('open'),
  monetaryValue: z.number().nullish(),
  assignedTo: optionalString,
  contactId: z.string().min(1),
  source: optionalString,
  createdAt: optionalString,
  updatedAt: optionalString,
  lastStageChangeAt: optionalString,
  lastStatusChangeAt: optionalString,
  contact: GhlEmbeddedContactSchema.nullish(),
});
export type GhlOpportunity = z.infer<typeof GhlOpportunitySchema>;

export const GhlOpportunitySearchResponseSchema = z.object({
  opportunities: z.array(z.unknown()).default([]),
  meta: z
    .object({
      total: z.number().nullish(),
      nextPage: z.number().nullish(),
      nextPageUrl: optionalString,
      startAfterId: optionalString,
      startAfter: z.number().nullish(),
    })
    .nullish(),
});

export const GhlCalendarSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  calendarType: optionalString,
  groupId: optionalString,
  locationId: optionalString,
  isActive: z.boolean().nullish(),
});
export type GhlCalendar = z.infer<typeof GhlCalendarSchema>;

export const GhlCalendarsResponseSchema = z.object({
  calendars: z.array(GhlCalendarSchema).default([]),
});

export const GhlAppointmentSchema = z.object({
  id: z.string().min(1),
  title: optionalString,
  calendarId: z.string().min(1),
  contactId: z.string().min(1),
  groupId: optionalString,
  appointmentStatus: z.string().nullish(),
  assignedUserId: optionalString,
  users: z.array(z.string()).nullish(),
  notes: optionalString,
  source: optionalString,
  startTime: dateString,
  endTime: optionalString,
  dateAdded: optionalString,
  dateUpdated: optionalString,
});
export type GhlAppointment = z.infer<typeof GhlAppointmentSchema>;

export const GhlEventsResponseSchema = z.object({
  events: z.array(z.unknown()).default([]),
});

export const GhlContactSchema = z.object({
  id: z.string().min(1),
  firstName: optionalString,
  lastName: optionalString,
  name: optionalString,
  contactName: optionalString,
  email: optionalString,
  phone: optionalString,
  source: optionalString,
  tags: z.array(z.string()).nullish(),
  assignedTo: optionalString,
  dateAdded: optionalString,
  dateUpdated: optionalString,
  attributionSource: z
    .object({
      utmSource: optionalString,
      utmMedium: optionalString,
      utmCampaign: optionalString,
      utmContent: optionalString,
      sessionSource: optionalString,
      medium: optionalString,
      url: optionalString,
    })
    .nullish(),
  attributions: z
    .array(
      z.object({
        utmSource: optionalString,
        utmMedium: optionalString,
        utmCampaign: optionalString,
        utmContent: optionalString,
        sessionSource: optionalString,
        medium: optionalString,
        isFirst: z.boolean().nullish(),
      }),
    )
    .nullish(),
  customFields: z.array(z.object({ id: z.string(), value: z.unknown() })).nullish(),
});
export type GhlContact = z.infer<typeof GhlContactSchema>;

export const GhlContactResponseSchema = z.object({ contact: GhlContactSchema });

export const GhlUserSchema = z.object({
  id: z.string().min(1),
  name: optionalString,
  firstName: optionalString,
  lastName: optionalString,
  email: optionalString,
});
export const GhlUsersResponseSchema = z.object({ users: z.array(GhlUserSchema).default([]) });

/**
 * Parse a list of loosely-typed items, keeping the valid ones and reporting the
 * rest. Used for the big collections (opportunities, events) where one odd row
 * should not fail a whole sync.
 */
export function parseMany<T>(
  schema: z.ZodType<T>,
  items: unknown[],
  label: string,
): { valid: T[]; rejected: number; warnings: string[] } {
  const valid: T[] = [];
  let rejected = 0;
  const warnings: string[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      rejected += 1;
      if (warnings.length < 3) {
        const id =
          item && typeof item === 'object' && 'id' in item
            ? String((item as { id: unknown }).id)
            : '?';
        warnings.push(`${label} ${id} failed validation: ${result.error.issues[0]?.message}`);
      }
    }
  }
  if (rejected > 3) warnings.push(`${label}: ${rejected} rows rejected in total`);
  return { valid, rejected, warnings };
}
