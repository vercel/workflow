ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;
