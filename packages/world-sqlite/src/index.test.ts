import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  TooEarlyError,
  WorkflowRunNotFoundError,
  type WorkflowWorldError,
} from '@workflow/errors';
import type { World } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, nativeInfo } from './index.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'workflow-world-sqlite-')
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('@workflow/world-sqlite Phase 1', () => {
  it('loads the N-API 8 addon with bundled SQLite 3.53.2', () => {
    expect(nativeInfo()).toMatchObject({
      crateVersion: '0.1.0',
      nodeApiVersion: 8,
      sqliteVersion: '3.53.2',
      schemaVersion: 3,
      persistedSpecMin: 7,
      persistedSpecMax: 7,
      enabledBackends: ['sqlite'],
    });
  });

  it('constructs without creating or migrating a database', async () => {
    const databaseDir = path.join(await temporaryDirectory(), 'not-created');
    const world = createWorld({ databaseDir });
    const contract: World = world;
    expect(contract.specVersion).toBe(7);
    await expect(access(databaseDir)).rejects.toThrow();
    await world.close();
    await expect(access(databaseDir)).rejects.toThrow();
  });

  it('isolates worker lifecycle by database and deployment target', async () => {
    const databaseDir = await temporaryDirectory();
    const javascript = createWorld({ databaseDir, deploymentId: 'local-js' });
    await javascript.migrate();
    const python = createWorld({
      databaseDir,
      deploymentId: 'local-python',
    });

    await Promise.all([javascript.start(), python.start()]);
    await expect(javascript.getDeploymentId()).resolves.toBe('local-js');
    await expect(python.getDeploymentId()).resolves.toBe('local-python');
    await Promise.all([javascript.close(), python.close()]);
  });

  it('materializes run and step state with a dense concurrent event log', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    const input = new Uint8Array([1, 2]);
    const contextBacking = new Uint8Array([0, 3, 4, 0]);
    const createPromise = world.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase1//dense',
        input,
        executionContext: {
          bytes: contextBacking.subarray(1, 3),
          nested: [true, 2.5, null],
        },
        attributes: {
          $phase: 'one',
          backend: 'sqlite',
        },
        allowReservedAttributes: true,
      },
    });
    input.fill(9);
    contextBacking.fill(9);
    const created = await createPromise;
    const runId = created.run.runId;
    await world.events.create(
      runId,
      { eventType: 'run_started', specVersion: 7 },
      { eventCount: 1 }
    );

    const writes = await Promise.all([
      world.events.create(
        runId,
        {
          eventType: 'step_created',
          specVersion: 7,
          correlationId: 'step_alpha',
          eventData: {
            stepName: 'step//phase1//alpha',
            input: new Uint8Array([10]),
          },
        },
        { eventCount: 2 }
      ),
      world.events.create(
        runId,
        {
          eventType: 'step_created',
          specVersion: 7,
          correlationId: 'step_beta',
          eventData: {
            stepName: 'step//phase1//beta',
            input: new Uint8Array([20]),
          },
        },
        { eventCount: 2 }
      ),
    ]);

    const events = await world.events.list({ runId });
    expect(events.data.map((event) => event.eventId)).toEqual([
      'evnt_00000000000000000000000001',
      'evnt_00000000000000000000000002',
      'evnt_00000000000000000000000003',
      'evnt_00000000000000000000000004',
    ]);
    expect(writes.filter((write) => write.events?.length === 1)).toHaveLength(
      1
    );
    expect((await world.steps.list({ runId })).data).toHaveLength(2);
    const run = await world.runs.get(runId);
    expect(Array.from(run.input ?? [])).toEqual([1, 2]);
    expect(run.attributes).toEqual({
      $phase: 'one',
      backend: 'sqlite',
    });
    expect(Array.from(run.executionContext?.bytes as Uint8Array)).toEqual([
      3, 4,
    ]);

    await world.close();
  });

  it('rejects non-Uint8Array views in portable execution context', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    for (const bytes of [
      new Int32Array([1]),
      new Uint8ClampedArray([1]),
      new DataView(new ArrayBuffer(1)),
    ]) {
      await expect(
        world.events.create(null, {
          eventType: 'run_created',
          specVersion: 7,
          eventData: {
            deploymentId: 'local-js',
            workflowName: 'workflow//phase1//invalid-context-view',
            input: new Uint8Array(),
            executionContext: { bytes },
          },
        })
      ).rejects.toThrow(/Uint8Array/);
    }

    await world.close();
  });

  it('rejects numeric values that Node-API would otherwise coerce', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    for (const specVersion of [7.5, 2 ** 32 + 7, -(2 ** 32) + 7]) {
      await expect(
        world.events.create(null, {
          eventType: 'run_created',
          specVersion,
          eventData: {
            deploymentId: 'local-js',
            workflowName: 'workflow//phase1//invalid-spec',
            input: new Uint8Array(),
          },
        })
      ).rejects.toThrow(/specVersion/);
    }
    await expect(
      world.events.create('wrun_missing', {
        eventType: 'step_started',
        specVersion: 7,
        correlationId: 'step_invalid_attempt',
        eventData: { attempt: -1 },
      })
    ).rejects.toThrow(/attempt/);

    await world.close();
  });

  it('preserves retry-after metadata on early step starts', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase1//retry-after',
        input: new Uint8Array(),
      },
    });
    const runId = created.run.runId;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: 7,
    });
    await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: 7,
      correlationId: 'step_retry_after',
      eventData: {
        stepName: 'step//phase1//retry-after',
        input: new Uint8Array(),
      },
    });
    await world.events.create(runId, {
      eventType: 'step_retrying',
      specVersion: 7,
      correlationId: 'step_retry_after',
      eventData: {
        error: new Uint8Array([1]),
        retryAfter: new Date(Date.now() + 60_000),
      },
    });

    const earlyStart = world.events.create(runId, {
      eventType: 'step_started',
      specVersion: 7,
      correlationId: 'step_retry_after',
    });
    await expect(earlyStart).rejects.toBeInstanceOf(TooEarlyError);
    await expect(earlyStart).rejects.toMatchObject({
      retryAfter: expect.any(Number),
    });
    await earlyStart.catch((error: TooEarlyError) => {
      expect(error.retryAfter).toBeGreaterThan(0);
    });

    await world.close();
  });

  it('drains accepted native work before closing and maps stable errors', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();
    const pendingCreate = world.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase1//close',
        input: new Uint8Array([1]),
      },
    });
    const closing = world.close();
    const created = await pendingCreate;
    await closing;

    const reopened = createWorld({ databaseDir });
    await expect(reopened.runs.get(created.run.runId)).resolves.toMatchObject({
      runId: created.run.runId,
      status: 'pending',
    });
    await expect(reopened.runs.get('wrun_missing')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError
    );
    await expect(reopened.hooks.get('hook_missing')).rejects.toMatchObject({
      name: 'WorkflowWorldError',
      code: 'UNSUPPORTED_OPERATION',
    } satisfies Partial<WorkflowWorldError>);
    await reopened.close();
  });

  it('durably reuses message IDs for idempotent queue calls', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();
    const queueName = '__wkf_workflow_idempotent';
    const message = { runId: 'wrun_idempotent' };

    const first = await world.queue(queueName, message, {
      idempotencyKey: 'same-operation',
    });
    const duplicate = await world.queue(queueName, message, {
      idempotencyKey: 'same-operation',
    });
    expect(duplicate.messageId).toBe(first.messageId);
    await world.close();

    const reopened = createWorld({ databaseDir });
    await expect(
      reopened.queue(queueName, message, {
        idempotencyKey: 'same-operation',
      })
    ).resolves.toEqual(first);
    await expect(
      reopened.queue(
        queueName,
        { runId: 'wrun_different' },
        {
          idempotencyKey: 'same-operation',
        }
      )
    ).rejects.toThrow(/reused with different message data/);
    await reopened.close();
  });

  it('reopens state and completes a durable queue message in a fresh process', async () => {
    const databaseDir = await temporaryDirectory();
    const driver = fileURLToPath(
      new URL('../test/process-driver.mjs', import.meta.url)
    );
    const written = await execFileAsync(process.execPath, [
      driver,
      'write',
      databaseDir,
    ]);
    const writeResult = JSON.parse(written.stdout.trim()) as {
      runId: string;
      messageId: string;
    };

    const read = await execFileAsync(process.execPath, [
      driver,
      'read-and-consume',
      databaseDir,
      writeResult.runId,
    ]);
    const readResult = JSON.parse(read.stdout.trim()) as {
      runStatus: string;
      eventIds: string[];
      messageId: string;
      attempt: number;
      bytes: number[];
      queueMessageCount: number;
    };

    expect(readResult).toEqual({
      runStatus: 'running',
      eventIds: [
        'evnt_00000000000000000000000001',
        'evnt_00000000000000000000000002',
      ],
      messageId: writeResult.messageId,
      attempt: 1,
      bytes: [4, 5, 6],
      queueMessageCount: 0,
    });
  });
});
