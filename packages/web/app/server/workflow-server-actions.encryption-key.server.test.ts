import type { World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const world = {
  runs: { get: vi.fn() },
  getEncryptionKeyForRun: vi.fn(),
};

vi.mock('@workflow/world-vercel', () => ({
  createWorld: vi.fn(() => world as unknown as World),
}));

import { getEncryptionKeyForRun } from './workflow-server-actions.server';

describe('getEncryptionKeyForRun', () => {
  const original = process.env.WORKFLOW_TARGET_WORLD;

  beforeEach(() => {
    process.env.WORKFLOW_TARGET_WORLD = 'vercel';
    world.runs.get.mockResolvedValue({
      runId: 'wrun_1',
      deploymentId: 'dpl_1',
      input: undefined,
      output: undefined,
    });
    world.getEncryptionKeyForRun.mockResolvedValue(new Uint8Array(32));
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (original === undefined) delete process.env.WORKFLOW_TARGET_WORLD;
    else process.env.WORKFLOW_TARGET_WORLD = original;
  });

  it('reads the run metadata only to resolve its key', async () => {
    // The key lookup needs only the run's deploymentId; the default
    // `resolveData` ('all') would make the World resolve the run's whole
    // input and output for every decrypt in the UI (#4645).
    const result = await getEncryptionKeyForRun({}, 'wrun_1');

    expect(result).toEqual({ success: true, data: new Uint8Array(32) });
    expect(world.runs.get).toHaveBeenCalledWith('wrun_1', {
      resolveData: 'none',
    });
    expect(world.getEncryptionKeyForRun).toHaveBeenCalledWith('wrun_1', {
      deploymentId: 'dpl_1',
    });
  });
});
