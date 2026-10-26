-- Run idempotency keys (`start({ experimental_idempotencyKey })`): one row
-- per (workflow_name, idempotency_key) naming the run that holds the key, and
-- the run's own copy of the key it was started with. `ttl_ms` is a bigint
-- because the longest TTL (30 days in milliseconds) does not fit an integer.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_run_idempotency_keys" (
	"workflow_name" varchar NOT NULL,
	"idempotency_key" varchar NOT NULL,
	"run_id" varchar NOT NULL,
	"ttl_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_idempotency_keys_workflow_name_idempotency_key_pk" PRIMARY KEY("workflow_name","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar;
