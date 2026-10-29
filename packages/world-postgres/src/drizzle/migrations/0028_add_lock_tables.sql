-- Native concurrency locks (`experimental_lock()`): a per-key counter, one
-- holder row per held slot, and a FIFO waitlist with direct handoff. `count`
-- always equals the key's holder rows plus its reserved waiters
-- (`reserved_count`); the CHECKs are a backstop for that invariant, not the
-- mechanism (see locks.ts).
CREATE TABLE IF NOT EXISTS "workflow"."workflow_locks" (
	"key" text PRIMARY KEY NOT NULL,
	"concurrency" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"grant_seq" bigint DEFAULT 0 NOT NULL,
	"queued_count" integer DEFAULT 0 NOT NULL,
	"reserved_count" integer DEFAULT 0 NOT NULL,
	"tail_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_locks_count_bounds" CHECK ("count" >= 0 AND "count" <= "concurrency"),
	CONSTRAINT "workflow_locks_waiter_counts" CHECK ("queued_count" >= 0 AND "reserved_count" >= 0 AND "reserved_count" <= "count")
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

CREATE TABLE IF NOT EXISTS "workflow"."workflow_lock_waiters" (
	"run_id" varchar NOT NULL,
	"correlation_id" varchar NOT NULL,
	"key" text NOT NULL,
	"seq" bigint NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	"wake" jsonb,
	CONSTRAINT "workflow_lock_waiters_run_id_correlation_id_pk" PRIMARY KEY("run_id","correlation_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_lock_waiters_key_seq_index"
	ON "workflow"."workflow_lock_waiters" ("key", "seq");

-- The head of a key's queue.
CREATE INDEX IF NOT EXISTS "workflow_lock_waiters_queued_index"
	ON "workflow"."workflow_lock_waiters" ("key", "seq")
	WHERE "granted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "workflow_lock_waiters_run_id_index"
	ON "workflow"."workflow_lock_waiters" ("run_id");

-- One event of each lock type per scope.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_lock_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('lock_created', 'lock_acquired', 'lock_failed', 'lock_released');
