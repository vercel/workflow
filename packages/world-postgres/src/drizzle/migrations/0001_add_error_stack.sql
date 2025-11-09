-- Add errorStack column to workflow_runs table
ALTER TABLE "workflow_runs" ADD COLUMN "error_stack" text;
--> statement-breakpoint

-- Add errorStack column to workflow_steps table
ALTER TABLE "workflow_steps" ADD COLUMN "error_stack" text;
