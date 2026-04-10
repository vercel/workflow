import { HookNotFoundError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHookByToken } from './resume-hook.js';
import { getWorld } from './world.js';

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./world.js', () => ({
  getWorld: vi.fn(),
}));

describe('getHookByToken lazy discovery retries', () => {
  const originalLazyDiscovery = process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;

  const baseHook = {
    runId: 'wrun_test',
    hookId: 'hook_test',
    token: 'token_test',
    ownerId: 'owner_test',
    projectId: 'project_test',
    environment: 'development',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    specVersion: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalLazyDiscovery === undefined) {
      delete process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;
    } else {
      process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = originalLazyDiscovery;
    }
  });

  it('retries HookNotFoundError while lazy discovery is enabled', async () => {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = '1';

    const getByToken = vi
      .fn()
      .mockRejectedValueOnce(new HookNotFoundError('token_test'))
      .mockRejectedValueOnce(new HookNotFoundError('token_test'))
      .mockResolvedValue(baseHook);

    vi.mocked(getWorld).mockResolvedValue({
      hooks: { getByToken },
      runs: {
        get: vi.fn().mockResolvedValue({ runId: 'wrun_test' }),
      },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as any);

    const hook = await getHookByToken('token_test');
    expect(hook.token).toBe('token_test');
    expect(getByToken).toHaveBeenCalledTimes(3);
  });

  it('does not retry HookNotFoundError when lazy discovery is disabled', async () => {
    delete process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;

    const getByToken = vi
      .fn()
      .mockRejectedValue(new HookNotFoundError('token_test'));

    vi.mocked(getWorld).mockResolvedValue({
      hooks: { getByToken },
      runs: {
        get: vi.fn().mockResolvedValue({ runId: 'wrun_test' }),
      },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    } as any);

    await expect(getHookByToken('token_test')).rejects.toThrow(
      HookNotFoundError
    );
    expect(getByToken).toHaveBeenCalledTimes(1);
  });
});
