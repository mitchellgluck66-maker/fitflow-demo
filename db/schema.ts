/**
 * FitFlow v2 schema — Supabase Postgres via Drizzle.
 *
 * Design rules baked in (see CLAUDE.md):
 *   - Every row that mirrors an external system is keyed by its EXTERNAL id and
 *     carries `source`, `syncedAt` and `backfilled`. Re-running any sync is a
 *     no-op upsert, never a duplicate.
 *   - Every row also carries `origin` ('demo' | 'ghl' | 'meta' | 'google' |
 *     'stripe' | 'manual'). Anything fabricated is 'demo' and the UI shows the
 *     sample-data banner while any such row exists.
 *   - Pipelines and stages are read from GoHighLevel each sync — nothing about
 *     Miranda's pipeline is hard-coded. Stages get a *semantic role* so the
 *     metrics engine can reason about "applied → consult → roadmap → enrolled"
 *     no matter what the stages are actually called this month.
 *   - Nothing in here is ever written back to an external system.
 */

import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

export const SEMANTIC_ROLES = [
  'applied',
  'consult_booked',
  'consult_noshow',
  'roadmap_booked',
  'roadmap_showed',
  'enrolled',
  'other',
] as const;
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

export type Origin = 'demo' | 'ghl' | 'meta' | 'google' | 'stripe' | 'manual';

/** Provenance columns every externally-sourced row must carry. */
const provenance = {
  /** Which system this row was read from ('ghl', 'meta', 'stripe', 'manual', 'demo'). */
  source: text('source').notNull(),
  /** When our sync last observed this row. */
  syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  /** True when the row was imported by a historical backfill rather than a live delta sync. */
  backfilled: boolean('backfilled').notNull().default(false),
  /** demo | ghl | meta | google | stripe | manual — see CLAUDE.md rule 6. */
  origin: text('origin').notNull().default('ghl'),
};

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------
// Pipelines & stages (dynamic — mirrored from GHL every sync)
// ---------------------------------------------------------------------------

export const pipelines = pgTable('pipelines', {
  /** GHL pipeline id (external id IS the primary key). */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  locationId: text('location_id'),
  /** Only tracked pipelines feed the funnel. Multi-pipeline from day one. */
  isTracked: boolean('is_tracked').notNull().default(true),
  position: integer('position'),
  /** Set when a pipeline disappears from GHL; rows are never deleted. */
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  ...provenance,
  ...timestamps,
});

