-- Migrate pending pg-boss jobs to a staging table before dropping the pgboss schema.
-- The application code will re-enqueue these jobs into graphile-worker on first start.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') THEN
    CREATE TABLE IF NOT EXISTS "workflow"."_pgboss_pending_jobs" (
      name text NOT NULL,
      data jsonb,
      singleton_key text,
      retry_limit integer
    );

    INSERT INTO "workflow"."_pgboss_pending_jobs" (name, data, singleton_key, retry_limit)
    SELECT name, data, singleton_key, retry_limit
    FROM pgboss.job
    WHERE state IN ('created', 'retry');

    DROP SCHEMA pgboss CASCADE;
  END IF;
END $$;
