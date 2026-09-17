ALTER TABLE "ad_spend" ADD COLUMN "reach" integer;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "frequency" real;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "cpm_cents" integer;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "cpc_cents" integer;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "link_clicks" integer;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "landing_page_views" integer;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "purchases" integer;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "actions" jsonb;