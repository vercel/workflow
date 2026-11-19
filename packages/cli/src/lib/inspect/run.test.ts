import type { World } from '@workflow/world';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startRun } from './run.js';

vi.mock('@workflow/core/runtime', () => ({
  start: vi.fn().mockResolvedValue({ runId: 'wrun_new' }),
}));
vi.mock('@workflow/core/runtime/helpers', () => ({
  healthCheck: vi.fn().mockResolvedValue({ healthy: false }),
}));
vi.mock('../config/log.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('startRun', () => {
  beforeEach(async () => {
    const { start } = await import('@workflow/core/runtime');
    vi.mocked(start).mockClear();
  });

  const startOpts = async () => {
    const { start } = await import('@workflow/core/runtime');
    expect(start).toHaveBeenCalledOnce();
    const call = vi.mocked(start).mock.calls[0] as unknown[];
    return { workflow: call[0], opts: call[2] as Record<string, unknown> };
  };

  it('starts a workflow that has never run on the latest deployment', async () => {
    // The target comes from the World's resolveLatestDeploymentId(), the
    // path start() takes for deploymentId: 'latest', not from run history.
    const world = {
      specVersion: 8,
      resolveLatestDeploymentId: vi.fn().mockResolvedValue('dpl_latest'),
      getDeploymentId: vi.fn(),
      runs: { get: vi.fn(), list: vi.fn() },
      analytics: { runs: { list: vi.fn() } },
    };

    await startRun(world as unknown as World, 'workflow//./src/a//a', {}, []);

    const { workflow, opts } = await startOpts();
    expect(workflow).toEqual({ workflowId: 'workflow//./src/a//a' });
    expect(opts).toMatchObject({ deploymentId: 'dpl_latest' });
    expect(world.resolveLatestDeploymentId).toHaveBeenCalledOnce();
    expect(world.runs.list).not.toHaveBeenCalled();
    expect(world.analytics.runs.list).not.toHaveBeenCalled();
  });

  it('uses the current deployment in a World without atomic deployments', async () => {
    const world = {
      specVersion: 8,
      getDeploymentId: vi.fn().mockResolvedValue('dpl_local@1.0.0'),
      runs: { get: vi.fn(), list: vi.fn() },
    };

    await startRun(world as unknown as World, 'workflow//./src/a//a', {}, []);

    const { opts } = await startOpts();
    expect(opts).toMatchObject({ deploymentId: 'dpl_local@1.0.0' });
    expect(world.runs.list).not.toHaveBeenCalled();
  });

  it('uses an explicit --deployment ID as given', async () => {
    const world = {
      specVersion: 8,
      resolveLatestDeploymentId: vi.fn(),
      getDeploymentId: vi.fn(),
      runs: { get: vi.fn() },
    };

    await startRun(
      world as unknown as World,
      'workflow//./src/a//a',
      { deployment: 'dpl_pinned' },
      []
    );

    const { opts } = await startOpts();
    expect(opts).toMatchObject({ deploymentId: 'dpl_pinned' });
    expect(world.resolveLatestDeploymentId).not.toHaveBeenCalled();
  });

  it('re-runs a run on the latest deployment with --deployment latest', async () => {
    const sourceRun = {
      runId: 'wrun_source',
      deploymentId: 'dpl_source',
      workflowName: 'workflow//./src/a//a',
      specVersion: 3,
    };
    const world = {
      specVersion: 8,
      resolveLatestDeploymentId: vi.fn().mockResolvedValue('dpl_latest'),
      runs: { get: vi.fn().mockResolvedValue(sourceRun) },
    };

    await startRun(
      world as unknown as World,
      'wrun_source',
      { deployment: 'latest' },
      []
    );

    const { workflow, opts } = await startOpts();
    expect(workflow).toEqual({ workflowId: 'workflow//./src/a//a' });
    // The source run's spec version describes dpl_source, not dpl_latest,
    // so it is not reused as the fallback.
    expect(opts).toEqual({
      deploymentId: 'dpl_latest',
      specVersion: undefined,
    });
  });

  it('fails on an unknown run ID', async () => {
    const world = {
      specVersion: 8,
      runs: { get: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(
      startRun(world as unknown as World, 'wrun_missing', {}, [])
    ).rejects.toThrow('Run "wrun_missing" not found');
  });

  it("never forwards the source run's start Hook", async () => {
    // A re-run is a new run by intent; forwarding the start Hook would make
    // it a duplicate of the source and refuse it with HookConflictError.
    const { start } = await import('@workflow/core/runtime');
    const sourceRun = {
      runId: 'wrun_source',
      status: 'completed',
      deploymentId: 'dpl_source',
      workflowName: 'workflow//./src/orders//process',
      specVersion: 8,
      startHook: { token: 'order:1' },
    };
    const world = {
      specVersion: 8,
      runs: { get: vi.fn().mockResolvedValue(sourceRun) },
    } as unknown as World;

    await startRun(world, 'wrun_source', {}, ['1']);

    expect(start).toHaveBeenCalledOnce();
    const call = vi.mocked(start).mock.calls[0] as unknown[];
    const opts = call[2] as Record<string, unknown>;
    // Without --deployment, a re-run stays on the source run's deployment.
    expect(opts).toEqual({ deploymentId: 'dpl_source', specVersion: 8 });
    expect(opts).not.toHaveProperty('hook');
    expect(JSON.stringify(opts)).not.toContain('order:1');
  });
});
