DROP INDEX IF EXISTS "workflow"."workflow_events_entity_creation_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_entity_creation_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created', 'attr_set');
