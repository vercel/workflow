import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const DEFAULT_DATABASE_DIR = '.workflow-database';
const APPLICATION_DATABASE = 'workflow.sqlite';
const VITEST_DATABASE_PATTERN = /^vitest-([a-zA-Z0-9_-]{1,64})\.sqlite$/;

export interface WorkflowSqliteDatabase {
  /** Stable, user-facing source identifier. */
  source: string;
  databasePath: string;
  kind: 'application' | 'vitest';
  poolId?: string;
}

/**
 * Resolve the SQLite database directory relative to the inspected project.
 * Programmatic configuration wins over WORKFLOW_LOCAL_DATABASE_DIR.
 */
export function resolveWorkflowSqliteDatabaseDir(
  projectDir: string,
  databaseDir?: string
): string {
  const selected =
    databaseDir ??
    process.env.WORKFLOW_LOCAL_DATABASE_DIR ??
    DEFAULT_DATABASE_DIR;
  return isAbsolute(selected)
    ? resolve(selected)
    : resolve(projectDir, selected);
}

/**
 * Discover only canonical Workflow SQLite databases in one directory.
 * Symlinks, sidecars, nested files, and unsafe pool names are ignored.
 */
// @lat: [[lat.md/rust-portability#Rust Portability Architecture#SQLite Local World#Vitest Database Selection]]
export async function discoverWorkflowSqliteDatabases(
  databaseDir: string
): Promise<WorkflowSqliteDatabase[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(databaseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const databases: WorkflowSqliteDatabase[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === APPLICATION_DATABASE) {
      databases.push({
        source: APPLICATION_DATABASE,
        databasePath: join(databaseDir, entry.name),
        kind: 'application',
      });
      continue;
    }
    const match = VITEST_DATABASE_PATTERN.exec(entry.name);
    if (!match) continue;
    databases.push({
      source: entry.name,
      databasePath: join(databaseDir, entry.name),
      kind: 'vitest',
      poolId: match[1],
    });
  }

  return databases.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'application' ? -1 : 1;
    return left.source.localeCompare(right.source);
  });
}
