-- Onboarding Companion stage 1 (docs/plan-companion-stage1.md, item 1): per-person logins replace the single shared
-- password. Additive — a new table the deployed code never reads; APP_PASSWORD keeps working as the owner login.
-- password_hash is scrypt ("scrypt$N=16384,r=8,p=1$<salt>$<hash>", lib/auth/password.ts); preferences holds the
-- Companion's per-user calendar filter, timezone and auto-advance (item 4). RLS on, no policies (C2).
CREATE TABLE "app_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"ghl_user_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_email_uidx" ON "app_users" (lower("email"));
--> statement-breakpoint
ALTER TABLE "app_users" ENABLE ROW LEVEL SECURITY;
