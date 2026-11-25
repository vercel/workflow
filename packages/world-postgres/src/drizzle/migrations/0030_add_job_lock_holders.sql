-- Graphile workers of processes that renew their job locks. The default
-- stale-lock sweep releases a per-run named-queue job only when its holder is
-- listed here, so a process on an earlier version, which does not renew, is
-- never released under. `IF NOT EXISTS` because two `bootstrap` processes
-- started together can both apply a migration.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_job_lock_holders" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
