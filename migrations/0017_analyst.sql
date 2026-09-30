-- FitFlow Analyst (docs/plan-analyst-2026-09-30.md, Wave 1). Five new tables, additive only — safe for the
-- deployed code, which never reads them. One shared history: created_by is nullable and unused.
CREATE TABLE "analyst_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"text" text NOT NULL,
	"tokens" integer,
	"data_through" date NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyst_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"seq" integer NOT NULL,
	"turn_id" text,
	"role" text NOT NULL,
	"api_json" text NOT NULL,
	"display" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyst_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'owner' NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analyst_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"answer_mode" text NOT NULL,
	"created_by" text,
	"brief_hash" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_turn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analyst_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"client_turn_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"question" text NOT NULL,
	"kind" text DEFAULT 'ask' NOT NULL,
	"page_context" jsonb,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"usage" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"cost_estimated" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "analyst_messages" ADD CONSTRAINT "analyst_messages_thread_id_analyst_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."analyst_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_turns" ADD CONSTRAINT "analyst_turns_thread_id_analyst_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."analyst_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analyst_messages_seq_uidx" ON "analyst_messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "analyst_turns_client_uidx" ON "analyst_turns" USING btree ("thread_id","client_turn_id");--> statement-breakpoint
CREATE INDEX "analyst_turns_thread_idx" ON "analyst_turns" USING btree ("thread_id","started_at");
--> statement-breakpoint
-- Deny-all to the PostgREST roles like every table (C2, migration 0009; tests/rls.test.ts).
ALTER TABLE "analyst_briefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analyst_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analyst_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analyst_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analyst_messages" ENABLE ROW LEVEL SECURITY;
