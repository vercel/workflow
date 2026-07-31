-- Event ids and step ids are unique per run, not globally. Under slot identity
-- (spec 6) every run numbers its own log from 1, so "evnt_0...001" and
-- "step_0...001" exist once per run and the old global primary keys would make
-- the second run to reach slot 1 collide with the first.
--
-- The run leads both keys so the existing run-scoped range scans stay a single
-- index seek; that also makes the standalone run_id indexes redundant.
ALTER TABLE "workflow"."workflow_events" DROP CONSTRAINT IF EXISTS "workflow_events_pkey";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD CONSTRAINT "workflow_events_run_id_id_pk" PRIMARY KEY("run_id","id");--> statement-breakpoint
DROP INDEX IF EXISTS "workflow"."workflow_events_run_id_index";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" DROP CONSTRAINT IF EXISTS "workflow_steps_pkey";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ADD CONSTRAINT "workflow_steps_run_id_step_id_pk" PRIMARY KEY("run_id","step_id");--> statement-breakpoint
DROP INDEX IF EXISTS "workflow"."workflow_steps_run_id_index";
