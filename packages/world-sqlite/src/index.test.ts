import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  EntityConflictError,
  HookNotFoundError,
  TooEarlyError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorld, nativeInfo, registerHost } from './index.js';
import { NativeSqliteWorld } from './native.js';

const execFileAsync = promisify(execFile);
const packageVersion = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
const temporaryDirectories: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'workflow-world-sqlite-')
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('@workflow/world-sqlite', () => {
  it('loads the N-API 8 addon with bundled SQLite 3.53.2', () => {
    expect(nativeInfo()).toMatchObject({
      crateVersion: '0.1.0',
      packageVersion,
      nodeApiVersion: 8,
      sqliteVersion: '3.53.2',
      schemaVersion: 5,
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

  it('releases the native database handle while the closed wrapper is retained', async () => {
    const databaseDir = await temporaryDirectory();
    const databasePath = path.join(databaseDir, 'workflow.sqlite');
    const native = new NativeSqliteWorld(databasePath);
    await native.migrate();
    await native.ensureReady();

    expect(native.close()).toBe(true);
    await rm(databaseDir, { recursive: true });
    await expect(access(databaseDir)).rejects.toThrow();
    expect(native.close()).toBe(false);
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

  it('scopes host registration by database identity and deployment target', async () => {
    const root = await temporaryDirectory();
    const application = path.join(root, 'application');
    const tests = path.join(root, 'tests');

    registerHost({
      databaseDir: application,
      deploymentId: 'local-js',
      queueNames: [],
      baseUrl: 'http://127.0.0.1:3101',
    });
    expect(() =>
      registerHost({
        databaseDir: application,
        deploymentId: 'local-js',
        queueNames: [],
        baseUrl: 'http://127.0.0.1:3101',
      })
    ).not.toThrow();
    expect(() =>
      registerHost({
        databaseDir: tests,
        deploymentId: 'local-js',
        queueNames: [],
        baseUrl: 'http://127.0.0.1:3102',
      })
    ).not.toThrow();
    expect(() =>
      registerHost({
        databaseDir: application,
        deploymentId: 'local-python',
        queueNames: [],
        baseUrl: 'http://127.0.0.1:3103',
      })
    ).not.toThrow();
    expect(() =>
      registerHost({
        databaseDir: application,
        deploymentId: 'local-js',
        queueNames: [],
        baseUrl: 'http://127.0.0.1:3199',
      })
    ).toThrow(/conflicting routing for this database and deployment target/);

    expect(() =>
      registerHost({
        databaseDir: path.join(root, 'wildcard'),
        queueNames: [],
        baseUrl: 'http://0.0.0.0:3105',
      })
    ).not.toThrow();
    expect(() =>
      registerHost({
        databaseDir: path.join(root, 'wildcard'),
        queueNames: [],
        baseUrl: 'http://127.0.0.1:3105',
      })
    ).not.toThrow();
  });

  it('uses an explicit PORT as the final loopback endpoint fallback', async () => {
    const databaseDir = await temporaryDirectory();
    vi.stubEnv('PORT', '3106');
    const startWorker = vi
      .spyOn(NativeSqliteWorld.prototype, 'startQueueWorker')
      .mockImplementation(() => undefined);
    vi.spyOn(NativeSqliteWorld.prototype, 'stopQueueWorker').mockResolvedValue({
      claims: 0,
      acknowledgements: 0,
      reschedules: 0,
      deliveryFailures: 0,
      storageFailures: 0,
    });
    const world = createWorld({
      databaseDir,
      queueNames: ['__wkf_workflow_port-fallback'],
      recoverActiveRuns: false,
    });
    await world.migrate();
    await world.start();
    expect(startWorker.mock.calls[0]?.[2]).toBe(
      'http://127.0.0.1:3106/.well-known/workflow/v1/flow'
    );
    await world.close();
  });

  it('validates and reads through a checksum-pinned read-only handle', async () => {
    const databaseDir = await temporaryDirectory();
    const writer = createWorld({ databaseDir });
    await writer.migrate();
    const created = await writer.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase2//read-only',
        input: new Uint8Array([1, 2, 3]),
      },
    });
    await writer.close();

    const reader = createWorld({
      databaseFile: writer.databasePath,
      readOnly: true,
    });
    await reader.validate();
    await expect(reader.runs.get(created.run.runId)).resolves.toMatchObject({
      runId: created.run.runId,
      workflowName: 'workflow//phase2//read-only',
    });
    await expect(reader.clear()).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(reader.start()).rejects.toMatchObject({ code: 'READ_ONLY' });
    await reader.close();
  });

  it('does not validate write-only host settings for read-only inspection', async () => {
    const databaseDir = await temporaryDirectory();
    const writer = createWorld({ databaseDir });
    await writer.migrate();
    await writer.close();

    vi.stubEnv('WORKFLOW_LOCAL_BASE_URL', 'not-a-loopback-url');
    vi.stubEnv('WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS', 'not-a-number');
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'INVALID NAMESPACE');
    const reader = createWorld({
      databaseFile: writer.databasePath,
      readOnly: true,
    });
    await expect(reader.validate()).resolves.toBeUndefined();
    await expect(reader.getDeploymentId()).resolves.toBe('local-js');
    await reader.close();
  });

  it('recovers only the selected deployment with a deterministic queue row', async () => {
    const databaseDir = await temporaryDirectory();
    const setup = createWorld({ databaseDir, recoverActiveRuns: false });
    await setup.migrate();
    await setup.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase2//recover',
        input: new Uint8Array(),
      },
    });
    await setup.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'other-target',
        workflowName: 'workflow//phase2//other',
        input: new Uint8Array(),
      },
    });
    await setup.close();

    for (let attempt = 0; attempt < 2; attempt++) {
      const recovering = createWorld({ databaseDir });
      await recovering.start();
      await recovering.close();
    }

    const inspectorWorld = createWorld({ databaseDir });
    const inspector = new NativeSqliteWorld(inspectorWorld.databasePath);
    await expect(inspector.queueMessageCount('local-js')).resolves.toBe(1);
    await expect(inspector.queueMessageCount('other-target')).resolves.toBe(0);
    inspector.close();
    await inspectorWorld.close();
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
    const emptyCursorSteps = await world.steps.list({
      runId,
      pagination: { cursor: '', sortOrder: 'desc' },
    });
    expect(emptyCursorSteps.data).toHaveLength(2);
    const emptyCursorEvents = await world.events.list({
      runId,
      pagination: { cursor: '', limit: 10, sortOrder: 'desc' },
    });
    expect(emptyCursorEvents.data).toHaveLength(4);
    await expect(
      world.runs.list({
        pagination: { cursor: '', sortOrder: 'desc' },
      })
    ).resolves.toMatchObject({
      data: [expect.objectContaining({ runId })],
    });
    const run = await world.runs.get(runId);
    expect(Array.from(run.input ?? [])).toEqual([1, 2]);
    expect(run.input?.constructor).toBe(Uint8Array);
    expect(Buffer.isBuffer(run.input)).toBe(false);
    const createdEventInput = (
      events.data[0]?.eventData as { input?: Uint8Array } | undefined
    )?.input;
    expect(createdEventInput?.constructor).toBe(Uint8Array);
    expect(Buffer.isBuffer(createdEventInput)).toBe(false);
    expect(run.attributes).toEqual({
      $phase: 'one',
      backend: 'sqlite',
    });
    expect(Array.from(run.executionContext?.bytes as Uint8Array)).toEqual([
      3, 4,
    ]);
    expect(
      (run.executionContext?.bytes as Uint8Array | undefined)?.constructor
    ).toBe(Uint8Array);
    expect(Buffer.isBuffer(run.executionContext?.bytes)).toBe(false);

    await world.close();
  });

  it('returns every remaining event when list pagination limit is omitted', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase2//unpaginated-events',
        input: new Uint8Array(),
      },
    });
    for (let index = 0; index < 105; index++) {
      await world.events.create(created.run.runId, {
        eventType: 'run_cancelled',
        specVersion: 7,
      });
    }

    const allEvents = await world.events.list({ runId: created.run.runId });
    expect(allEvents.data).toHaveLength(106);
    expect(allEvents.hasMore).toBe(false);
    const firstPage = await world.events.list({
      runId: created.run.runId,
      pagination: { limit: 100 },
    });
    expect(firstPage.data).toHaveLength(100);
    expect(firstPage.hasMore).toBe(true);

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

  it('rejects non-loopback delivery URLs and excessive worker concurrency', () => {
    expect(() => createWorld({ baseUrl: 'https://127.0.0.1:3000' })).toThrow(
      /loopback http URL/
    );
    expect(() => createWorld({ flowUrl: 'http://example.com/flow' })).toThrow(
      /loopback http URL/
    );
    expect(() => createWorld({ workerConcurrency: 257 })).toThrow(
      /between 1 and 256/
    );
    expect(() => createWorld({ hookRetentionLimitDays: 0 })).toThrow(
      /positive, safe number/
    );
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

  it('maps Phase 2 attributes, Hooks, and waits through the World surface', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase2//entities',
        input: new Uint8Array(),
      },
    });
    const runId = created.run.runId;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: 7,
    });
    await world.events.create(runId, {
      eventType: 'attr_set',
      specVersion: 7,
      eventData: {
        changes: [{ key: 'phase', value: 'two' }],
        writer: { type: 'workflow' },
      },
    });

    const retention = new Date(Date.now() + 60_000);
    const hookResult = await world.events.create(runId, {
      eventType: 'hook_created',
      specVersion: 7,
      correlationId: 'hook_phase2',
      eventData: {
        token: 'phase2-token',
        metadata: new Uint8Array([4, 2]),
        isWebhook: false,
        tokenRetentionUntil: retention,
      },
    });
    expect(hookResult.hook).toMatchObject({
      runId,
      hookId: 'hook_phase2',
      token: 'phase2-token',
      isWebhook: false,
      createdAt: expect.any(Date),
      tokenRetentionUntil: retention,
    });
    expect(hookResult.hook?.metadata?.constructor).toBe(Uint8Array);
    expect(Buffer.isBuffer(hookResult.hook?.metadata)).toBe(false);
    await expect(
      world.hooks.getByToken('phase2-token', { resolveData: 'none' })
    ).resolves.toMatchObject({ metadata: undefined });
    await expect(
      world.hooks.list({
        runId,
        pagination: { cursor: '', sortOrder: 'desc' },
      })
    ).resolves.toMatchObject({
      data: [expect.objectContaining({ hookId: 'hook_phase2' })],
      hasMore: false,
    });

    const resumeAt = new Date(Date.now() + 1_000);
    const waitCreated = await world.events.create(runId, {
      eventType: 'wait_created',
      specVersion: 7,
      correlationId: 'wait_phase2',
      eventData: { resumeAt },
    });
    expect(waitCreated.wait).toMatchObject({
      runId,
      waitId: `${runId}-wait_phase2`,
      status: 'waiting',
      resumeAt,
      createdAt: expect.any(Date),
    });
    const waitCompleted = await world.events.create(runId, {
      eventType: 'wait_completed',
      specVersion: 7,
      correlationId: 'wait_phase2',
    });
    expect(waitCompleted.wait).toMatchObject({
      status: 'completed',
      resumeAt,
      completedAt: expect.any(Date),
    });
    await expect(world.runs.get(runId)).resolves.toMatchObject({
      attributes: { phase: 'two' },
    });

    await world.close();
  });

  it('rejects a cross-run Hook ID collision atomically', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    const createRun = async (workflowName: string) =>
      world.events.create(null, {
        eventType: 'run_created',
        specVersion: 7,
        eventData: {
          deploymentId: 'local-js',
          workflowName,
          input: new Uint8Array(),
        },
      });
    const owner = await createRun('workflow//phase2//hook-id-owner');
    const contender = await createRun('workflow//phase2//hook-id-contender');
    await world.events.create(owner.run.runId, {
      eventType: 'hook_created',
      specVersion: 7,
      correlationId: 'globally-shared-hook-id',
      eventData: {
        token: 'owner-token',
        metadata: new Uint8Array([1, 2, 3]),
      },
    });

    const before = await world.events.list({ runId: contender.run.runId });
    await expect(
      world.events.create(contender.run.runId, {
        eventType: 'hook_created',
        specVersion: 7,
        correlationId: 'globally-shared-hook-id',
        eventData: {
          token: 'distinct-token',
          metadata: new Uint8Array([9, 9, 9]),
        },
      })
    ).rejects.toBeInstanceOf(EntityConflictError);

    await expect(
      world.events.list({ runId: contender.run.runId })
    ).resolves.toEqual(before);
    await expect(
      world.hooks.get('globally-shared-hook-id')
    ).resolves.toMatchObject({
      runId: owner.run.runId,
      token: 'owner-token',
      metadata: new Uint8Array([1, 2, 3]),
    });
    await expect(
      world.hooks.getByToken('distinct-token')
    ).rejects.toBeInstanceOf(HookNotFoundError);

    await world.close();
  });

  it('enforces the configured Hook retention ceiling before native mutation', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir, hookRetentionLimitDays: 1 });
    await world.migrate();
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 7,
      eventData: {
        deploymentId: 'local-js',
        workflowName: 'workflow//phase2//retention-limit',
        input: new Uint8Array(),
      },
    });

    await expect(
      world.events.create(created.run.runId, {
        eventType: 'hook_created',
        specVersion: 7,
        correlationId: 'hook_too_long',
        eventData: {
          token: 'hook-too-long-token',
          tokenRetentionUntil: new Date(Date.now() + 2 * DAY_MS),
        },
      })
    ).rejects.toThrow(/cannot exceed 1 days/);
    await expect(world.hooks.get('hook_too_long')).rejects.toBeInstanceOf(
      HookNotFoundError
    );

    await world.close();
  });

  it('reads every page of an already-closed synthetic health stream', async () => {
    const databaseDir = await temporaryDirectory();
    const world = createWorld({ databaseDir });
    await world.migrate();

    await world.streams.writeMulti('wrun_health_synthetic', 'health', [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);
    await world.streams.close('wrun_health_synthetic', 'health');

    const page = await world.streams.getChunks(
      'wrun_health_synthetic',
      'health',
      { cursor: '', limit: 1 }
    );
    expect(page.data[0]?.data.constructor).toBe(Uint8Array);
    expect(Buffer.isBuffer(page.data[0]?.data)).toBe(false);

    const reader = (
      await world.streams.get('wrun_health_synthetic', 'health')
    ).getReader();
    const bytes: number[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes.push(...chunk.value);
    }
    expect(bytes).toEqual([1, 2, 3]);

    await world.clear();
    await expect(world.streams.list('wrun_health_synthetic')).resolves.toEqual(
      []
    );
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
    await expect(reopened.hooks.get('hook_missing')).rejects.toBeInstanceOf(
      HookNotFoundError
    );
    await reopened.close();
  });

  it('surfaces background storage failures on shutdown and still closes native state', async () => {
    const databaseDir = await temporaryDirectory();
    vi.spyOn(
      NativeSqliteWorld.prototype,
      'startQueueWorker'
    ).mockImplementation(() => undefined);
    vi.spyOn(NativeSqliteWorld.prototype, 'stopQueueWorker').mockResolvedValue({
      claims: 4,
      acknowledgements: 2,
      reschedules: 1,
      deliveryFailures: 1,
      storageFailures: 2,
    });
    const nativeClose = vi.spyOn(NativeSqliteWorld.prototype, 'close');
    const world = createWorld({
      databaseDir,
      queueNames: ['__wkf_workflow_shutdown'],
      baseUrl: 'http://127.0.0.1:3104',
      recoverActiveRuns: false,
    });
    await world.migrate();
    await world.start();

    await expect(world.close()).rejects.toMatchObject({
      code: 'QUEUE_STORAGE_FAILURE',
      status: 503,
    });
    expect(nativeClose).toHaveBeenCalledTimes(1);
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
