-- F1 (2026-09-30 rebuild, Ingestion v2): the followed pipeline is refreshed on EVERY run.
-- * ghl_opportunities: every GHL opportunity as GHL has it (reconciler, "applied" dating, re-fetch trigger).
-- * contacts.opportunity_created_at: when the followed-pipeline application was made (F14 groundwork).
-- * The pre-v2 resumable-cycle cursor is cleared: a legacy cursor (index 7, no phase) made the old code skip the
--   followed pipeline and stamp it fresh (F1). v2 never reads ghl_sync_cursor; its only cursor is the weekly
--   mirror pass (ghl_mirror_cursor).
-- Safe for the currently deployed code: additive only; with the cursor cleared the old code starts a fresh cycle
-- (followed pipeline first), which is exactly the refresh production needs.
CREATE TABLE "ghl_opportunities" (
	"id" text PRIMARY KEY NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"contact_id" text,
	"pipeline_id" text NOT NULL,
	"stage_id" text,
	"status" text NOT NULL,
	"name" text,
	"monetary_value_cents" integer DEFAULT 0 NOT NULL,
	"ghl_created_at" timestamp with time zone,
	"ghl_updated_at" timestamp with time zone,
	"last_stage_change_at" timestamp with time zone,
	"last_status_change_at" timestamp with time zone,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'ghl' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "opportunity_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ghl_opportunities" ADD CONSTRAINT "ghl_opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ghl_opps_pipeline_stage_idx" ON "ghl_opportunities" USING btree ("pipeline_id","stage_id","status");--> statement-breakpoint
CREATE INDEX "ghl_opps_contact_idx" ON "ghl_opportunities" USING btree ("ghl_contact_id");--> statement-breakpoint
-- Deny-all to the PostgREST roles like every table (C2, migration 0009).
ALTER TABLE "ghl_opportunities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "settings" SET "value" = '', "updated_at" = now() WHERE "key" = 'ghl_sync_cursor';