export const stages = pgTable(
  'stages',
  {
    /** GHL stage id (a UUID scoped to its pipeline). */
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position'),
    /** applied | consult_booked | consult_noshow | roadmap_booked | roadmap_showed | enrolled | other */
    semanticRole: text('semantic_role').$type<SemanticRole>(),
    /**
     * How the role was decided:
     *   manual   — a human picked it in Setup (never overwritten by sync)
     *   auto     — the similarity mapper was confident (≥ threshold)
     *   unmapped — the mapper was NOT confident; surfaced in sync-health for a human
     */
    roleSource: text('role_source').notNull().default('unmapped'),
    /** Mapper confidence 0..1 for the suggested role, kept for the review UI. */
    roleConfidence: real('role_confidence'),
    /** Mapper's best guess, even when below threshold — shown as a suggestion. */
    suggestedRole: text('suggested_role').$type<SemanticRole>(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    ...provenance,
    ...timestamps,
  },
  (t) => [index('stages_pipeline_idx').on(t.pipelineId)],
);

// ---------------------------------------------------------------------------
// Contacts (a GHL contact + its opportunity in a tracked pipeline)
// ---------------------------------------------------------------------------

export const contacts = pgTable(
  'contacts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    // External identity
    ghlContactId: text('ghl_contact_id').notNull(),
    ghlOpportunityId: text('ghl_opportunity_id'),

    // Current pipeline position (as of the last sync)
    pipelineId: text('pipeline_id').references(() => pipelines.id, { onDelete: 'set null' }),
    stageId: text('stage_id').references(() => stages.id, { onDelete: 'set null' }),
    opportunityStatus: text('opportunity_status'), // open | won | lost | abandoned
    opportunityName: text('opportunity_name'),
    monetaryValueCents: integer('monetary_value_cents').default(0),
    lastStageChangeAt: timestamp('last_stage_change_at', { withTimezone: true, mode: 'date' }),

    // Identity
    firstName: text('first_name').notNull().default(''),
    lastName: text('last_name').notNull().default(''),
    email: text('email'),
    phone: text('phone'),
    /** Lower-cased / E.164-ish keys for ad-click ↔ contact ↔ Stripe joins. */
    emailNormalized: text('email_normalized'),
    phoneNormalized: text('phone_normalized'),

    // Attribution (read from GHL; never written back)
    attributionSource: text('attribution_source'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    entryFunnel: text('entry_funnel'),

    assignedUserId: text('assigned_user_id'),
    ownerName: text('owner_name'),
    tags: jsonb('tags').$type<string[]>().default([]),

    /** When the contact/opportunity was created in GHL — the "applied" moment. */
    ghlCreatedAt: timestamp('ghl_created_at', { withTimezone: true, mode: 'date' }),
    ghlUpdatedAt: timestamp('ghl_updated_at', { withTimezone: true, mode: 'date' }),

    ...provenance,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('contacts_ghl_contact_uidx').on(t.ghlContactId),
    uniqueIndex('contacts_ghl_opportunity_uidx').on(t.ghlOpportunityId),
    index('contacts_stage_idx').on(t.stageId),
    index('contacts_email_norm_idx').on(t.emailNormalized),
    index('contacts_phone_norm_idx').on(t.phoneNormalized),
  ],
);

// ---------------------------------------------------------------------------
// Appointments (GHL calendar events)
// ---------------------------------------------------------------------------

export const appointments = pgTable(
  'appointments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    ghlEventId: text('ghl_event_id').notNull(),
    ghlCalendarId: text('ghl_calendar_id'),
    calendarName: text('calendar_name'),
    ghlContactId: text('ghl_contact_id'),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    ghlOpportunityId: text('ghl_opportunity_id'),

    /** Consult | Roadmap | Follow-Up | Check-In — inferred from the calendar name. */
    type: text('type').notNull().default('Consult'),
    title: text('title'),

    startTime: timestamp('start_time', { withTimezone: true, mode: 'date' }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true, mode: 'date' }),
    /** Business timezone in effect when the row was synced. */
    timezone: text('timezone').notNull().default('America/New_York'),

    assignedUserId: text('assigned_user_id'),
    assignedTo: text('assigned_to'),

    /** GHL's own enum, verbatim: new|confirmed|showed|noshow|cancelled|invalid */
    ghlStatus: text('ghl_status').notNull().default('confirmed'),
    /**
     * Derived, read-only outcome for the metrics engine:
     *   showed | no_show | cancelled | null (still upcoming / unknown).
     * Nobody marks this in FitFlow — it mirrors what Miranda records in GHL.
     */
    outcome: text('outcome'),

    ghlCreatedAt: timestamp('ghl_created_at', { withTimezone: true, mode: 'date' }),
    ghlUpdatedAt: timestamp('ghl_updated_at', { withTimezone: true, mode: 'date' }),

    ...provenance,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('appointments_ghl_event_uidx').on(t.ghlEventId),
    index('appointments_start_idx').on(t.startTime),
    index('appointments_contact_idx').on(t.contactId),
  ],
);

// ---------------------------------------------------------------------------
// Stage transitions — derived by diffing consecutive syncs
// ---------------------------------------------------------------------------

export const stageTransitions = pgTable(
  'stage_transitions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    ghlOpportunityId: text('ghl_opportunity_id'),
    pipelineId: text('pipeline_id').references(() => pipelines.id, { onDelete: 'set null' }),
    /** Null for the first time we ever saw the opportunity. */
    fromStageId: text('from_stage_id'),
    toStageId: text('to_stage_id'),
    fromRole: text('from_role').$type<SemanticRole>(),
    toRole: text('to_role').$type<SemanticRole>(),
    /**
     * Best-known instant of the move. GHL's `lastStageChangeAt` when present,
     * otherwise the sync that first observed the new stage.
     */
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The previous sync's timestamp — a lower bound on when the move happened. */
    previousObservedAt: timestamp('previous_observed_at', { withTimezone: true, mode: 'date' }),
    /** initial | diff | backfill */
    kind: text('kind').notNull().default('diff'),
    syncRunId: text('sync_run_id'),
    ...provenance,
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('transitions_contact_idx').on(t.contactId),
    index('transitions_observed_idx').on(t.observedAt),
    index('transitions_to_stage_idx').on(t.toStageId),
  ],
);

// ---------------------------------------------------------------------------
// Nightly stage snapshots (counts per stage per day — powers time-in-stage)
// ---------------------------------------------------------------------------

export const stageSnapshots = pgTable(
  'stage_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Business-local calendar date of the snapshot. */
    snapshotDate: date('snapshot_date').notNull(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    stageId: text('stage_id')
      .notNull()
      .references(() => stages.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(0),
    ...provenance,
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('snapshots_day_stage_uidx').on(t.snapshotDate, t.stageId)],
);

// ---------------------------------------------------------------------------
// Ad spend (Meta / Google / manual weekly entry)
// ---------------------------------------------------------------------------

export const adSpend = pgTable(
  'ad_spend',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** meta | google | manual */
    platform: text('platform').notNull(),
    /**
     * External row key: `${platform}:${campaignId}:${date}` for API rows,
     * `manual:${platform}:${weekStart}` for hand-entered weekly spend.
     */
    externalId: text('external_id').notNull(),
    accountId: text('account_id'),
    campaignId: text('campaign_id'),
    campaignName: text('campaign_name'),
    /** Business-local calendar date the spend applies to. */
    date: date('date').notNull(),
    spendCents: integer('spend_cents').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    impressions: integer('impressions'),
    clicks: integer('clicks'),
    leads: integer('leads'),
    enteredBy: text('entered_by'),
    notes: text('notes'),
    ...provenance,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ad_spend_external_uidx').on(t.externalId),
    index('ad_spend_date_idx').on(t.date),
  ],
);

