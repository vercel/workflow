CREATE TABLE IF NOT EXISTS "workflow"."workflow_queue_payloads" (
  "job_id" varchar PRIMARY KEY NOT NULL,
  "message_id" varchar NOT NULL,
  "run_id" varchar,
  "data" bytea,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_queue_payloads_run_id_index" ON "workflow"."workflow_queue_payloads" ("run_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow"."workflow_terminal_requests" (
  "run_id" varchar PRIMARY KEY NOT NULL REFERENCES "workflow"."workflow_runs"("id") ON DELETE CASCADE,
  "request" bytea NOT NULL
);
