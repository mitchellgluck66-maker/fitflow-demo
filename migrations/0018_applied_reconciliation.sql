-- Applied reconciliation (docs/plan-reconciliation-2026-09-30.md). Two additive tables, recomputed daily from the
-- mirror; safe for the deployed code, which never reads them. Definition-agnostic: facts + class per opportunity,
-- verdicts from lib/reconcile/definitions.ts.
CREATE TABLE "applied_ledger" (
	"key" text PRIMARY KEY NOT NULL,
	"opportunity_id" text,
	"ghl_contact_id" text,
	"contact_id" text,
	"name" text NOT NULL,
	"pipeline_id" text,
	"pipeline_name" text,
	"pipeline_followed" boolean NOT NULL,
	"holds_position" boolean NOT NULL,
	"first_role" text,
	"stage_now" text,
	"contact_source" text,
	"form_source" boolean NOT NULL,
	"contact_created_on" date,
	"contact_created_equals_opportunity" boolean DEFAULT false NOT NULL,
	"opportunity_created_on" date,
	"applied_on" date,
	"moved_in_on" date,
	"parked" boolean DEFAULT false NOT NULL,
	"also_in_followed" boolean DEFAULT false NOT NULL,
	"ledger_on" date NOT NULL,
	"utm_campaign" text,
	"campaign_key" text,
	"class" text NOT NULL,
	"reason" text NOT NULL,
	"verdict_current" boolean,
	"verdict_candidate" boolean,
	"ledger_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applied_ratio_daily" (
	"campaign_id" text NOT NULL,
	"date" date NOT NULL,
	"campaign_name" text NOT NULL,
	"campaign_key" text NOT NULL,
	"meta_day_tz" text NOT NULL,
	"meta_submits" integer,
	"fitflow_applied" integer DEFAULT 0 NOT NULL,
	"fitflow_form_applicants" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applied_ratio_daily_campaign_id_date_pk" PRIMARY KEY("campaign_id","date")
);
--> statement-breakpoint
CREATE INDEX "applied_ledger_on_idx" ON "applied_ledger" USING btree ("ledger_on");--> statement-breakpoint
CREATE INDEX "applied_ledger_campaign_idx" ON "applied_ledger" USING btree ("campaign_key","ledger_on");--> statement-breakpoint
CREATE INDEX "applied_ledger_contact_idx" ON "applied_ledger" USING btree ("ghl_contact_id");--> statement-breakpoint
CREATE INDEX "applied_ratio_key_idx" ON "applied_ratio_daily" USING btree ("campaign_key","date");
--> statement-breakpoint
-- Deny-all to the PostgREST roles like every table (C2, migration 0009; tests/rls.test.ts).
ALTER TABLE "applied_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applied_ratio_daily" ENABLE ROW LEVEL SECURITY;
