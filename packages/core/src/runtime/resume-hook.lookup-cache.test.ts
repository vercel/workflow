import { HookNotFoundError } from '@workflow/errors';
import { type Hook, SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn({ setAttributes: vi.fn(), addLink: vi.fn() })),
}));
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    dehydrateStepReturnValue: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
});

const context = {
  deploymentId: 'dpl_1',
  workflowName: 'session',
  runSpecVersion: SPEC_VERSION_CURRENT,
  workflowCoreVersion: '5.0.0',
};

const hookFor = (runId: string, hookId: string): Hook => ({
  runId,
  hookId,
  token: 'session:inbox',
  ownerId: 'owner_1',
  projectId: 'project_1',
  environment: 'production',
  createdAt: new Date(),
  specVersion: SPEC_VERSION_CURRENT,
  resumeContext: context,
});

function makeWorld(getByToken: ReturnType<typeof vi.fn>) {
  const createEvent = vi.fn().mockResolvedValue({});
  const queue = vi.fn().mockResolvedValue({ messageId: null });
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { hookResumeDedup: true },
    hooks: { getByToken },
    runs: { get: vi.fn() },
    events: { create: createEvent },
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    queue,
  } as unknown as World);
  return { createEvent, queue };
}

describe('resumeHook by-token lookup cache', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('looks a token up once across repeated resumes of the same hook', async () => {
    const getByToken = vi.fn().mockResolvedValue(hookFor('wrun_1', 'hook_1'));
    const { createEvent, queue } = makeWorld(getByToken);

    for (let i = 0; i < 3; i++) {
      await expect(
        resumeHook('session:inbox', { turn: i })
      ).resolves.toMatchObject({ runId: 'wrun_1', hookId: 'hook_1' });
    }

    expect(getByToken).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledTimes(3);
    expect(queue).toHaveBeenCalledTimes(3);
    for (const call of createEvent.mock.calls) {
      expect(call[0]).toBe('wrun_1');
      expect(call[1]).toMatchObject({ correlationId: 'hook_1' });
    }
  });

  it('retries once with a fresh lookup when the cached hook is gone', async () => {
    // The session's inbox moved to a successor run (a deployment handoff):
    // the old hook refuses the write, the token now names the new owner.
    const getByToken = vi
      .fn()
      .mockResolvedValueOnce(hookFor('wrun_old', 'hook_old'))
      .mockResolvedValue(hookFor('wrun_new', 'hook_new'));
    const { createEvent, queue } = makeWorld(getByToken);

    await resumeHook('session:inbox', { turn: 1 });
    createEvent.mockImplementation(async (runId: string) => {
      if (runId === 'wrun_old') throw new HookNotFoundError('hook_old');
      return {};
    });

    await expect(
      resumeHook('session:inbox', { turn: 2 })
    ).resolves.toMatchObject({ runId: 'wrun_new', hookId: 'hook_new' });

    expect(getByToken).toHaveBeenCalledTimes(2);
    // turn 1 (old), turn 2 refused by old, turn 2 committed to new.
    expect(createEvent.mock.calls.map((call) => call[0])).toEqual([
      'wrun_old',
      'wrun_old',
      'wrun_new',
    ]);
    // Both writes of turn 2 are the same logical resume.
    const resumeIds = createEvent.mock.calls
      .slice(1)
      .map((call) => call[2]?.resumeId);
    expect(resumeIds[0]).toBeDefined();
    expect(resumeIds[0]).toBe(resumeIds[1]);
    // Only the committed write is followed by a wake.
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[1][1]).toMatchObject({ runId: 'wrun_new' });

    // The fresh lookup re-seeded the cache.
    await resumeHook('session:inbox', { turn: 3 });
    expect(getByToken).toHaveBeenCalledTimes(2);
  });

  it('surfaces HookNotFoundError when the fresh lookup confirms the hook is gone', async () => {
    const getByToken = vi
      .fn()
      .mockResolvedValueOnce(hookFor('wrun_1', 'hook_1'))
      .mockRejectedValue(new HookNotFoundError('session:inbox'));
    const { createEvent } = makeWorld(getByToken);

    await resumeHook('session:inbox', { turn: 1 });
    createEvent.mockRejectedValue(new HookNotFoundError('hook_1'));

    await expect(resumeHook('session:inbox', { turn: 2 })).rejects.toSatisfy(
      HookNotFoundError.is
    );
    expect(getByToken).toHaveBeenCalledTimes(2);
  });

  it('evicts the entry after any failed write, so the next resume looks up fresh', async () => {
    const getByToken = vi.fn().mockResolvedValue(hookFor('wrun_1', 'hook_1'));
    const { createEvent } = makeWorld(getByToken);

    await resumeHook('session:inbox', { turn: 1 });
    createEvent.mockRejectedValueOnce(new Error('transient'));
    await expect(resumeHook('session:inbox', { turn: 2 })).rejects.toThrow(
      'transient'
    );
    // A transient failure is not retried by the cache logic...
    expect(getByToken).toHaveBeenCalledTimes(1);

    // ...but the next resume does not trust the entry any more.
    await resumeHook('session:inbox', { turn: 3 });
    expect(getByToken).toHaveBeenCalledTimes(2);
  });

  it('is disabled by WORKFLOW_HOOK_LOOKUP_CACHE_TTL_MS=0', async () => {
    vi.stubEnv('WORKFLOW_HOOK_LOOKUP_CACHE_TTL_MS', '0');
    const getByToken = vi.fn().mockResolvedValue(hookFor('wrun_1', 'hook_1'));
    makeWorld(getByToken);

    await resumeHook('session:inbox', { turn: 1 });
    await resumeHook('session:inbox', { turn: 2 });
    expect(getByToken).toHaveBeenCalledTimes(2);
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const getByToken = vi.fn().mockResolvedValue(hookFor('wrun_1', 'hook_1'));
      makeWorld(getByToken);

      await resumeHook('session:inbox', { turn: 1 });
      vi.setSystemTime(Date.now() + 59_000);
      await resumeHook('session:inbox', { turn: 2 });
      expect(getByToken).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2_000);
      await resumeHook('session:inbox', { turn: 3 });
      expect(getByToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never caches a hook without a stored resume context', async () => {
    const legacy = { ...hookFor('wrun_1', 'hook_1'), resumeContext: undefined };
    const getByToken = vi.fn().mockResolvedValue(legacy);
    const createEvent = vi.fn().mockResolvedValue({});
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: {},
      hooks: { getByToken },
      runs: {
        get: vi.fn().mockResolvedValue({
          runId: 'wrun_1',
          status: 'running',
          deploymentId: 'dpl_1',
          workflowName: 'session',
          specVersion: SPEC_VERSION_CURRENT,
          executionContext: { workflowCoreVersion: '5.0.0' },
        }),
      },
      events: { create: createEvent },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      queue: vi.fn().mockResolvedValue({ messageId: null }),
    } as unknown as World);

    await resumeHook('session:inbox', { turn: 1 });
    await resumeHook('session:inbox', { turn: 2 });
    expect(getByToken).toHaveBeenCalledTimes(2);
  });
});
