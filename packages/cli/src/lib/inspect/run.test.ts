import type { World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { startRun } from './run.js';

vi.mock('@workflow/core/runtime', () => ({
  start: vi.fn().mockResolvedValue({ runId: 'wrun_new' }),
}));
vi.mock('@workflow/core/runtime/helpers', () => ({
  healthCheck: vi.fn().mockResolvedValue({ healthy: false }),
}));
vi.mock('../config/log.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn() },
}));

describe('startRun', () => {
  it("never forwards the source run's start Hook", async () => {
    // A re-run is a new run by intent; forwarding the reservation would make
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
    expect(opts).toMatchObject({ deploymentId: 'dpl_source' });
    expect(opts).not.toHaveProperty('hook');
    expect(JSON.stringify(opts)).not.toContain('order:1');
  });
});
