-- Phase G item 4: the funnel is the "[new] Application Pipeline" only.
-- Follow it by default; every other real (GHL-mirrored) pipeline stays
-- imported but unfollowed. Demo pipelines are untouched so demo mode renders.
UPDATE "pipelines" SET "is_tracked" = false, "updated_at" = now() WHERE "origin" = 'ghl' AND "id" <> 'UR5P3vNTm9VPuYZFrb6c';--> statement-breakpoint
UPDATE "pipelines" SET "is_tracked" = true, "updated_at" = now() WHERE "id" = 'UR5P3vNTm9VPuYZFrb6c';
