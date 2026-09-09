import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverWorkflowSqliteDatabases,
  resolveWorkflowSqliteDatabaseDir,
} from './sqlite-database-dir.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-sqlite-discovery-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Workflow SQLite database discovery', () => {
  it('discovers only exact files without following links or nested paths', async () => {
    const directory = await temporaryDirectory();
    const nested = join(directory, 'nested');
    await mkdir(nested);
    await Promise.all([
      writeFile(join(directory, 'workflow.sqlite'), ''),
      writeFile(join(directory, 'vitest-0.sqlite'), ''),
      writeFile(join(directory, 'vitest-worker_2.sqlite'), ''),
      writeFile(join(directory, 'vitest-bad!.sqlite'), ''),
      writeFile(join(directory, 'vitest-3.sqlite-wal'), ''),
      writeFile(join(directory, 'other.sqlite'), ''),
      writeFile(join(nested, 'vitest-4.sqlite'), ''),
    ]);
    await symlink(
      join(directory, 'workflow.sqlite'),
      join(directory, 'vitest-linked.sqlite')
    );

    expect(await discoverWorkflowSqliteDatabases(directory)).toEqual([
      {
        source: 'workflow.sqlite',
        databasePath: join(directory, 'workflow.sqlite'),
        kind: 'application',
      },
      {
        source: 'vitest-0.sqlite',
        databasePath: join(directory, 'vitest-0.sqlite'),
        kind: 'vitest',
        poolId: '0',
      },
      {
        source: 'vitest-worker_2.sqlite',
        databasePath: join(directory, 'vitest-worker_2.sqlite'),
        kind: 'vitest',
        poolId: 'worker_2',
      },
    ]);
  });

  it('returns an empty list for a missing directory', async () => {
    const directory = await temporaryDirectory();
    expect(
      await discoverWorkflowSqliteDatabases(join(directory, 'missing'))
    ).toEqual([]);
  });

  it('resolves explicit configuration before the environment and default', () => {
    const project = resolve('project');
    const previous = process.env.WORKFLOW_LOCAL_DATABASE_DIR;
    process.env.WORKFLOW_LOCAL_DATABASE_DIR = 'from-environment';
    try {
      expect(resolveWorkflowSqliteDatabaseDir(project, 'explicit')).toBe(
        join(project, 'explicit')
      );
      expect(resolveWorkflowSqliteDatabaseDir(project)).toBe(
        join(project, 'from-environment')
      );
      delete process.env.WORKFLOW_LOCAL_DATABASE_DIR;
      expect(resolveWorkflowSqliteDatabaseDir(project)).toBe(
        join(project, '.workflow-database')
      );
    } finally {
      if (previous === undefined)
        delete process.env.WORKFLOW_LOCAL_DATABASE_DIR;
      else process.env.WORKFLOW_LOCAL_DATABASE_DIR = previous;
    }
  });
});
