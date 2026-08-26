CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`ghl_event_id` text,
	`ghl_calendar_id` text,
	`ghl_contact_id` text,
	`ghl_opportunity_id` text,
	`type` text DEFAULT 'Consult' NOT NULL,
	`title` text,
	`start_time` text NOT NULL,
	`end_time` text,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`assigned_to` text,
	`ghl_assigned_user_id` text,
	`outcome` text,
	`outcome_notes` text,
	`outcome_marked_at` text,
	`outcome_marked_by` text,
	`ghl_appointment_status` text DEFAULT 'confirmed',
	`sync_status` text DEFAULT 'pending' NOT NULL,
	`synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ghl_sync_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text,
	`lead_id` text,
	`operation` text NOT NULL,
	`endpoint` text NOT NULL,
	`method` text DEFAULT 'PUT' NOT NULL,
	`payload` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`response_body` text,
	`scheduled_for` text,
	`processed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
