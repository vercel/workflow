-- Event ids become per-run slot positions (`evnt_` + a zero-padded decimal),
-- so an id is only unique together with its run. Runs created before this keep
-- their globally-unique ULIDs, which the composite key also admits.
ALTER TABLE "workflow"."workflow_events" DROP CONSTRAINT "workflow_events_pkey";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD CONSTRAINT "workflow_events_run_id_id_pk" PRIMARY KEY ("run_id","id");--> statement-breakpoint
-- One row per slot-numbered run. Its absence is the "this run predates slots"
-- signal, so no backfill: existing runs stay on ULIDs for the rest of their
-- lives. A marker only: positions are allocated by the insert that occupies
-- them, read from the event log itself.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_event_slots" (
	"run_id" varchar PRIMARY KEY NOT NULL
);
