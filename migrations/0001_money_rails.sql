ALTER TABLE "ad_spend" ADD COLUMN "level" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "adset_id" text;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "adset_name" text;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "ad_id" text;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "ad_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "match_source" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "interval_months" integer;