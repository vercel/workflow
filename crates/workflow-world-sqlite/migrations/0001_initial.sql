CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  deployment_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  spec_version INTEGER NOT NULL CHECK (spec_version = 7),
  input BLOB NOT NULL,
  execution_context_cbor BLOB,
  attributes_json TEXT NOT NULL CHECK (
    json_valid(attributes_json) AND json_type(attributes_json) = 'object'
  ),
  encryption_public_key TEXT,
  next_event_slot INTEGER NOT NULL CHECK (
    next_event_slot BETWEEN 1 AND 9007199254740992
  ),
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE workflow_events (
  run_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 9007199254740991),
  event_type TEXT NOT NULL,
  spec_version INTEGER NOT NULL CHECK (spec_version = 7),
  event_data_present INTEGER NOT NULL CHECK (event_data_present IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, slot),
  FOREIGN KEY (run_id) REFERENCES workflow_runs (run_id) ON DELETE CASCADE,
  CHECK (event_type <> 'run_created' OR event_data_present = 1),
  CHECK (event_type <> 'run_started' OR event_data_present = 0)
) STRICT;

CREATE TABLE workflow_run_created_event_data (
  run_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  deployment_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  input BLOB NOT NULL,
  execution_context_cbor BLOB,
  attributes_json TEXT CHECK (
    attributes_json IS NULL OR (
      json_valid(attributes_json) AND json_type(attributes_json) = 'object'
    )
  ),
  allow_reserved_attributes INTEGER NOT NULL CHECK (
    allow_reserved_attributes IN (0, 1)
  ),
  encryption_public_key TEXT,
  PRIMARY KEY (run_id, slot),
  FOREIGN KEY (run_id, slot)
    REFERENCES workflow_events (run_id, slot)
    ON DELETE CASCADE
) STRICT;
