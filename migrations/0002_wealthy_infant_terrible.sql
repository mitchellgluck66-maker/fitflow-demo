ALTER TABLE `appointments` ADD `origin` text DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE `appointments` ADD `last_imported_at` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `origin` text DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `ghl_contact_id` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `ghl_opportunity_id` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `ghl_pipeline_id` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `ghl_stage_id` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `last_imported_at` text;