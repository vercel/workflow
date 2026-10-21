-- Atomic `start({ hook })` admission: one immutable accept-or-reject decision
-- per candidate run, written in the transaction that creates an accepted run.
-- `holder_run_id` is the run holding an accepted reservation (the candidate,
-- unless a forced createHook moved it); it holds the token while that run is
-- not terminal or `token_retention_until` is in the future.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_start_hook_admissions" (
	"run_id" varchar PRIMARY KEY NOT NULL,
	"token" varchar NOT NULL,
	"decision" varchar NOT NULL,
	"holder_run_id" varchar,
	"conflicting_run_id" varchar,
	"token_retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_start_hook_admissions_token_index" ON "workflow"."workflow_start_hook_admissions" USING btree ("token");
--> statement-breakpoint
-- The reservation a run was admitted with, echoed on the run.
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "start_hook_cbor" bytea;
