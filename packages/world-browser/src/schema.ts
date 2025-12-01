/**
 * SQLite schema for browser workflow storage.
 * Uses Turso WASM database.
 */

// Type for Turso WASM database connection
export interface BrowserDatabase {
  prepare(sql: string): {
    run(
      params?: unknown[]
    ): Promise<{ changes: number; lastInsertRowid: number }>;
    get<T = unknown>(params?: unknown[]): Promise<T | undefined>;
    all<T = unknown>(params?: unknown[]): Promise<T[]>;
  };
  exec(sql: string): Promise<void>;
}

/**
 * Initialize the database schema.
 */
export async function createSchema(db: BrowserDatabase): Promise<void> {
  await db.exec(`
    -- Workflow runs table
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      execution_context TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_workflow_name ON workflow_runs(workflow_name);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);

    -- Workflow steps table
    CREATE TABLE IF NOT EXISTS workflow_steps (
      step_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      retry_after TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_steps_run_id ON workflow_steps(run_id);
    CREATE INDEX IF NOT EXISTS idx_steps_status ON workflow_steps(status);

    -- Workflow events table
    CREATE TABLE IF NOT EXISTS workflow_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      correlation_id TEXT,
      event_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_run_id ON workflow_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_events_correlation_id ON workflow_events(correlation_id);

    -- Workflow hooks table
    CREATE TABLE IF NOT EXISTS workflow_hooks (
      hook_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      metadata TEXT,
      owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_hooks_run_id ON workflow_hooks(run_id);
    CREATE INDEX IF NOT EXISTS idx_hooks_token ON workflow_hooks(token);

    -- Queue table for job processing
    CREATE TABLE IF NOT EXISTS workflow_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      process_after TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON workflow_queue(status, process_after);
    CREATE INDEX IF NOT EXISTS idx_queue_idempotency ON workflow_queue(idempotency_key);

    -- Stream chunks table
    CREATE TABLE IF NOT EXISTS workflow_stream_chunks (
      chunk_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      chunk_data BLOB NOT NULL,
      eof INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (stream_id, chunk_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stream_chunks_stream_id ON workflow_stream_chunks(stream_id);
  `);
}
