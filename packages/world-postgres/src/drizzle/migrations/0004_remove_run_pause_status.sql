-- Update any paused runs to cancelled
UPDATE "workflow"."workflow_runs" SET "status" = 'cancelled' WHERE "status" = 'paused';
--> statement-breakpoint
-- Create new enum type without 'paused'
CREATE TYPE "public"."status_new" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');
--> statement-breakpoint
-- Alter column to use new type
ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "status" TYPE "public"."status_new" USING "status"::text::"public"."status_new";
--> statement-breakpoint
-- Drop old enum type
DROP TYPE "public"."status";
--> statement-breakpoint
-- Rename new enum type to original name
ALTER TYPE "public"."status_new" RENAME TO "status";
