import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configuredWorld, resumedWith } = vi.hoisted(() => ({
  configuredWorld: { current: undefined as unknown },
  resumedWith: [] as unknown[],
}));

// The World the request's env selects: built per request, never installed as
// the runtime's global by `getWorldFromEnv()`.
vi.mock('@workflow/world-vercel', () => ({
  createWorld: () => configuredWorld.current,
}));

// Record the World `resumeHook()` would actually use: the runtime's global.
vi.mock('@workflow/core/runtime/resume-hook', () => {
  return {
    resumeHook: vi.fn(async (target: { hookId?: string } | string) => {
      const { getWorld } = await import('@workflow/core/runtime');
      resumedWith.push(await getWorld());
      return {
        hookId: typeof target === 'string' ? 'hook_by_token' : target.hookId,
        runId: 'wrun_1',
      };
    }),
  };
});

const { setWorld } = await import('@workflow/core/runtime');
const { resumeHook, resumeHookById } = await import(
  './workflow-server-actions.server'
);

const fakeWorld = (name: string) =>
  ({
    name,
    specVersion: SPEC_VERSION_CURRENT,
    hooks: {
      get: vi.fn(async (hookId: string) => ({ hookId, runId: 'wrun_1' })),
    },
  }) as unknown as World;

describe('resume server actions', () => {
  const defaultWorld = fakeWorld('default');
  const selectedWorld = fakeWorld('selected');

  beforeEach(() => {
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'vercel');
    configuredWorld.current = selectedWorld;
    resumedWith.length = 0;
    // A different World is already installed as the runtime's global.
    setWorld(defaultWorld);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setWorld(undefined);
  });

  it('resumes by hook ID through the World it looked the hook up in', async () => {
    const result = await resumeHookById({}, 'hook_1', { ok: true });

    expect(result).toMatchObject({ success: true });
    expect(selectedWorld.hooks.get).toHaveBeenCalledWith('hook_1', {
      resolveData: 'none',
    });
    expect(resumedWith).toEqual([selectedWorld]);
  });

  it('resumes by token through the World the request selects', async () => {
    const result = await resumeHook({}, 'tok', { ok: true });

    expect(result).toMatchObject({ success: true });
    expect(resumedWith).toEqual([selectedWorld]);
  });
});
