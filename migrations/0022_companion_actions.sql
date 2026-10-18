-- Onboarding Companion stage 2 (docs/plan-companion-stage2.md, item 5): one row per outcome log — the request id
-- that makes a double-click harmless, the position before and after (what undo restores), each GoHighLevel step's
-- result as it completes (status code + body), the state and the undo. APPEND-ONLY: no code path deletes a row.
-- Additive: the deployed code never reads it. RLS on, no policies (C2).
CREATE TABLE "companion_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"ghl_user_id" text,
	"ghl_event_id" text,
	"ghl_contact_id" text NOT NULL,
	"contact_id" text,
	"client_name" text NOT NULL,
	"ghl_opportunity_id" text,
	"pipeline_id" text,
	"call_type" text NOT NULL,
	"call_start_at" timestamp with time zone,
	"outcome_key" text NOT NULL,
	"label" text NOT NULL,
	"note" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"undo_steps" jsonb,
	"state" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" text
);
--> statement-breakpoint
ALTER TABLE "companion_actions" ADD CONSTRAINT "companion_actions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_actions_request_uidx" ON "companion_actions" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX "companion_actions_event_idx" ON "companion_actions" USING btree ("ghl_event_id");
--> statement-breakpoint
CREATE INDEX "companion_actions_contact_idx" ON "companion_actions" USING btree ("ghl_contact_id");
--> statement-breakpoint
CREATE INDEX "companion_actions_created_idx" ON "companion_actions" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "companion_actions" ENABLE ROW LEVEL SECURITY;
