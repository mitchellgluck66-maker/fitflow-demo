ALTER TABLE "contacts" ADD COLUMN "fbclid" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "gclid" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "session_source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "attribution_url" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "attribution_class" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "attribution_reason" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "attribution_class_source" text DEFAULT 'auto' NOT NULL;