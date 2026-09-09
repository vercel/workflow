CREATE TABLE workflow_streams (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) > 0),
  next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (
    next_chunk_index BETWEEN 0 AND 9007199254740992
  ),
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  PRIMARY KEY (run_id, name)
) STRICT;

CREATE TABLE workflow_stream_chunks (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (
    chunk_index BETWEEN 0 AND 9007199254740991
  ),
  data BLOB NOT NULL,
  PRIMARY KEY (run_id, name, chunk_index),
  FOREIGN KEY (run_id, name)
    REFERENCES workflow_streams (run_id, name)
    ON DELETE CASCADE
) STRICT;

-- Streams are also used by the synthetic queue health check, which does not
-- create a workflow run. Preserve run cleanup for ordinary streams without
-- requiring every stream owner to have a materialized workflow_runs row.
CREATE TRIGGER workflow_streams_delete_with_run
AFTER DELETE ON workflow_runs
BEGIN
  DELETE FROM workflow_streams WHERE run_id = OLD.run_id;
END;
