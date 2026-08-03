-- Event ids are unique per run, not globally. Under slot identity (spec 6)
-- every run numbers its own log from 1, so "evnt_0...001" exists once per run
-- and the old global primary key would make the second run to reach slot 1
-- collide with the first.
--
-- The run leads the key so the existing run-scoped range scans stay a single
-- index seek; that also makes the standalone run_id index redundant.
ALTER TABLE "workflow"."workflow_events" DROP CONSTRAINT IF EXISTS "workflow_events_pkey";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD CONSTRAINT "workflow_events_run_id_id_pk" PRIMARY KEY("run_id","id");--> statement-breakpoint
DROP INDEX IF EXISTS "workflow"."workflow_events_run_id_index";
