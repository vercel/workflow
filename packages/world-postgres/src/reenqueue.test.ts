import { getWorkflowPort } from '@workflow/utils/get-port';
import { createWorld as createLocalTestWorld } from '@workflow/world-local';
import { makeWorkerUtils, run, type WorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from './index.js';
import { MessageData } from './message.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

vi.mock('graphile-worker', () => ({
  Logger: class Logger {
    constructor(_: unknown) {}
  },
  makeWorkerUtils: vi.fn(),
  run: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: vi.fn(function Pool() {
    return {
      query: vi.fn(async () => ({ rows: [{ exists: false }] })),
      end: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(),
}));

vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();
  return {
    ...actual,
    createWorld: vi.fn(actual.createWorld),
  };
});

vi.mock('./storage.js', () => ({
  createRunsStorage: vi.fn(),
  createEventsStorage: vi.fn(),
  createHooksStorage: vi.fn(),
  createStepsStorage: vi.fn(),
}));

vi.mock('./streamer.js', () => ({
  createStreamer: vi.fn(() => ({
    streams: {
      write: vi.fn(),
      writeMulti: vi.fn(),
      close: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      getChunks: vi.fn(),
      getInfo: vi.fn(),
    },
    close: vi.fn(),
  })),
}));

describe('re-enqueue active runs on start', () => {
  const workerUtilsMock = {
    addJob: vi.fn(),
    migrate: vi.fn(),
    release: vi.fn(),
  } as unknown as WorkerUtils;
  const runnerMock = {
    stop: vi.fn(),
    promise: Promise.resolve(),
  };
  const localWorldClose = vi.fn();
  const wrappedHandler = vi.fn(async () => Response.json({ ok: true }));
  const createQueueHandler = vi.fn(() => wrappedHandler);
  const pool = {
    query: vi.fn(async () => ({ rows: [{ exists: false }] })),
    end: vi.fn(),
  } as any;

  function mockRunsList(
    runsByStatus: Partial<
      Record<
        'pending' | 'running',
        Array<{ runId: string; workflowName: string; deploymentId?: string }>
      >
    >
  ) {
    vi.mocked(createRunsStorage).mockReturnValue({
      list: vi.fn(async (params: any) => {
        const statuses = Array.isArray(params?.status)
          ? (params.status as Array<'pending' | 'running'>)
          : params?.status
            ? [params.status as 'pending' | 'running']
            : (['pending', 'running'] as const);
        const data = statuses.flatMap((status) =>
          (runsByStatus[status] ?? []).map((r) => ({
            deploymentId: 'postgres',
            ...r,
            status,
          }))
        );
        return { data, hasMore: false, cursor: null };
      }),
      get: vi.fn(),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runnerMock.promise = Promise.resolve();
    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtilsMock);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
    vi.mocked(run).mockResolvedValue(runnerMock as any);
    vi.mocked(createLocalTestWorld).mockReturnValue({
      createQueueHandler,
      close: localWorldClose,
    } as any);
    vi.mocked(createEventsStorage).mockReturnValue({} as any);
    vi.mocked(createHooksStorage).mockReturnValue({} as any);
    vi.mocked(createStepsStorage).mockReturnValue({} as any);

    // Default: no active runs
    mockRunsList({});
  });

  afterEach(async () => {
    delete process.env.WORKFLOW_LOCAL_BASE_URL;
    delete process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN;
    delete process.env.WORKFLOW_POSTGRES_URL;
    delete process.env.DATABASE_URL;
    delete process.env.PORT;
    delete process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING;
    delete process.env.WORKFLOW_DEPLOYMENT_ID;
  });

  it('falls back to DATABASE_URL when WORKFLOW_POSTGRES_URL is unset', async () => {
    process.env.DATABASE_URL = 'postgres://database-url';

    const world = createWorld();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://database-url',
      })
    );

    await world.close();
  });

  it('prefers WORKFLOW_POSTGRES_URL over DATABASE_URL', async () => {
    process.env.WORKFLOW_POSTGRES_URL = 'postgres://workflow-postgres-url';
    process.env.DATABASE_URL = 'postgres://database-url';

    const world = createWorld();

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://workflow-postgres-url',
      })
    );

    await world.close();
  });

  it('keeps automatic shutdown in createWorld() by default', async () => {
    const world = createWorld();
    await world.start();

    expect(run).toHaveBeenCalledWith(
      expect.not.objectContaining({ noHandleSignals: true })
    );

    await world.close();
  });

  it('lets createWorld() environment configuration use application-managed shutdown', async () => {
    process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN = '1';

    const world = createWorld();
    await world.start();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ noHandleSignals: true })
    );

    await world.close();
  });

  it('stays the single postgres deployment unless routing is enabled', async () => {
    process.env.WORKFLOW_DEPLOYMENT_ID = 'build_a';

    const world = createWorld();
    await world.start();

    expect(await world.getDeploymentId()).toBe('postgres');
    expect(world.capabilities).not.toHaveProperty('deploymentAffinity');
    expect(
      Object.keys(vi.mocked(run).mock.calls[0]?.[0]?.taskList ?? {})
    ).toEqual(['workflow_flows']);

    await world.close();
  });

  it('runs as WORKFLOW_DEPLOYMENT_ID when routing is enabled', async () => {
    process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING = '1';
    process.env.WORKFLOW_DEPLOYMENT_ID = 'build_a';

    const world = createWorld();
    await world.start();

    expect(await world.getDeploymentId()).toBe('build_a');
    expect(world.capabilities.deploymentAffinity).toBe(true);
    expect(
      Object.keys(vi.mocked(run).mock.calls[0]?.[0]?.taskList ?? {})
    ).toEqual(['workflow_flows@build_a']);

    await world.close();
  });

  it('refuses to enable routing without WORKFLOW_DEPLOYMENT_ID', () => {
    process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING = '1';

    expect(() => createWorld()).toThrow(
      'WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1 requires WORKFLOW_DEPLOYMENT_ID'
    );
  });

  it.each([
    'postgres',
    'latest',
    'build a',
    'build/a',
    'x'.repeat(65),
  ])('rejects the deployment id %j', (deploymentId) => {
    expect(() => createWorld({ pool, deploymentId })).toThrow(
      'Invalid Postgres World deployment id'
    );
  });

  it('re-enqueues active runs via graphile-worker on start', async () => {
    mockRunsList({
      pending: [{ runId: 'wrun_AAA', workflowName: 'wfA' }],
      running: [{ runId: 'wrun_BBB', workflowName: 'wfB' }],
    });

    const world = createWorld({ connectionString: 'postgres://test', pool });
    await world.start();

    expect(workerUtilsMock.addJob).toHaveBeenCalledTimes(2);
    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({ id: 'wfA' }),
      expect.anything()
    );
    expect(workerUtilsMock.addJob).toHaveBeenCalledWith(
      'workflow_flows',
      expect.objectContaining({ id: 'wfB' }),
      expect.anything()
    );

    await world.close();
  });

  it.each([
    [undefined, 'wrun_LEGACY', 'workflow_flows'],
    ['build_a', 'wrun_A', 'workflow_flows@build_a'],
  ])('recovers only the runs of deployment %s', async (deploymentId, runId, task) => {
    mockRunsList({
      running: [
        { runId: 'wrun_LEGACY', workflowName: 'wf' },
        { runId: 'wrun_A', workflowName: 'wf', deploymentId: 'build_a' },
        { runId: 'wrun_B', workflowName: 'wf', deploymentId: 'build_b' },
      ],
    });

    const world = createWorld({ pool, deploymentId });
    await world.start();

    const jobs = vi
      .mocked(workerUtilsMock.addJob)
      .mock.calls.map(([identifier, payload]) => [
        identifier,
        JSON.parse(MessageData.parse(payload).data.toString()).runId,
      ]);
    expect(jobs).toEqual([[task, runId]]);

    await world.close();
  });

  it('does not enqueue anything when there are no active runs', async () => {
    mockRunsList({});

    const world = createWorld({ connectionString: 'postgres://test', pool });
    await world.start();

    // addJob should only have been called for pgboss migration check, not for
    // any workflow runs. The migration check uses pool.query, not addJob.
    expect(workerUtilsMock.addJob).not.toHaveBeenCalled();

    await world.close();
  });

  it('pages through all active runs', async () => {
    let callCount = 0;
    vi.mocked(createRunsStorage).mockReturnValue({
      list: vi.fn(async (params: any) => {
        callCount++;
        // First call returns two runs (one per status) with hasMore=true,
        // second call returns empty. Assumes the caller asked for both
        // statuses in one array — see recovery.ts's `status: ['pending', 'running']`.
        if (!params?.pagination?.cursor) {
          return {
            data: [
              {
                runId: 'wrun_page1_pending',
                workflowName: 'paginatedWf',
                status: 'pending',
                deploymentId: 'postgres',
              },
              {
                runId: 'wrun_page1_running',
                workflowName: 'paginatedWf',
                status: 'running',
                deploymentId: 'postgres',
              },
            ],
            hasMore: true,
            cursor: 'next',
          };
        }
        return { data: [], hasMore: false, cursor: null };
      }),
      get: vi.fn(),
    } as any);

    const world = createWorld({ connectionString: 'postgres://test', pool });
    await world.start();

    // Should have 2 list calls: single non-terminal filter × 2 pages.
    // (Prior: 4 calls, once per status × 2 pages.)
    expect(callCount).toBe(2);

    // Should have enqueued 2 runs (both statuses from first page).
    expect(workerUtilsMock.addJob).toHaveBeenCalledTimes(2);

    await world.close();
  });

  it('closes owned resources in dependency order', async () => {
    runnerMock.stop.mockResolvedValueOnce(undefined);
    let resolveRunnerFinished!: () => void;
    runnerMock.promise = new Promise<void>((resolve) => {
      resolveRunnerFinished = resolve;
    });
    const world = createWorld({ connectionString: 'postgres://test' });
    await world.start();
    const streamer = vi.mocked(createStreamer).mock.results.at(-1)?.value;
    const internalPool = vi.mocked(Pool).mock.results.at(-1)?.value;
    let resolveStreamerClose!: () => void;
    streamer?.close.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStreamerClose = resolve;
      })
    );

    const closePromise = world.close();
    await vi.waitFor(() => {
      expect(runnerMock.stop).toHaveBeenCalledOnce();
    });
    expect(streamer?.close).not.toHaveBeenCalled();

    resolveRunnerFinished();
    await vi.waitFor(() => {
      expect(streamer?.close).toHaveBeenCalledOnce();
    });
    expect(internalPool?.end).not.toHaveBeenCalled();

    resolveStreamerClose();
    await closePromise;

    expect(internalPool?.end).toHaveBeenCalledOnce();
  });

  it('waits for Graphile-owned shutdown when the runner is already stopped', async () => {
    runnerMock.stop.mockRejectedValueOnce(
      new Error('Runner is already stopped')
    );
    let resolveRunnerFinished!: () => void;
    runnerMock.promise = new Promise<void>((resolve) => {
      resolveRunnerFinished = resolve;
    });
    const world = createWorld({ connectionString: 'postgres://test' });
    await world.start();

    const closePromise = world.close();
    await vi.waitFor(() => {
      expect(runnerMock.stop).toHaveBeenCalledOnce();
    });
    expect(workerUtilsMock.release).not.toHaveBeenCalled();

    resolveRunnerFinished();

    await expect(closePromise).resolves.toBeUndefined();
    expect(workerUtilsMock.release).toHaveBeenCalledOnce();
  });

  it('continues cleanup when the Graphile runner finishes with an error', async () => {
    runnerMock.stop.mockResolvedValueOnce(undefined);
    let rejectRunnerFinished!: (error: Error) => void;
    runnerMock.promise = new Promise<void>((_resolve, reject) => {
      rejectRunnerFinished = reject;
    });
    const world = createWorld({ connectionString: 'postgres://test' });
    await world.start();
    const streamer = vi.mocked(createStreamer).mock.results.at(-1)?.value;
    const internalPool = vi.mocked(Pool).mock.results.at(-1)?.value;

    const closePromise = world.close();
    await vi.waitFor(() => {
      expect(runnerMock.stop).toHaveBeenCalledOnce();
    });
    rejectRunnerFinished(new Error('worker failed'));

    await expect(closePromise).resolves.toBeUndefined();
    expect(workerUtilsMock.release).toHaveBeenCalledOnce();
    expect(localWorldClose).toHaveBeenCalledOnce();
    expect(streamer?.close).toHaveBeenCalledOnce();
    expect(internalPool?.end).toHaveBeenCalledOnce();
  });

  it('allows close to be retried after queue cleanup fails', async () => {
    localWorldClose
      .mockRejectedValueOnce(new Error('transient local shutdown error'))
      .mockResolvedValueOnce(undefined);
    const world = createWorld({ connectionString: 'postgres://test' });
    await world.start();
    const streamer = vi.mocked(createStreamer).mock.results.at(-1)?.value;
    const internalPool = vi.mocked(Pool).mock.results.at(-1)?.value;

    await expect(world.close()).rejects.toThrow(
      'transient local shutdown error'
    );
    expect(streamer?.close).not.toHaveBeenCalled();
    expect(internalPool?.end).not.toHaveBeenCalled();

    await expect(world.close()).resolves.toBeUndefined();
    expect(runnerMock.stop).toHaveBeenCalledOnce();
    expect(workerUtilsMock.release).toHaveBeenCalledOnce();
    expect(localWorldClose).toHaveBeenCalledTimes(2);
    expect(streamer?.close).toHaveBeenCalledOnce();
    expect(internalPool?.end).toHaveBeenCalledOnce();
  });

  it('listens for connection errors on a pool it creates, not on a caller-owned one', () => {
    createWorld({ connectionString: 'postgres://test' });
    const internalPool = vi.mocked(Pool).mock.results.at(-1)?.value;
    expect(internalPool?.on).toHaveBeenCalledWith(
      'connect',
      expect.any(Function)
    );
    expect(internalPool?.on).toHaveBeenCalledWith(
      'error',
      expect.any(Function)
    );

    const callerPool = { ...pool, on: vi.fn() };
    createWorld({ pool: callerPool });
    expect(callerPool.on).not.toHaveBeenCalled();
  });

  it('does not close a caller-owned pool', async () => {
    const world = createWorld({ pool });
    await world.start();

    await world.close();

    expect(pool.end).not.toHaveBeenCalled();
  });
});
