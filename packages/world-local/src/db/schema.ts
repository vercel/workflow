import type { RawDatabase } from './driver.js';

/**
 * The schema, as an ordered list of migrations. `PRAGMA user_version` records
 * how many have run. Append; never edit a shipped migration.
 *
 * Conventions:
 * - Times are epoch milliseconds (INTEGER).
 * - `doc` columns hold the entity or event as written by `codec.encode`; the
 *   other columns are what the rows are looked up and ordered by.
 * - `tag` is the World's `tag` option (test isolation), NULL when untagged.
 *   Steps, waits and events belong to their run's tag.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    tag TEXT,
    workflow_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- The highest event position in the run's log.
    seq INTEGER NOT NULL DEFAULT 0,
    -- The in-band writer fence (spec 9): positions accepted from in-band
    -- writes, run_created included.
    seq_in_band INTEGER NOT NULL DEFAULT 1,
    doc TEXT NOT NULL
  );
  CREATE INDEX runs_by_created ON runs (created_at, run_id);
  CREATE INDEX runs_by_status ON runs (status, created_at);

  CREATE TABLE events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    correlation_id TEXT,
    doc TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  ) WITHOUT ROWID;
  CREATE INDEX events_by_correlation ON events (run_id, correlation_id, seq);

  CREATE TABLE steps (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    doc TEXT NOT NULL,
    PRIMARY KEY (run_id, step_id)
  ) WITHOUT ROWID;

  CREATE TABLE waits (
    run_id TEXT NOT NULL,
    wait_id TEXT NOT NULL,
    doc TEXT NOT NULL,
    PRIMARY KEY (run_id, wait_id)
  ) WITHOUT ROWID;

  -- Live hooks, and hooks kept past their run's end by token retention.
  CREATE TABLE hooks (
    hook_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    token TEXT NOT NULL,
    tag TEXT,
    created_at INTEGER NOT NULL,
    doc TEXT NOT NULL
  );
  CREATE INDEX hooks_by_run ON hooks (run_id);
  CREATE INDEX hooks_by_token ON hooks (token);
  CREATE INDEX hooks_by_created ON hooks (created_at, hook_id);

  -- Hooks whose disposal committed: disposal is permanent. A forced claim
  -- names the hook that took the token.
  CREATE TABLE hook_disposals (
    hook_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    force_claimed_by TEXT
  );
  CREATE INDEX hook_disposals_by_run ON hook_disposals (run_id);

  -- Token ownership, unique across runs. A row outlives its hook's run while
  -- the hook's token retention lasts.
  CREATE TABLE hook_tokens (
    token TEXT PRIMARY KEY,
    hook_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    retention_until INTEGER
  );
  CREATE INDEX hook_tokens_by_run ON hook_tokens (run_id);

  -- hook_received deduplication on (runId, resumeId).
  CREATE TABLE hook_resumes (
    run_id TEXT NOT NULL,
    resume_id TEXT NOT NULL,
    hook_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload_digest TEXT,
    PRIMARY KEY (run_id, resume_id)
  ) WITHOUT ROWID;

  -- A refused start({ hook }) candidate: its decision is permanent.
  CREATE TABLE start_hook_rejections (
    run_id TEXT PRIMARY KEY,
    tag TEXT,
    token TEXT NOT NULL,
    conflicting_run_id TEXT NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    tag TEXT,
    queue_name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    -- 'http' (any consumer that can reach the app delivers it) or 'direct'
    -- (only a consumer with an in-process handler for its prefix does).
    transport TEXT NOT NULL,
    body TEXT NOT NULL,
    headers TEXT,
    idempotency_key TEXT,
    -- The run whose orchestrator deliveries go one at a time (spec 9), keyed
    -- with the prefix; NULL for every other message.
    lane TEXT,
    hands_off INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    step_id TEXT,
    visible_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_until INTEGER,
    deliveries INTEGER NOT NULL DEFAULT 0,
    handoffs INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_by_visible ON messages (visible_at);
  CREATE INDEX messages_by_lane ON messages (lane, lease_until);
  CREATE INDEX messages_by_run ON messages (run_id);
  CREATE UNIQUE INDEX messages_by_idempotency_key
    ON messages (COALESCE(tag, ''), idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE TABLE stream_chunks (
    name TEXT NOT NULL,
    idx INTEGER NOT NULL,
    run_id TEXT,
    tag TEXT,
    data BLOB,
    eof INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (name, idx)
  ) WITHOUT ROWID;
  CREATE INDEX stream_chunks_by_run ON stream_chunks (run_id);

  CREATE TABLE snapshots (
    run_id TEXT PRIMARY KEY,
    envelope BLOB NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: RawDatabase): void {
  const current = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number })
      ?.user_version ?? 0
  );
  if (current >= MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read under the write lock: another process may have migrated.
    const locked = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version?: number })
        ?.user_version ?? 0
    );
    for (let i = locked; i < MIGRATIONS.length; i++) {
      db.exec(MIGRATIONS[i]);
    }
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
