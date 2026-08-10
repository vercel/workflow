-- Event ids are unique per run, not globally. Under slot identity (spec 6)
-- every run numbers its own log from 1, so "evnt_0...001" exists once per run
-- and the old global primary key would make the second run to reach slot 1
-- collide with the first.
--
-- The run leads the key so the existing run-scoped range scans stay a single
-- index seek; that also makes the standalone run_id index redundant.
--
-- OPERATORS: this takes ACCESS EXCLUSIVE on workflow_events and holds it while
-- the new primary key's index builds, so reads and writes to the table block
-- for the duration. That is milliseconds on a small deployment and minutes on a
-- large one. It cannot be made concurrent in place: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction, and the migration runner uses one. To avoid
-- the pause on a big table, run the equivalent by hand before migrating —
--
--   CREATE UNIQUE INDEX CONCURRENTLY workflow_events_run_id_id_pk
--     ON workflow.workflow_events (run_id, id);
--   ALTER TABLE workflow.workflow_events
--     DROP CONSTRAINT workflow_events_pkey,
--     ADD CONSTRAINT workflow_events_run_id_id_pk
--       PRIMARY KEY USING INDEX workflow_events_run_id_id_pk;
--
-- and then run the migration, which finds its work already done and skips it.
-- That is what the guard below is for; do not simplify it back to a bare ADD
-- CONSTRAINT.
ALTER TABLE "workflow"."workflow_events" DROP CONSTRAINT IF EXISTS "workflow_events_pkey";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workflow.workflow_events'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE "workflow"."workflow_events"
      ADD CONSTRAINT "workflow_events_run_id_id_pk" PRIMARY KEY("run_id","id");
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "workflow"."workflow_events_run_id_index";
