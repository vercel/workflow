import { getWorkflowPort } from '@workflow/utils/get-port';
import { createLocalWorld } from '@workflow/world-local';
import {
  Logger,
  makeWorkerUtils,
  run,
  type WorkerUtils,
} from 'graphile-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from './index.js';
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

vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(),
}));

vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();
  return {
    ...actual,
    createLocalWorld: vi.fn(actual.createLocalWorld),
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
  const runnerMock = { stop: vi.fn() };
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
        Array<{ runId: string; workflowName: string }>
      >
    >
  ) {
    vi.mocked(createRunsStorage).mockReturnValue({
      list: vi.fn(async (params: any) => ({
        data: (runsByStatus[params?.status as 'pending' | 'running'] ?? []).map(
          (r) => ({ ...r, status: params?.status })
        ),
        hasMore: false,
        cursor: null,
      })),
      get: vi.fn(),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(makeWorkerUtils).mockResolvedValue(workerUtilsMock);
    vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
    vi.mocked(run).mockResolvedValue(runnerMock as any);
    vi.mocked(createLocalWorld).mockReturnValue({
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
    delete process.env.PORT;
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
        // First call for each status returns one run with hasMore=true,
        // second call returns empty.
        if (!params?.pagination?.cursor) {
          return {
            data: [
              {
                runId: `wrun_page1_${params?.status}`,
                workflowName: 'paginatedWf',
                status: params?.status,
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

    // Should have 4 list calls: 2 statuses × 2 pages each
    expect(callCount).toBe(4);

    // Should have enqueued 2 runs (one per status from first page)
    expect(workerUtilsMock.addJob).toHaveBeenCalledTimes(2);

    await world.close();
  });
});
