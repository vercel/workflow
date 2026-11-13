-- Set while an orchestrator delivery is owed to a run; startup recovery skips
-- a parked run only when it is clear. Rows that exist before this migration
-- start set, so their next completed delivery decides, and new rows start
-- clear. Neither statement rewrites the table. `IF NOT EXISTS` because two
-- `bootstrap` processes started together can both apply a migration.
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "wake_pending" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "wake_pending" SET DEFAULT false;
