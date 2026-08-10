-- Event ids become per-run slot positions (`evnt_` + a zero-padded decimal),
-- so an id is only unique together with its run. Runs created before this keep
-- their globally-unique ULIDs, which the composite key also admits.
--
-- LOCKING. Replacing a primary key takes ACCESS EXCLUSIVE on
-- `workflow.workflow_events`, which blocks reads as well as writes, and the
-- migrator runs every pending migration in one transaction, so the lock is held
-- until all of them commit. Building the new key's index under that lock is the
-- part that grows with the table. On an empty or modest table this is
-- instantaneous and needs no thought.
--
-- On a large existing table, build the index first, outside the migrator, and
-- this migration adopts it instead of building its own:
--
--   CREATE UNIQUE INDEX CONCURRENTLY "workflow_events_run_id_id_idx"
--     ON "workflow"."workflow_events" ("run_id", "id");
--
-- `CONCURRENTLY` cannot appear in this file: Postgres rejects it inside a
-- transaction block. Run it by hand, confirm the index came out valid, then
-- migrate. The branch below picks it up, and the exclusive lock then covers
-- only a catalog update rather than a full build.
ALTER TABLE "workflow"."workflow_events" DROP CONSTRAINT "workflow_events_pkey";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'workflow'
      AND c.relname = 'workflow_events_run_id_id_idx'
      AND c.relkind = 'i'
      AND i.indisunique
      AND i.indisvalid
  ) THEN
    ALTER TABLE "workflow"."workflow_events"
      ADD CONSTRAINT "workflow_events_run_id_id_pk"
      PRIMARY KEY USING INDEX "workflow_events_run_id_id_idx";
  ELSE
    ALTER TABLE "workflow"."workflow_events"
      ADD CONSTRAINT "workflow_events_run_id_id_pk" PRIMARY KEY ("run_id","id");
  END IF;
END $$;--> statement-breakpoint
-- Redundant once the primary key leads with `run_id`: that index serves every
-- by-run lookup and range scan this one did, so keeping it only costs a second
-- write per event on the table's hottest path.
DROP INDEX IF EXISTS "workflow"."workflow_events_run_id_index";--> statement-breakpoint
-- One row per slot-numbered run. Its absence is the "this run predates slots"
-- signal, so no backfill: existing runs stay on ULIDs for the rest of their
-- lives. A marker only: positions are allocated by the insert that occupies
-- them, read from the event log itself.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_event_slots" (
	"run_id" varchar PRIMARY KEY NOT NULL
);
