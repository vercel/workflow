import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hook, WorkflowRun, World } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  fetchRuns,
  hookToListItem,
  readStreamServerAction,
  withObservabilitySource,
} from './workflow-server-actions.server';

describe('hookToListItem', () => {
  it('strips the secret token from runtime hook rows', () => {
    const hook: Hook = {
      hookId: 'hook-1',
      runId: 'run-1',
      token: 'secret-token',
      ownerId: 'owner-1',
      projectId: 'project-1',
      environment: 'production',
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      specVersion: 2,
    };

    const listItem = hookToListItem(hook);

    expect(listItem).toEqual({
      hookId: 'hook-1',
      runId: 'run-1',
      ownerId: 'owner-1',
      projectId: 'project-1',
      environment: 'production',
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      specVersion: 2,
    });
    expect('token' in listItem).toBe(false);
  });
});

describe('withObservabilitySource', () => {
  it('annotates an observability response copy without changing the World run', async () => {
    const run = {
      runId: 'run-1',
      status: 'completed',
      deploymentId: 'local-js',
      workflowName: 'workflow',
      attributes: {},
      createdAt: new Date('2026-06-30T00:00:00.000Z'),
      updatedAt: new Date('2026-06-30T00:00:00.000Z'),
      completedAt: new Date('2026-06-30T00:00:00.000Z'),
    } satisfies WorkflowRun;
    const world = {
      describeRun: () => ({ observabilitySource: 'vitest-worker_2.sqlite' }),
    } as unknown as World;

    const result = await withObservabilitySource(world, run);

    expect(result).toEqual({
      ...run,
      observabilitySource: 'vitest-worker_2.sqlite',
    });
    expect(run).not.toHaveProperty('observabilitySource');
  });
});

describe('SQLite observability discovery', () => {
  it('refreshes the database set between requests and closes every handle', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'workflow-web-sqlite-'));
    const databaseDir = join(projectDir, 'databases');
    const packageDir = join(
      projectDir,
      'node_modules',
      '@workflow',
      'world-sqlite'
    );
    const lifecycleLog = join(projectDir, 'lifecycle.ndjson');
    const previousEnv = {
      WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD,
      WORKFLOW_LOCAL_DATABASE_DIR: process.env.WORKFLOW_LOCAL_DATABASE_DIR,
      WORKFLOW_OBSERVABILITY_CWD: process.env.WORKFLOW_OBSERVABILITY_CWD,
      WORKFLOW_TEST_SQLITE_LIFECYCLE_LOG:
        process.env.WORKFLOW_TEST_SQLITE_LIFECYCLE_LOG,
    };

    try {
      await mkdir(databaseDir, { recursive: true });
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({ name: 'sqlite-observability-test', private: true })
      );
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@workflow/world-sqlite',
          type: 'module',
          exports: './index.js',
        })
      );
      await writeFile(
        join(packageDir, 'index.js'),
        `
          import { appendFileSync, readFileSync } from 'node:fs';
          import { basename } from 'node:path';

          function record(event, config) {
            appendFileSync(
              process.env.WORKFLOW_TEST_SQLITE_LIFECYCLE_LOG,
              JSON.stringify({
                event,
                source: basename(config.databaseFile),
                readOnly: config.readOnly,
                recoverActiveRuns: config.recoverActiveRuns,
              }) + '\\n'
            );
          }

          export function createWorld(config) {
            const getRun = () => {
              const runId = readFileSync(config.databaseFile, 'utf8').trim();
              return {
                runId,
                status: 'completed',
                deploymentId: 'test',
                workflowName: 'testWorkflow',
                attributes: {},
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                updatedAt: new Date('2026-01-01T00:00:00.000Z'),
                completedAt: new Date('2026-01-01T00:00:00.000Z'),
              };
            };
            return {
              specVersion: 1,
              capabilities: {},
              async validate() {
                getRun();
                record('validate', config);
              },
              async close() {
                record('close', config);
              },
              runs: {
                async list() {
                  return { data: [getRun()], cursor: null, hasMore: false };
                },
                async get(runId) {
                  const run = getRun();
                  if (run.runId === runId) return run;
                  throw Object.assign(new Error('not found'), { status: 404 });
                },
              },
              streams: {
                async get() {
                  return new ReadableStream({
                    start(controller) {
                      controller.enqueue(new Uint8Array([1, 2, 3]));
                      controller.close();
                    },
                  });
                },
              },
              async describeRun() {
                return null;
              },
            };
          }
        `
      );

      process.env.WORKFLOW_TARGET_WORLD = 'sqlite';
      process.env.WORKFLOW_LOCAL_DATABASE_DIR = databaseDir;
      process.env.WORKFLOW_OBSERVABILITY_CWD = projectDir;
      process.env.WORKFLOW_TEST_SQLITE_LIFECYCLE_LOG = lifecycleLog;

      const applicationDatabase = join(databaseDir, 'workflow.sqlite');
      const vitestDatabase = join(databaseDir, 'vitest-pool_a.sqlite');
      await writeFile(applicationDatabase, 'run-application');

      const first = await fetchRuns({}, { limit: 10 });
      expect(first).toMatchObject({
        success: true,
        data: {
          data: [
            {
              runId: 'run-application',
              observabilitySource: 'workflow.sqlite',
            },
          ],
        },
      });

      await writeFile(vitestDatabase, 'run-vitest');
      const second = await fetchRuns({}, { limit: 10 });
      expect(second.success && second.data.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: 'run-application',
            observabilitySource: 'workflow.sqlite',
          }),
          expect.objectContaining({
            runId: 'run-vitest',
            observabilitySource: 'vitest-pool_a.sqlite',
          }),
        ])
      );

      await unlink(applicationDatabase);
      const third = await fetchRuns({}, { limit: 10 });
      expect(third).toMatchObject({
        success: true,
        data: {
          data: [
            {
              runId: 'run-vitest',
              observabilitySource: 'vitest-pool_a.sqlite',
            },
          ],
        },
      });

      const stream = await readStreamServerAction(
        {},
        'output',
        undefined,
        'run-vitest'
      );
      expect(stream).toBeInstanceOf(ReadableStream);
      if (!(stream instanceof ReadableStream)) throw new Error('no stream');
      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: new Uint8Array([1, 2, 3]),
      });
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });

      const lifecycle = (await readFile(lifecycleLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        lifecycle.filter(({ event }) => event === 'validate')
      ).toHaveLength(5);
      expect(lifecycle.filter(({ event }) => event === 'close')).toHaveLength(
        5
      );
      expect(lifecycle.filter(({ event }) => event === 'validate')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ readOnly: true, recoverActiveRuns: false }),
        ])
      );
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
