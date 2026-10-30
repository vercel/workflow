-- The `jobPrefix` of the World that created each run, which scopes startup
-- recovery. `IF NOT EXISTS` because two `bootstrap` processes started together
-- can both apply a migration.
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "job_prefix" varchar;
