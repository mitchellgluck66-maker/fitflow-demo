/**
 * GoHighLevel API v2 types.
 *
 * Enum strings here are taken verbatim from the GHL API reference. They are
 * case- and spelling-sensitive: it is `noshow` (one word, no hyphen) and
 * `cancelled` (double L). Getting these wrong fails silently in some endpoints,
 * so they are centralised here rather than inlined at call sites.
 */

/**
 * Full appointmentStatus enum as published in the Create/Update schemas.
 *
 * Note: `completed` and `active` exist in the API schema but have NO counterpart
 * in the GHL UI or workflow triggers - writing them produces a status staff
 * cannot see or filter on. We deliberately never write those two.
 */
export type GhlAppointmentStatus =
  | 'new'
  | 'confirmed'
  | 'cancelled'
  | 'showed'
  | 'noshow'
  | 'invalid'
  | 'completed' // schema-only, do not write
  | 'active'; // schema-only, do not write

/** The subset that is safe to write from an attendance dashboard. */
export const WRITABLE_APPOINTMENT_STATUSES = [
  'showed',
  'noshow',
  'cancelled',
  'invalid',
] as const satisfies readonly GhlAppointmentStatus[];

export type GhlOpportunityStatus = 'open' | 'won' | 'lost' | 'abandoned';

export interface GhlAppointment {
  id: string;
  address?: string;
  title?: string;
  calendarId: string;
  contactId: string;
  groupId?: string;
  appointmentStatus: GhlAppointmentStatus;
  assignedUserId?: string;
  users?: string[];
  notes?: string;
  source?: string;
  /** ISO 8601 WITH offset, e.g. "2023-09-25T16:00:00+05:30" - never assume UTC. */
  startTime: string;
  endTime: string;
  dateAdded?: string;
  dateUpdated?: string;
}

export interface GhlCalendar {
  id: string;
  name: string;
  /** Appointment "type" is modelled as calendar identity in GHL. */
  calendarType?:
    | 'round_robin'
    | 'event'
    | 'class_booking'
    | 'collective'
    | 'service_booking'
    | 'personal';
  groupId?: string;
  locationId?: string;
  isActive?: boolean;
}

export interface GhlPipelineStage {
  id: string;
  name: string;
  position?: number;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: GhlPipelineStage[];
  locationId?: string;
}

export interface GhlOpportunity {
  id: string;
  name: string;
  pipelineId: string;
  pipelineStageId: string;
  status: GhlOpportunityStatus;
  monetaryValue?: number;
  /** Opportunities use `assignedTo`; appointments use `assignedUserId`. */
  assignedTo?: string;
  contactId: string;
  source?: string;
}

export interface GhlNote {
  id: string;
  body: string;
  userId?: string;
  contactId?: string;
  dateAdded?: string;
}

/** Errors surfaced from the GHL API, carrying enough context to retry. */
export class GhlApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GhlApiError';
  }

  /** 429 and 5xx are transient; 4xx generally means the payload is wrong. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
