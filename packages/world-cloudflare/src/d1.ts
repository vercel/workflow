/**
 * D1 index schema for cross-run queries.
 *
 * The D1 database stores lightweight index data only (no input/output/event payloads).
 * The source of truth for all run data lives in Durable Objects.
 */

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workflow_runs_index (
  run_id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  spec_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  expired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_name ON workflow_runs_index(workflow_name);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs_index(status);

CREATE TABLE IF NOT EXISTS workflow_hooks_index (
  hook_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_webhook INTEGER DEFAULT 1,
  spec_version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hooks_run ON workflow_hooks_index(run_id);
CREATE INDEX IF NOT EXISTS idx_hooks_token ON workflow_hooks_index(token);
`;

/**
 * Run the D1 index migration. Safe to call multiple times (uses IF NOT EXISTS).
 */
export async function migrate(db: D1Database): Promise<void> {
  const statements = MIGRATION_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sql of statements) {
    await db.exec(`${sql};`);
  }
}

/** Upsert a run's index row in D1 */
export async function upsertRunIndex(
  db: D1Database,
  run: {
    runId: string;
    workflowName: string;
    status: string;
    deploymentId: string;
    specVersion?: number;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    expiredAt?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workflow_runs_index
        (run_id, workflow_name, status, deployment_id, spec_version, created_at, updated_at, started_at, completed_at, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        started_at = COALESCE(excluded.started_at, started_at),
        completed_at = COALESCE(excluded.completed_at, completed_at),
        expired_at = COALESCE(excluded.expired_at, expired_at)`
    )
    .bind(
      run.runId,
      run.workflowName,
      run.status,
      run.deploymentId,
      run.specVersion ?? null,
      run.createdAt,
      run.updatedAt,
      run.startedAt ?? null,
      run.completedAt ?? null,
      run.expiredAt ?? null
    )
    .run();
}

/** Insert a hook into the D1 index */
export async function insertHookIndex(
  db: D1Database,
  hook: {
    hookId: string;
    runId: string;
    token: string;
    ownerId: string;
    projectId: string;
    environment: string;
    createdAt: string;
    isWebhook?: boolean;
    specVersion?: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO workflow_hooks_index
        (hook_id, run_id, token, owner_id, project_id, environment, created_at, is_webhook, spec_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      hook.hookId,
      hook.runId,
      hook.token,
      hook.ownerId,
      hook.projectId,
      hook.environment,
      hook.createdAt,
      hook.isWebhook !== false ? 1 : 0,
      hook.specVersion ?? null
    )
    .run();
}

/** Delete a hook from the D1 index */
export async function deleteHookIndex(
  db: D1Database,
  hookId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM workflow_hooks_index WHERE hook_id = ?')
    .bind(hookId)
    .run();
}

/** Delete all hooks for a run from the D1 index */
export async function deleteHooksForRunIndex(
  db: D1Database,
  runId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM workflow_hooks_index WHERE run_id = ?')
    .bind(runId)
    .run();
}