// ---------------------------------------------------------------------------
// Payments (Stripe)
// ---------------------------------------------------------------------------

export const payments = pgTable(
  'payments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Stripe charge / payment_intent / invoice id. */
    stripeId: text('stripe_id').notNull(),
    stripeCustomerId: text('stripe_customer_id'),
    /** charge | subscription | invoice | refund */
    kind: text('kind').notNull().default('charge'),
    status: text('status').notNull(), // succeeded | failed | refunded | pending
    amountCents: integer('amount_cents').notNull().default(0),
    refundedCents: integer('refunded_cents').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    email: text('email'),
    emailNormalized: text('email_normalized'),
    phoneNormalized: text('phone_normalized'),
    /** Resolved by identity join (email/phone) — null until matched. */
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    description: text('description'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ...provenance,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payments_stripe_uidx').on(t.stripeId),
    index('payments_paid_at_idx').on(t.paidAt),
    index('payments_contact_idx').on(t.contactId),
  ],
);

// ---------------------------------------------------------------------------
// Email digests (Reports archive) & AI reports
// ---------------------------------------------------------------------------

export const emailDigests = pgTable('email_digests', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  /** daily_todo | weekly | monthly */
  kind: text('kind').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
  subject: text('subject').notNull(),
  html: text('html').notNull(),
  textBody: text('text_body'),
  /** sent | skipped_empty | failed */
  status: text('status').notNull().default('sent'),
  resendId: text('resend_id'),
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const aiReports = pgTable('ai_reports', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  /** insight | weekly_narrative | remap_suggestion */
  kind: text('kind').notNull(),
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  pipelineId: text('pipeline_id'),
  model: text('model'),
  /** Hash of the metrics input so identical inputs reuse the cached report. */
  inputHash: text('input_hash'),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Sync runs & incidents (sync-health)
// ---------------------------------------------------------------------------

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** ghl_delta | ghl_backfill | meta_spend | google_spend | stripe | snapshot */
    kind: text('kind').notNull(),
    /** cron | manual | webhook */
    trigger: text('trigger').notNull().default('manual'),
    /** running | succeeded | failed */
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    /** Delta window lower bound this run used. */
    since: timestamp('since', { withTimezone: true, mode: 'date' }),
    requestsUsed: integer('requests_used').notNull().default(0),
    stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    error: text('error'),
  },
  (t) => [index('sync_runs_kind_started_idx').on(t.kind, t.startedAt)],
);

export const syncIncidents = pgTable('sync_incidents', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  syncRunId: text('sync_run_id').references(() => syncRuns.id, { onDelete: 'set null' }),
  /** error | silence | unmapped_stage | spend_gap | schema_drift */
  kind: text('kind').notNull(),
  /** info | warning | critical */
  severity: text('severity').notNull().default('warning'),
  message: text('message').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Settings (credentials + config; see CLAUDE.md rule 5)
// ---------------------------------------------------------------------------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  /** True for credentials — never returned unmasked. */
  isSecret: boolean('is_secret').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// DORMANT: legacy write-back outbox. Only lib/ghl/sync.ts (behind
// ENABLE_WRITEBACK, hard-off) reads or writes it. Kept so the dormant code
// still type-checks; nothing in the read-only app touches it.
// ---------------------------------------------------------------------------

export const ghlSyncQueue = pgTable('ghl_sync_queue', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  appointmentId: text('appointment_id'),
  contactId: text('contact_id'),
  operation: text('operation').notNull(),
  endpoint: text('endpoint').notNull(),
  method: text('method').notNull().default('PUT'),
  payload: text('payload').notNull(),
  sequence: integer('sequence').notNull().default(0),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  responseBody: text('response_body'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;
export type Stage = typeof stages.$inferSelect;
export type NewStage = typeof stages.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type StageTransition = typeof stageTransitions.$inferSelect;
export type NewStageTransition = typeof stageTransitions.$inferInsert;
export type StageSnapshot = typeof stageSnapshots.$inferSelect;
export type AdSpend = typeof adSpend.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type EmailDigest = typeof emailDigests.$inferSelect;
export type AiReport = typeof aiReports.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
export type SyncIncident = typeof syncIncidents.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type GhlSyncQueueItem = typeof ghlSyncQueue.$inferSelect;
