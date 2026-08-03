-- Enforce uniqueness of (run_id, correlation_id, event_type) for the
-- entity-creating events (step_created, hook_created, wait_created).
--
-- Without this constraint, two concurrent runtime invocations producing
-- identical correlationIds (e.g. the snapshot runtime's deterministic
-- ULIDs across replays of the same resumption) can both insert events,
-- causing duplicate step/hook/wait events in the log. The unique
-- violation is caught in events.create and surfaced as
-- EntityConflictError, which the runtime already handles as a dedup
-- signal.
--
-- Existing installations may already contain duplicate
-- (run_id, correlation_id, type) rows for these event types — the
-- previous storage behavior allowed them through. Deduplicate before
-- creating the unique partial index, otherwise the CREATE UNIQUE INDEX
-- statement would fail at migration time. We keep the earliest-inserted
-- row for each (run_id, correlation_id, type) tuple (lowest ctid) and
-- drop the rest. The duplicates that this removes are exactly the rows
-- that would have been rejected as `EntityConflictError` had the unique
-- index existed when they were inserted.
WITH "ranked_workflow_events" AS (
	SELECT
		ctid,
		ROW_NUMBER() OVER (
			PARTITION BY "run_id", "correlation_id", "type"
			ORDER BY ctid
		) AS "row_num"
	FROM "workflow"."workflow_events"
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created')
)
DELETE FROM "workflow"."workflow_events"
WHERE ctid IN (
	SELECT ctid
	FROM "ranked_workflow_events"
	WHERE "row_num" > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_entity_creation_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created');
