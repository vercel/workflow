-- Store every timestamp as `timestamp with time zone`.
--
-- These columns were `timestamp without time zone`. Values written from
-- JavaScript (`started_at`, `completed_at`, `retry_after`, `resume_at`,
-- `expired_at`, and `updated_at` once a row is updated) arrive as ISO strings
-- whose `Z` Postgres ignored, so they hold UTC wall times. Values from
-- `DEFAULT now()` (every `created_at`, `updated_at` until the row's first
-- update) and from `now()` in SQL (`workflow_invocations.responded_at`) were
-- cast to the session's TimeZone, so they hold local wall times. The World
-- reads every value as UTC, so on a server outside UTC `createdAt` was off by
-- the server's offset.
--
-- 1. With the session in UTC, convert every column. Postgres 12+ does not
--    rewrite a table for this change while TimeZone is UTC, and each stored
--    value is taken as UTC, which is already right for every column written
--    from JavaScript.
-- 2. When the zone the defaults were written in is not UTC, move each value
--    that came from `now()` from that zone's wall time to the instant it
--    recorded. That zone is the session's TimeZone, or
--    `workflow.legacy_timezone` when set (for example
--    `options=-c workflow.legacy_timezone=Europe/Berlin` in the connection
--    string), for apps whose pool ran in a different session time zone than
--    this migration.
--
-- `workflow_invocations.expired_at` mixes `now()` with JavaScript dates and is
-- only ever checked for NULL, so its values are left as they are. Snapshot
-- `created_at` is always written from JavaScript.
--
-- The repair must run once: applied again it would move the repaired values
-- by the offset a second time. The drizzle migrator takes no lock, so two
-- `bootstrap` processes started together can both apply this migration. Lock
-- the tables first, then skip everything if the columns are already converted.
DO $$
DECLARE
  session_zone text := current_setting('TimeZone');
  legacy_zone text := coalesce(
    nullif(current_setting('workflow.legacy_timezone', true), ''),
    current_setting('TimeZone')
  );
