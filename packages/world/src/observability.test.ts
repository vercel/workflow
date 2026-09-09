import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRun, World } from './index.js';
import { createAggregatedObservabilityWorld } from './observability.js';

function missingRun(runId: string): Error & { status: number } {
  return Object.assign(new Error(`Workflow run ${runId} was not found`), {
    name: 'WorkflowRunNotFoundError',
    status: 404,
  });
}

function run(runId: string, createdAt: string): WorkflowRun {
  return {
    runId,
    status: 'completed',
    deploymentId: 'local-js',
    workflowName: 'workflow',
    attributes: {},
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    completedAt: new Date(createdAt),
  };
}

function fakeWorld(runs: WorkflowRun[]) {
  const get = vi.fn(async (runId: string) => {
    const value = runs.find((candidate) => candidate.runId === runId);
    if (!value) throw missingRun(runId);
    return value;
  });
  const list = vi.fn(async (params?: { pagination?: { cursor?: string } }) => {
    const index = Number(params?.pagination?.cursor ?? 0);
    const value = runs[index];
    return {
      data: value ? [value] : [],
      cursor: value ? String(index + 1) : null,
      hasMore: index + 1 < runs.length,
    };
  });
  const stepsList = vi.fn(async () => ({
    data: [],
    cursor: null,
    hasMore: false,
  }));

  const world = {
    specVersion: 7,
    runs: { get, list },
    steps: {
      get: vi.fn(),
      list: stepsList,
    },
    events: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      listByCorrelationId: vi.fn(),
    },
    hooks: {
      get: vi.fn(async () => {
        throw Object.assign(new Error('missing hook'), {
          name: 'HookNotFoundError',
          status: 404,
        });
      }),
      getByToken: vi.fn(async () => {
        throw Object.assign(new Error('missing hook'), {
          name: 'HookNotFoundError',
          status: 404,
        });
      }),
      list: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
    },
    streams: {
      write: vi.fn(),
      close: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      getChunks: vi.fn(),
      getInfo: vi.fn(),
    },
    getDeploymentId: vi.fn(async () => 'local-js'),
    queue: vi.fn(),
    createQueueHandler: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as World;

  return { world, get, list, stepsList };
}

describe('aggregated observability World', () => {
  it('merges independent pages and reports each run source without mutating it', async () => {
    const application = fakeWorld([
      run('run-app-new', '2026-01-04T00:00:00Z'),
      run('run-app-old', '2026-01-01T00:00:00Z'),
    ]);
    const vitest = fakeWorld([
      run('run-test-new', '2026-01-03T00:00:00Z'),
      run('run-test-old', '2026-01-02T00:00:00Z'),
    ]);
    const aggregate = createAggregatedObservabilityWorld([
      { source: 'workflow.sqlite', world: application.world },
      { source: 'vitest-0.sqlite', world: vitest.world },
    ]);

    const first = await aggregate.runs.list({
      pagination: { limit: 3, sortOrder: 'desc' },
      resolveData: 'none',
    });
    expect(first.data.map(({ runId }) => runId)).toEqual([
      'run-app-new',
      'run-test-new',
      'run-test-old',
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBeTypeOf('string');

    const second = await aggregate.runs.list({
      pagination: {
        limit: 3,
        sortOrder: 'desc',
        cursor: first.cursor ?? undefined,
      },
      resolveData: 'none',
    });
    expect(second.data.map(({ runId }) => runId)).toEqual(['run-app-old']);
    expect(second.hasMore).toBe(false);

    const listedRun = first.data[1];
    expect(listedRun).toBeDefined();
    if (!listedRun) throw new Error('Expected a second listed run');
    const fields = await aggregate.describeRun?.(listedRun);
    expect(fields).toEqual({ observabilitySource: 'vitest-0.sqlite' });
    expect(listedRun).not.toHaveProperty('observabilitySource');
  });

  it('routes run-scoped reads to the database that owns the run', async () => {
    const application = fakeWorld([]);
    const vitest = fakeWorld([run('run-test', '2026-01-01T00:00:00Z')]);
    const aggregate = createAggregatedObservabilityWorld([
      { source: 'workflow.sqlite', world: application.world },
      { source: 'vitest-worker.sqlite', world: vitest.world },
    ]);

    await aggregate.steps.list({ runId: 'run-test' });
    expect(application.get).toHaveBeenCalledWith('run-test', {
      resolveData: 'none',
    });
    expect(vitest.get).toHaveBeenCalledWith('run-test', {
      resolveData: 'none',
    });
    expect(application.stepsList).not.toHaveBeenCalled();
    expect(vitest.stepsList).toHaveBeenCalledWith({ runId: 'run-test' });

    await aggregate.steps.list({ runId: 'run-test' });
    expect(application.get).toHaveBeenCalledTimes(2);
    expect(vitest.get).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate run IDs instead of silently choosing a database', async () => {
    const application = fakeWorld([run('duplicate', '2026-01-01T00:00:00Z')]);
    const vitest = fakeWorld([run('duplicate', '2026-01-01T00:00:00Z')]);
    const aggregate = createAggregatedObservabilityWorld([
      { source: 'workflow.sqlite', world: application.world },
      { source: 'vitest-0.sqlite', world: vitest.world },
    ]);

    await expect(
      aggregate.runs.list({ pagination: { limit: 2 } })
    ).rejects.toThrow('multiple SQLite observability databases');
  });

  it('revalidates a run selected by a short list page before returning it', async () => {
    const application = fakeWorld([run('duplicate', '2026-01-02T00:00:00Z')]);
    const vitest = fakeWorld([run('duplicate', '2026-01-01T00:00:00Z')]);
    const aggregate = createAggregatedObservabilityWorld([
      { source: 'workflow.sqlite', world: application.world },
      { source: 'vitest-0.sqlite', world: vitest.world },
    ]);

    await expect(
      aggregate.runs.list({ pagination: { limit: 1, sortOrder: 'desc' } })
    ).rejects.toThrow('multiple SQLite observability databases');
  });

  it('fails closed when one database cannot participate in uniqueness checks', async () => {
    const application = fakeWorld([run('run-app', '2026-01-02T00:00:00Z')]);
    const unavailable = fakeWorld([]);
    const storageError = Object.assign(new Error('SQLite source unavailable'), {
      status: 503,
    });
    unavailable.get.mockRejectedValue(storageError);
    vi.spyOn(application.world.hooks, 'get').mockResolvedValue({
      hookId: 'hook-app',
      runId: 'run-app',
    } as never);
    vi.spyOn(unavailable.world.hooks, 'get').mockRejectedValue(storageError);
    const aggregate = createAggregatedObservabilityWorld([
      { source: 'workflow.sqlite', world: application.world },
      { source: 'vitest-0.sqlite', world: unavailable.world },
    ]);

    await expect(aggregate.runs.get('run-app')).rejects.toBe(storageError);
    await expect(
      aggregate.runs.list({ pagination: { limit: 1 } })
    ).rejects.toBe(storageError);
    await expect(aggregate.hooks.get('hook-app')).rejects.toBe(storageError);
  });

  it('closes every source without starting their workers', async () => {
    const application = fakeWorld([]);
    const vitest = fakeWorld([]);
    const aggregate = createAggregatedObservabilityWorld([
      { source: 'workflow.sqlite', world: application.world },
      { source: 'vitest-0.sqlite', world: vitest.world },
    ]);

    await aggregate.start?.();
    await aggregate.close?.();
    expect(application.world.close).toHaveBeenCalledTimes(1);
    expect(vitest.world.close).toHaveBeenCalledTimes(1);
  });
});
