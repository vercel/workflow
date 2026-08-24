DO $$
DECLARE
  enum_name text;
  public_enum regtype;
  workflow_enum regtype;
  is_used_by_workflow_columns boolean;
  has_dependents_outside_workflow_tables boolean;
BEGIN
  FOREACH enum_name IN ARRAY ARRAY['status', 'step_status', 'wait_status'] LOOP
    public_enum := to_regtype(format('public.%I', enum_name));
    workflow_enum := to_regtype(format('workflow.%I', enum_name));

    -- Nothing to migrate when the legacy public enum does not exist, or when
    -- the enum has already been moved to the workflow schema.
    IF public_enum IS NULL OR workflow_enum IS NOT NULL THEN
      CONTINUE;
    END IF;

    -- Only move enums that are actually used by workflow table columns.
    -- pg_depend has an index on referenced objects, so this lookup is based
    -- on the enum type OID instead of scanning user data or workflow rows.
    SELECT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      JOIN pg_class dependent_table
        ON dependency.classid = 'pg_class'::regclass AND dependency.objid = dependent_table.oid
      JOIN pg_namespace dependent_table_schema
        ON dependent_table_schema.oid = dependent_table.relnamespace
      WHERE dependency.refclassid = 'pg_type'::regclass
        AND dependency.refobjid = public_enum::oid
        AND dependency.objsubid > 0
        AND dependency.deptype != 'i'
        AND dependent_table_schema.nspname = 'workflow'
    ) INTO is_used_by_workflow_columns;

    IF NOT is_used_by_workflow_columns THEN
      CONTINUE;
    END IF;

    /*
      pg_depend is Postgres' dependency graph.

      We use it here as a safety check before moving the enum object itself.
      A normal workflow-owned enum has only workflow table-column dependents,
      so ALTER TYPE ... SET SCHEMA is a fast metadata change.

      If anything outside workflow tables also depends on this enum, moving it
      would silently rename that user's public enum to workflow.<enum_name>.
      In that case, leave the enum in public, warn, and continue so this cleanup
      migration does not block later migrations.
    */
    SELECT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      LEFT JOIN pg_class dependent_table
        ON dependency.classid = 'pg_class'::regclass AND dependency.objid = dependent_table.oid
      LEFT JOIN pg_namespace dependent_table_schema
        ON dependent_table_schema.oid = dependent_table.relnamespace
      WHERE dependency.refclassid = 'pg_type'::regclass
        AND dependency.refobjid = public_enum::oid
        AND dependency.deptype != 'i'
        AND NOT (
          dependency.classid = 'pg_class'::regclass
          AND dependent_table_schema.nspname = 'workflow'
        )
    ) INTO has_dependents_outside_workflow_tables;

    IF has_dependents_outside_workflow_tables THEN
      RAISE WARNING 'Skipping move of public.% to workflow schema because objects outside workflow tables depend on it', enum_name;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TYPE public.%I SET SCHEMA workflow', enum_name);
  END LOOP;
END $$;
