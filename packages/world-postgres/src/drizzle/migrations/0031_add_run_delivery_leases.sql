-- Per-run delivery leases (`run-lease.ts`): a run's row exists only while a
-- delivery drives it, naming the Graphile job that owns it, plus the messages
-- other deliveries left for that owner. Replaces Graphile named queues, whose
-- rows are never deleted and are all locked on every poll. `IF NOT EXISTS`
-- because two `bootstrap` processes started together can both apply a
-- migration.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_run_delivery_leases" (
	"run_id" varchar PRIMARY KEY NOT NULL,
	"owner_job_id" bigint NOT NULL,
	"wake" jsonb,
	"wake_resume" boolean DEFAULT false NOT NULL,
	"deferred" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
