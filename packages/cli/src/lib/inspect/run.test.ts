import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@workflow/core/runtime', () => ({
  start: vi.fn().mockResolvedValue({ runId: 'wrun_new' }),
}));
vi.mock('@workflow/core/runtime/helpers', () => ({
  healthCheck: vi.fn().mockResolvedValue({ healthy: false }),
}));
vi.mock('../config/log.js', () => ({
  logger: { log: vi.fn(), warn: vi.fn() },
}));

import { start } from '@workflow/core/runtime';
import { startRun } from './run.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('startRun', () => {
  it("never forwards the source run's idempotency key", async () => {
    // A re-run is a new run by intent; forwarding the key would hand back the
    // source run instead of creating one.
    const sourceRun = {
      runId: 'wrun_source',
      status: 'completed',
      deploymentId: 'dpl_source',
      workflowName: 'workflow//./src/orders//process',
      specVersion: 8,
      idempotencyKey: 'order-1',
    };
    const world = {
      specVersion: 8,
      runs: { get: vi.fn().mockResolvedValue(sourceRun) },
    } as unknown as World;

    await startRun(world, 'wrun_source', {}, ['1']);

    expect(start).toHaveBeenCalledOnce();
    const [workflow, args, opts] = vi.mocked(start).mock
      .calls[0] as unknown as [
      unknown,
      unknown[],
      Record<string, unknown> | undefined,
    ];
    expect(workflow).toEqual({ workflowId: sourceRun.workflowName });
    expect(args).toEqual([1]);
    expect(opts).toMatchObject({ deploymentId: 'dpl_source' });
    for (const key of Object.keys(opts ?? {})) {
      expect(key).not.toMatch(/idempotency/i);
    }
  });
});
