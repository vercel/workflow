ALTER TABLE workflow_events ADD COLUMN resume_id TEXT;
ALTER TABLE workflow_events ADD COLUMN resume_payload_digest TEXT;
ALTER TABLE workflow_queue_messages
ADD COLUMN delivery_attempt INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempt >= 0);

CREATE UNIQUE INDEX workflow_events_by_resume
ON workflow_events (run_id, resume_id)
WHERE resume_id IS NOT NULL;

-- Runtime-correlated one-shot events are claims. The partial unique index is
-- the durable backstop for concurrent replays that mint the same correlation
-- ID, while leaving lifecycle events free to repeat where the contract allows.
CREATE UNIQUE INDEX workflow_events_entity_creation_unique
ON workflow_events (run_id, correlation_id, event_type)
WHERE correlation_id IS NOT NULL
  AND event_type IN (
    'step_created',
    'hook_created',
    'wait_created',
    'attr_set'
  );

CREATE INDEX workflow_runs_by_created
ON workflow_runs (created_at_ms, run_id);

CREATE TABLE workflow_phase2_event_data (
  run_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  data_kind TEXT NOT NULL CHECK (
    data_kind IN (
      'attr_set',
      'hook_created',
      'hook_received',
      'hook_disposed',
      'hook_conflict',
      'wait_created',
      'wait_completed',
      'noop'
    )
  ),
  payload BLOB,
  token TEXT,
  metadata BLOB,
  token_retention_until_ms INTEGER,
  is_webhook INTEGER CHECK (is_webhook IS NULL OR is_webhook IN (0, 1)),
  is_system INTEGER CHECK (is_system IS NULL OR is_system IN (0, 1)),
  conflicting_run_id TEXT,
  resume_at_ms INTEGER,
  attribute_changes_json TEXT CHECK (
    attribute_changes_json IS NULL OR json_valid(attribute_changes_json)
  ),
  attribute_writer_json TEXT CHECK (
    attribute_writer_json IS NULL OR json_valid(attribute_writer_json)
  ),
  allow_reserved_attributes INTEGER CHECK (
    allow_reserved_attributes IS NULL OR allow_reserved_attributes IN (0, 1)
  ),
  sealed INTEGER CHECK (sealed IS NULL OR sealed IN (0, 1)),
  PRIMARY KEY (run_id, slot),
  FOREIGN KEY (run_id, slot)
    REFERENCES workflow_events (run_id, slot)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE workflow_hooks (
  hook_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  metadata BLOB,
  created_at_ms INTEGER NOT NULL,
  spec_version INTEGER NOT NULL CHECK (spec_version = 7),
  is_webhook INTEGER NOT NULL CHECK (is_webhook IN (0, 1)),
  is_system INTEGER NOT NULL CHECK (is_system IN (0, 1)),
  token_retention_until_ms INTEGER,
  FOREIGN KEY (run_id) REFERENCES workflow_runs (run_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX workflow_hooks_by_run
ON workflow_hooks (run_id, created_at_ms, hook_id);

CREATE INDEX workflow_hooks_by_created
ON workflow_hooks (created_at_ms, hook_id);

CREATE TABLE workflow_waits (
  wait_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'completed')),
  resume_at_ms INTEGER,
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  spec_version INTEGER NOT NULL CHECK (spec_version = 7),
  UNIQUE (run_id, correlation_id),
  FOREIGN KEY (run_id) REFERENCES workflow_runs (run_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX workflow_waits_by_run
ON workflow_waits (run_id, created_at_ms, wait_id);
