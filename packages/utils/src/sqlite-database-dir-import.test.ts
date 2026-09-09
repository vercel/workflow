import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const sqliteState = vi.hoisted(() => ({ loads: 0 }));

vi.mock('node:sqlite', () => {
  sqliteState.loads += 1;
  throw new Error('simulated unsupported node:sqlite runtime');
});

describe('Workflow SQLite utility runtime compatibility', () => {
  it('does not load node:sqlite merely by importing or resolving a directory', async () => {
    const { resolveWorkflowSqliteDatabaseDir } = await import(
      './sqlite-database-dir.js'
    );

    expect(resolveWorkflowSqliteDatabaseDir('/project', 'data')).toBe(
      resolve('/project', 'data')
    );
    expect(sqliteState.loads).toBe(0);
  });
});
