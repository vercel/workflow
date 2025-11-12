-- Drop deprecated error columns from workflow_runs table
-- Error data is now stored as JSON in the error column
ALTER TABLE "workflow_runs" DROP COLUMN IF EXISTS "error_code";
--> statement-breakpoint

-- Drop deprecated error columns from workflow_steps table
ALTER TABLE "workflow_steps" DROP COLUMN IF EXISTS "error_code";
