-- Native concurrency locks (`experimental_lock()`), stage 1: a per-key counter and one
-- holder row per held slot. `count` always equals the key's holder rows; the
-- CHECKs are a backstop for that invariant, not the mechanism (see locks.ts).
CREATE TABLE IF NOT EXISTS "workflow"."workflow_locks" (
	"key" text PRIMARY KEY NOT NULL,
	"concurrency" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"grant_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_locks_count_bounds" CHECK ("count" >= 0 AND "count" <= "concurrency")
);

CREATE TABLE IF NOT EXISTS "workflow"."workflow_lock_holders" (
	"run_id" varchar NOT NULL,
	"correlation_id" varchar NOT NULL,
	"key" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "workflow_lock_holders_run_id_correlation_id_pk" PRIMARY KEY("run_id","correlation_id")
);

CREATE INDEX IF NOT EXISTS "workflow_lock_holders_key_index"
	ON "workflow"."workflow_lock_holders" ("key");

-- One event of each lock type per scope.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_lock_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('lock_created', 'lock_acquired', 'lock_released');