BEGIN
  LOCK TABLE
    "workflow"."workflow_runs",
    "workflow"."workflow_events",
    "workflow"."workflow_steps",
    "workflow"."workflow_hooks",
    "workflow"."workflow_waits",
    "workflow"."workflow_invocations",
    "workflow"."workflow_snapshots",
    "workflow"."workflow_stream_chunks"
  IN ACCESS EXCLUSIVE MODE;
  IF (
    SELECT atttypid FROM pg_attribute
    WHERE attrelid = '"workflow"."workflow_runs"'::regclass
      AND attname = 'created_at'
  ) = 'timestamptz'::regtype THEN
    RETURN;
  END IF;

  PERFORM set_config('TimeZone', 'UTC', true);

  ALTER TABLE "workflow"."workflow_runs"
    ALTER COLUMN "created_at" TYPE timestamp with time zone,
    ALTER COLUMN "updated_at" TYPE timestamp with time zone,
    ALTER COLUMN "completed_at" TYPE timestamp with time zone,
    ALTER COLUMN "started_at" TYPE timestamp with time zone,
    ALTER COLUMN "expired_at" TYPE timestamp with time zone;
  ALTER TABLE "workflow"."workflow_events"
    ALTER COLUMN "created_at" TYPE timestamp with time zone;
  ALTER TABLE "workflow"."workflow_steps"
    ALTER COLUMN "started_at" TYPE timestamp with time zone,
    ALTER COLUMN "completed_at" TYPE timestamp with time zone,
    ALTER COLUMN "created_at" TYPE timestamp with time zone,
    ALTER COLUMN "updated_at" TYPE timestamp with time zone,
    ALTER COLUMN "retry_after" TYPE timestamp with time zone;
  ALTER TABLE "workflow"."workflow_hooks"
    ALTER COLUMN "created_at" TYPE timestamp with time zone;
  ALTER TABLE "workflow"."workflow_waits"
    ALTER COLUMN "resume_at" TYPE timestamp with time zone,
    ALTER COLUMN "completed_at" TYPE timestamp with time zone,
    ALTER COLUMN "created_at" TYPE timestamp with time zone,
    ALTER COLUMN "updated_at" TYPE timestamp with time zone;
  ALTER TABLE "workflow"."workflow_invocations"
    ALTER COLUMN "created_at" TYPE timestamp with time zone,
    ALTER COLUMN "responded_at" TYPE timestamp with time zone,
    ALTER COLUMN "expired_at" TYPE timestamp with time zone;
  ALTER TABLE "workflow"."workflow_snapshots"
    ALTER COLUMN "created_at" TYPE timestamp with time zone;
  ALTER TABLE "workflow"."workflow_stream_chunks"
    ALTER COLUMN "created_at" TYPE timestamp with time zone;

  IF lower(legacy_zone) NOT IN (
    'utc', 'etc/utc', 'uct', 'etc/uct', 'universal', 'etc/universal',
    'zulu', 'etc/zulu', 'gmt', 'etc/gmt', 'gmt0', 'etc/gmt0', 'gmt+0',
    'etc/gmt+0', 'gmt-0', 'etc/gmt-0', 'greenwich', 'etc/greenwich'
  ) THEN
    -- An `updated_at` equal to `created_at` came from the same `now()` as it
    -- (the row was never updated). Every other `updated_at` is from JavaScript.
    UPDATE "workflow"."workflow_runs" SET
      "created_at" = timezone(legacy_zone, timezone('UTC', "created_at")),
      "updated_at" = CASE WHEN "updated_at" = "created_at"
        THEN timezone(legacy_zone, timezone('UTC', "updated_at"))
        ELSE "updated_at" END
    WHERE timezone(legacy_zone, timezone('UTC', "created_at")) <> "created_at";
    UPDATE "workflow"."workflow_steps" SET
      "created_at" = timezone(legacy_zone, timezone('UTC', "created_at")),
      "updated_at" = CASE WHEN "updated_at" = "created_at"
        THEN timezone(legacy_zone, timezone('UTC', "updated_at"))
        ELSE "updated_at" END
    WHERE timezone(legacy_zone, timezone('UTC', "created_at")) <> "created_at";
    UPDATE "workflow"."workflow_waits" SET
      "created_at" = timezone(legacy_zone, timezone('UTC', "created_at")),
      "updated_at" = CASE WHEN "updated_at" = "created_at"
        THEN timezone(legacy_zone, timezone('UTC', "updated_at"))
        ELSE "updated_at" END
    WHERE timezone(legacy_zone, timezone('UTC', "created_at")) <> "created_at";
    UPDATE "workflow"."workflow_events" SET
      "created_at" = timezone(legacy_zone, timezone('UTC', "created_at"))
    WHERE timezone(legacy_zone, timezone('UTC', "created_at")) <> "created_at";
    UPDATE "workflow"."workflow_hooks" SET
      "created_at" = timezone(legacy_zone, timezone('UTC', "created_at"))
    WHERE timezone(legacy_zone, timezone('UTC', "created_at")) <> "created_at";
    UPDATE "workflow"."workflow_stream_chunks" SET
      "created_at" = timezone(legacy_zone, timezone('UTC', "created_at"))
    WHERE timezone(legacy_zone, timezone('UTC', "created_at")) <> "created_at";
    UPDATE "workflow"."workflow_invocations" SET
      "created_at" = timezone(legacy_zone, timezone('UTC', "created_at")),
      "responded_at" = timezone(legacy_zone, timezone('UTC', "responded_at"))
    WHERE timezone(legacy_zone, timezone('UTC', "created_at")) <> "created_at"
      OR timezone(legacy_zone, timezone('UTC', "responded_at")) <> "responded_at";
  END IF;

  PERFORM set_config('TimeZone', session_zone, true);
END $$;
