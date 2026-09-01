ALTER TABLE "pipelines" ALTER COLUMN "is_tracked" SET DEFAULT false;--> statement-breakpoint
-- Real (GHL-mirrored) pipelines start unfollowed: Jake's account carries 15
-- pipelines / 107 stages and only the followed ones should drive dashboards,
-- metrics and digests. Demo pipelines stay followed so demo mode still renders.
UPDATE "pipelines" SET "is_tracked" = false WHERE "origin" = 'ghl';
