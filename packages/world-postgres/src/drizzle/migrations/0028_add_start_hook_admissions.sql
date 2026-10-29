-- Atomic `start({ hook })` admission: one immutable accept-or-reject decision
-- per candidate run, written in the transaction that creates an accepted run.
-- Rows older than a candidate's 24h window are deleted as admissions go.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_start_hook_admissions" (
	"run_id" varchar PRIMARY KEY NOT NULL,
	"token" varchar NOT NULL,
	"decision" varchar NOT NULL,
	"conflicting_run_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_start_hook_admissions_created_at_index" ON "workflow"."workflow_start_hook_admissions" USING btree ("created_at");
--> statement-breakpoint
-- The start Hook a run was admitted with (without its metadata), echoed on
-- the run.
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "start_hook_cbor" bytea;
--> statement-breakpoint
-- A run's start Hook is an ordinary row in workflow_hooks, written by its
-- admission. It claims its token, and claiming rows are unique per token, so
-- two admissions racing for one token conflict on the insert. Rows written
-- before this migration do not claim their token, so the index cannot fail on
-- existing data.
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "claims_token" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_hooks_token_claim_unique" ON "workflow"."workflow_hooks" USING btree ("token") WHERE "claims_token";
