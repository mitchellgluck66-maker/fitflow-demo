CREATE TABLE "ad_spend" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"account_id" text,
	"campaign_id" text,
	"campaign_name" text,
	"date" date NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"leads" integer,
	"entered_by" text,
	"notes" text,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"pipeline_id" text,
	"model" text,
	"input_hash" text,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"ghl_event_id" text NOT NULL,
	"ghl_calendar_id" text,
	"calendar_name" text,
	"ghl_contact_id" text,
	"contact_id" text,
	"ghl_opportunity_id" text,
	"type" text DEFAULT 'Consult' NOT NULL,
	"title" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"assigned_user_id" text,
	"assigned_to" text,
	"ghl_status" text DEFAULT 'confirmed' NOT NULL,
	"outcome" text,
	"ghl_created_at" timestamp with time zone,
	"ghl_updated_at" timestamp with time zone,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"ghl_opportunity_id" text,
	"pipeline_id" text,
	"stage_id" text,
	"opportunity_status" text,
	"opportunity_name" text,
	"monetary_value_cents" integer DEFAULT 0,
	"last_stage_change_at" timestamp with time zone,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"email_normalized" text,
	"phone_normalized" text,
	"attribution_source" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"entry_funnel" text,
	"assigned_user_id" text,
	"owner_name" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"ghl_created_at" timestamp with time zone,
	"ghl_updated_at" timestamp with time zone,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_digests" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text_body" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"resend_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ghl_sync_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"appointment_id" text,
	"contact_id" text,
	"operation" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text DEFAULT 'PUT' NOT NULL,
	"payload" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"response_body" text,
	"scheduled_for" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"stripe_id" text NOT NULL,
	"stripe_customer_id" text,
	"kind" text DEFAULT 'charge' NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"email" text,
	"email_normalized" text,
	"phone_normalized" text,
	"contact_id" text,
	"description" text,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"metadata" jsonb,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location_id" text,
	"is_tracked" boolean DEFAULT true NOT NULL,
	"position" integer,
	"archived_at" timestamp with time zone,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"pipeline_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"ghl_opportunity_id" text,
	"pipeline_id" text,
	"from_stage_id" text,
	"to_stage_id" text,
	"from_role" text,
	"to_role" text,
	"observed_at" timestamp with time zone NOT NULL,
	"previous_observed_at" timestamp with time zone,
	"kind" text DEFAULT 'diff' NOT NULL,
	"sync_run_id" text,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer,
	"semantic_role" text,
	"role_source" text DEFAULT 'unmapped' NOT NULL,
	"role_confidence" real,
	"suggested_role" text,
	"archived_at" timestamp with time zone,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_run_id" text,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"since" timestamp with time zone,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_snapshots" ADD CONSTRAINT "stage_snapshots_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_snapshots" ADD CONSTRAINT "stage_snapshots_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_incidents" ADD CONSTRAINT "sync_incidents_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_external_uidx" ON "ad_spend" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "ad_spend_date_idx" ON "ad_spend" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_ghl_event_uidx" ON "appointments" USING btree ("ghl_event_id");--> statement-breakpoint
CREATE INDEX "appointments_start_idx" ON "appointments" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "appointments_contact_idx" ON "appointments" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_ghl_contact_uidx" ON "contacts" USING btree ("ghl_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_ghl_opportunity_uidx" ON "contacts" USING btree ("ghl_opportunity_id");--> statement-breakpoint
CREATE INDEX "contacts_stage_idx" ON "contacts" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "contacts_email_norm_idx" ON "contacts" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "contacts_phone_norm_idx" ON "contacts" USING btree ("phone_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_stripe_uidx" ON "payments" USING btree ("stripe_id");--> statement-breakpoint
CREATE INDEX "payments_paid_at_idx" ON "payments" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "payments_contact_idx" ON "payments" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_day_stage_uidx" ON "stage_snapshots" USING btree ("snapshot_date","stage_id");--> statement-breakpoint
CREATE INDEX "transitions_contact_idx" ON "stage_transitions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "transitions_observed_idx" ON "stage_transitions" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "transitions_to_stage_idx" ON "stage_transitions" USING btree ("to_stage_id");--> statement-breakpoint
CREATE INDEX "stages_pipeline_idx" ON "stages" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "sync_runs_kind_started_idx" ON "sync_runs" USING btree ("kind","started_at");