CREATE TABLE IF NOT EXISTS "workflow"."workflow_snapshots" (
	"run_id" varchar PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"events_cursor" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
