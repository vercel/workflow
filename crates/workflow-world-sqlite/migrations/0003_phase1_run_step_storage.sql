ALTER TABLE workflow_runs ADD COLUMN output BLOB;
ALTER TABLE workflow_runs ADD COLUMN error BLOB;
ALTER TABLE workflow_runs ADD COLUMN error_code TEXT;
ALTER TABLE workflow_runs ADD COLUMN completed_at_ms INTEGER;

ALTER TABLE workflow_events ADD COLUMN correlation_id TEXT;
ALTER TABLE workflow_events ADD COLUMN occurred_at_ms INTEGER;

CREATE TABLE workflow_event_data (
  run_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  data_kind TEXT NOT NULL CHECK (
    data_kind IN (
      'run_completed',
      'run_failed',
      'run_cancelled',
      'step_created',
      'step_started',
      'step_completed',
      'step_failed',
      'step_retrying'
    )
  ),
  payload BLOB,
  step_name TEXT,
  attempt INTEGER CHECK (attempt IS NULL OR attempt >= 0),
  retry_after_ms INTEGER,
  owner_message_id TEXT,
  error_code TEXT,
  cancel_reason TEXT,
  PRIMARY KEY (run_id, slot),
  FOREIGN KEY (run_id, slot)
    REFERENCES workflow_events (run_id, slot)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE workflow_steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  input BLOB NOT NULL,
  output BLOB,
  error BLOB,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  retry_after_ms INTEGER,
  spec_version INTEGER NOT NULL CHECK (spec_version = 7),
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id) REFERENCES workflow_runs (run_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX workflow_steps_by_run
ON workflow_steps (run_id, created_at_ms, step_id);

CREATE INDEX workflow_events_by_correlation
ON workflow_events (run_id, correlation_id, slot);

CREATE TABLE workflow_database_metadata (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  format TEXT NOT NULL CHECK (format = 'workflow-sqlite'),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  context_codec TEXT NOT NULL CHECK (context_codec = 'workflow-cbor-v1')
) STRICT;

INSERT INTO workflow_database_metadata (
  singleton,
  format,
  format_version,
  context_codec
) VALUES (1, 'workflow-sqlite', 1, 'workflow-cbor-v1');
