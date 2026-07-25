CREATE TABLE IF NOT EXISTS "workflow"."workflow_run_tombstones" (
  "run_id" varchar PRIMARY KEY,
  "root_run_id" varchar NOT NULL,
  "purged_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_tombstones_root_run_id_index"
  ON "workflow"."workflow_run_tombstones" ("root_run_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow"."workflow_tree_fences" (
  "attribute_key" varchar NOT NULL,
  "attribute_value" varchar NOT NULL,
  "root_run_id" varchar NOT NULL,
  "purged_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("attribute_key", "attribute_value")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "workflow"."guard_purged_run_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  guarded_run_id varchar;
  attribute_entry record;
BEGIN
  IF TG_TABLE_NAME = 'workflow_runs' THEN
    guarded_run_id := NEW.id;
  ELSE
    guarded_run_id := NEW.run_id;
  END IF;

  -- Run writes take selector locks before the run lock, matching purge order.
  -- This prevents attribute updates and purges from deadlocking.
  IF TG_TABLE_NAME = 'workflow_runs' THEN
    FOR attribute_entry IN
      SELECT key, value
        FROM jsonb_each_text(COALESCE(NEW.attributes, '{}'::jsonb))
       ORDER BY key, value
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended(attribute_entry.key || chr(31) || attribute_entry.value, 1)
      );
      IF EXISTS (
        SELECT 1
          FROM "workflow"."workflow_tree_fences"
         WHERE attribute_key = attribute_entry.key
           AND attribute_value = attribute_entry.value
      ) THEN
        RAISE EXCEPTION 'workflow run tree was purged'
          USING ERRCODE = '23503';
      END IF;
    END LOOP;
  END IF;

  IF guarded_run_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(guarded_run_id, 0));
    IF EXISTS (
      SELECT 1
        FROM "workflow"."workflow_run_tombstones"
       WHERE run_id = guarded_run_id
    ) THEN
      RAISE EXCEPTION 'workflow run % was purged', guarded_run_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_guard_purged_run_write" ON "workflow"."workflow_runs";
CREATE TRIGGER "workflow_guard_purged_run_write"
  BEFORE INSERT OR UPDATE ON "workflow"."workflow_runs"
  FOR EACH ROW EXECUTE FUNCTION "workflow"."guard_purged_run_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_guard_purged_event_write" ON "workflow"."workflow_events";
CREATE TRIGGER "workflow_guard_purged_event_write"
  BEFORE INSERT OR UPDATE ON "workflow"."workflow_events"
  FOR EACH ROW EXECUTE FUNCTION "workflow"."guard_purged_run_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_guard_purged_step_write" ON "workflow"."workflow_steps";
CREATE TRIGGER "workflow_guard_purged_step_write"
  BEFORE INSERT OR UPDATE ON "workflow"."workflow_steps"
  FOR EACH ROW EXECUTE FUNCTION "workflow"."guard_purged_run_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_guard_purged_hook_write" ON "workflow"."workflow_hooks";
CREATE TRIGGER "workflow_guard_purged_hook_write"
  BEFORE INSERT OR UPDATE ON "workflow"."workflow_hooks"
  FOR EACH ROW EXECUTE FUNCTION "workflow"."guard_purged_run_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_guard_purged_wait_write" ON "workflow"."workflow_waits";
CREATE TRIGGER "workflow_guard_purged_wait_write"
  BEFORE INSERT OR UPDATE ON "workflow"."workflow_waits"
  FOR EACH ROW EXECUTE FUNCTION "workflow"."guard_purged_run_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_guard_purged_stream_write" ON "workflow"."workflow_stream_chunks";
CREATE TRIGGER "workflow_guard_purged_stream_write"
  BEFORE INSERT OR UPDATE ON "workflow"."workflow_stream_chunks"
  FOR EACH ROW EXECUTE FUNCTION "workflow"."guard_purged_run_write"();
