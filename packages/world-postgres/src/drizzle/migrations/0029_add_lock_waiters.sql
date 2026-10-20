-- Native concurrency locks (`experimental_lock()`), stage 2: a FIFO waitlist with
-- direct handoff. The counters default to 0, so a stage-1 key row is a valid
-- stage-2 row with nobody waiting. `count` now counts holders plus reserved
-- waiters (see locks.ts); the CHECKs are a backstop, not the mechanism.
ALTER TABLE "workflow"."workflow_locks"
	ADD COLUMN IF NOT EXISTS "queued_count" integer DEFAULT 0 NOT NULL,
	ADD COLUMN IF NOT EXISTS "reserved_count" integer DEFAULT 0 NOT NULL,
	ADD COLUMN IF NOT EXISTS "tail_seq" bigint DEFAULT 0 NOT NULL;

ALTER TABLE "workflow"."workflow_locks"
	DROP CONSTRAINT IF EXISTS "workflow_locks_waiter_counts";
ALTER TABLE "workflow"."workflow_locks"
	ADD CONSTRAINT "workflow_locks_waiter_counts"
	CHECK ("queued_count" >= 0 AND "reserved_count" >= 0 AND "reserved_count" <= "count");

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

-- `lock_failed` joins the one-event-per-type-per-scope rule.
DROP INDEX IF EXISTS "workflow"."workflow_events_lock_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_lock_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('lock_created', 'lock_acquired', 'lock_failed', 'lock_released');
