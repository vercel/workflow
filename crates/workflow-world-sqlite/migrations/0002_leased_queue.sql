CREATE TABLE workflow_queue_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body BLOB NOT NULL,
  available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER CHECK (
    lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE (scope, queue_name, idempotency_key),
  CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at_ms IS NULL)
    OR
    (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX workflow_queue_claimable
ON workflow_queue_messages (
  scope,
  queue_name,
  available_at_ms,
  lease_expires_at_ms,
  created_at_ms,
  message_id
);

CREATE UNIQUE INDEX workflow_queue_lease_token
ON workflow_queue_messages (lease_token)
WHERE lease_token IS NOT NULL;
