ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "next_event_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "last_event_id" varchar;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "writer_snapshot" varchar;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "writer_base_count" bigint;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD COLUMN "seq" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_run_seq_unique"
	ON "workflow"."workflow_events" ("run_id", "seq");
