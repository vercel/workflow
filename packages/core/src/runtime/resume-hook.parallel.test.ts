/**
 * Producer-side coverage for the parallel hook wake (WORKFLOW_PARALLEL_HOOK_WAKE):
 * the gates that select it, the overlapped write and publish, the public
 * contract (resolves only once the write committed AND the wake was accepted,
 * a failed write still throws), the insurance wake for a slow write, and the
 * per-attempt wake keys a force-claim redirect needs.
 */
import { HookForceClaimedError, HookNotFoundError } from '@workflow/errors';
import {
  HOOK_RESUME_FENCE_INPUT_VERSION,
  type Hook,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_RESUME_FENCE_WINDOW_MS,
  PARALLEL_HOOK_WAKE_ENV_VAR,
} from './hook-resume-fence.js';
import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
const telemetrySpan = vi.hoisted(() => ({
  setAttributes: vi.fn(),
  addLink: vi.fn(),
}));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(telemetrySpan)),
}));

const PAYLOAD_BYTES = new Uint8Array([1, 2, 3, 4]);
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    dehydrateStepReturnValue: vi.fn(async () => PAYLOAD_BYTES),
    hydrateStepArguments: vi.fn(async (value: unknown) => value),
  };
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function spanAttributes(): Record<string, unknown> {
  return Object.assign(
    {},
    ...telemetrySpan.setAttributes.mock.calls.map(([value]) => value)
  );
}

describe('resumeHook parallel wake', () => {
  const original = process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
  let clock = 1_000;

  beforeEach(() => {
    process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = '1';
    clock = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    if (original === undefined) delete process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
    else process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = original;
    setWorld(undefined);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const fenceContext = {
    deploymentId: 'deployment_parallel',
    workflowName: 'processOrder',
    runSpecVersion: SPEC_VERSION_CURRENT,
    workflowCoreVersion: '5.1.0',
    hookResumeInputVersion: HOOK_RESUME_FENCE_INPUT_VERSION,
  };

  const baseHook = {
    runId: 'wrun_parallel',
    hookId: 'hook_parallel',
    token: 'order:parallel',
    ownerId: 'owner_1',
    projectId: 'project_1',
    environment: 'production',
    createdAt: new Date(),
    specVersion: SPEC_VERSION_CURRENT,
    resumeContext: fenceContext,
  } satisfies Hook;

  const makeWorld = (
    overrides: {
      hook?: Hook;
      createEvent?: ReturnType<typeof vi.fn>;
      queue?: ReturnType<typeof vi.fn>;
      getByToken?: ReturnType<typeof vi.fn>;
    } = {},
    capabilities: World['capabilities'] = { hookResumeDedup: true }
  ) => {
    const hook = overrides.hook ?? baseHook;
    const createEvent = overrides.createEvent ?? vi.fn().mockResolvedValue({});
    const queue =
      overrides.queue ?? vi.fn().mockResolvedValue({ messageId: 'msg_1' });
    const getByToken = overrides.getByToken ?? vi.fn().mockResolvedValue(hook);
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities,
      hooks: { getByToken },
      runs: { get: vi.fn() },
      events: { create: createEvent },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      queue,
    } as unknown as World);
    return { createEvent, queue, getByToken };
  };

  it('publishes a fenced wake while the hook_received write is still in flight, and resolves only after both', async () => {
    const write = deferred<object>();
    const { createEvent, queue } = makeWorld({
      createEvent: vi.fn(() => write.promise),
    });

    let settled = false;
    const resumed = resumeHook(baseHook.token, { foo: 'bar' }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
    expect(createEvent).toHaveBeenCalledTimes(1);
    // The wake is accepted but the write has not committed: not resolved.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    clock += 40;
    write.resolve({});
    await expect(resumed).resolves.toMatchObject({ hookId: baseHook.hookId });

    const [, params] = createEvent.mock.calls[0].slice(1);
    const [, wake, options] = queue.mock.calls[0];
    expect(wake.runId).toBe(baseHook.runId);
    expect(wake.hookInput).toBeUndefined();
    expect(wake.hookResumeFence).toEqual({
      resumeId: params.resumeId,
      hookId: baseHook.hookId,
      windowMs: HOOK_RESUME_FENCE_WINDOW_MS,
    });
    expect(wake.hookResumeTiming.strategy).toBe('parallel');
    expect(options.idempotencyKey).toBe(`hook-${params.resumeId}`);
    // A fast write needs no insurance wake.
    expect(queue).toHaveBeenCalledTimes(1);

    const attributes = spanAttributes();
    expect(attributes['workflow.hook.resume_strategy']).toBe('parallel');
    expect(attributes['workflow.hook.resume_committed']).toBe(true);
    expect(attributes['workflow.hook.wake_published']).toBe(true);
    expect(attributes['workflow.hook.resume_write_ms']).toBe(40);
    expect(attributes['workflow.hook.resume_insurance_wake']).toBeUndefined();
  });

  it('publishes a distinctly keyed, unfenced insurance wake after a slow write commits', async () => {
    const { createEvent, queue } = makeWorld({
      createEvent: vi.fn(async () => {
        clock += HOOK_RESUME_FENCE_WINDOW_MS / 2;
        return {};
      }),
    });

    await resumeHook(baseHook.token, { foo: 'bar' });

    const resumeId = createEvent.mock.calls[0][2].resumeId;
    expect(queue).toHaveBeenCalledTimes(2);
    const [, firstWake, firstOptions] = queue.mock.calls[0];
    const [, insurance, insuranceOptions] = queue.mock.calls[1];
    expect(firstWake.hookResumeFence).toBeDefined();
    expect(firstOptions.idempotencyKey).toBe(`hook-${resumeId}`);
    // Published after the write committed, so it needs no fence; its key is
    // not the spent one, so the queue cannot drop it as a duplicate.
    expect(insurance.hookResumeFence).toBeUndefined();
    expect(insurance.runId).toBe(baseHook.runId);
    expect(insuranceOptions.idempotencyKey).toBe(`hook-${resumeId}-late`);
    expect(spanAttributes()['workflow.hook.resume_insurance_wake']).toBe(true);
  });

  it('still throws when the write fails after the wake was accepted, without an insurance wake', async () => {
    const { queue } = makeWorld({
      createEvent: vi.fn().mockRejectedValue(new HookNotFoundError('hook')),
    });

    await expect(
      resumeHook(baseHook.token, { foo: 'bar' })
    ).rejects.toMatchObject({
      name: 'HookNotFoundError',
      token: baseHook.token,
    });
    // The spurious wake is harmless: its consumer fences, finds no event,
    // and replays an unchanged log.
    expect(queue).toHaveBeenCalledTimes(1);
    expect(spanAttributes()['workflow.hook.resume_committed']).toBeUndefined();
  });

  it('surfaces a transient write failure as-is even though the wake went out', async () => {
    const { queue } = makeWorld({
      createEvent: vi.fn().mockRejectedValue(new Error('socket hang up')),
    });
    await expect(resumeHook(baseHook.token, { foo: 'bar' })).rejects.toThrow(
      'socket hang up'
    );
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('throws the wake error when the write committed but the wake was rejected', async () => {
    const wakeError = Object.assign(new Error('bad request'), {
      name: 'BadRequestError',
    });
    const { createEvent } = makeWorld({
      queue: vi.fn().mockRejectedValue(wakeError),
    });
    await expect(resumeHook(baseHook.token, { foo: 'bar' })).rejects.toBe(
      wakeError
    );
    expect(createEvent).toHaveBeenCalledTimes(1);
    const attributes = spanAttributes();
    expect(attributes['workflow.hook.resume_committed']).toBe(true);
    expect(attributes['workflow.hook.wake_published']).toBeUndefined();
  });

  it('gives a redirected attempt its own wake key (the first attempt already spent its key)', async () => {
    const claimer = {
      ...baseHook,
      runId: 'wrun_claimer',
      hookId: 'hook_claimer',
      claimedFrom: { runId: baseHook.runId, hookId: baseHook.hookId },
    } satisfies Hook;
    const getByToken = vi
      .fn()
      .mockResolvedValueOnce(baseHook)
      .mockResolvedValueOnce(claimer);
    const createEvent = vi
      .fn()
      .mockRejectedValueOnce(
        new HookForceClaimedError(
          baseHook.token,
          'wrun_claimer',
          'hook_claimer'
        )
      )
      .mockResolvedValueOnce({});
    const { queue } = makeWorld({ getByToken, createEvent });

    await expect(
      resumeHook(baseHook.token, { foo: 'bar' })
    ).resolves.toMatchObject({ runId: 'wrun_claimer' });

    const resumeId = createEvent.mock.calls[0][2].resumeId;
    // Same logical resume, same resumeId on both writes...
    expect(createEvent.mock.calls[1][2].resumeId).toBe(resumeId);
    expect(queue).toHaveBeenCalledTimes(2);
    const [, victimWake, victimOptions] = queue.mock.calls[0];
    const [, claimerWake, claimerOptions] = queue.mock.calls[1];
    expect(victimWake.runId).toBe(baseHook.runId);
    expect(victimOptions.idempotencyKey).toBe(`hook-${resumeId}`);
    // ...but the claimer's wake must not collide with the victim's.
    expect(claimerWake.runId).toBe('wrun_claimer');
    expect(claimerWake.hookResumeFence).toMatchObject({
      resumeId,
      hookId: 'hook_claimer',
    });
    expect(claimerOptions.idempotencyKey).toBe(`hook-${resumeId}-1`);
  });

  describe('falls back to the serial dispatch', () => {
    const expectSequential = async (queue: ReturnType<typeof vi.fn>) => {
      const [, wake] = queue.mock.calls[0];
      expect(wake.hookResumeFence).toBeUndefined();
      expect(wake.hookResumeTiming.strategy).toBe('sequential');
      expect(spanAttributes()['workflow.hook.resume_strategy']).toBe(
        'sequential'
      );
    };

    const assertWakeAfterWrite = (
      createEvent: ReturnType<typeof vi.fn>,
      queue: ReturnType<typeof vi.fn>
    ) => {
      expect(createEvent.mock.invocationCallOrder[0]).toBeLessThan(
        queue.mock.invocationCallOrder[0]
      );
    };

    it('when the env flag is off (the default)', async () => {
      delete process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
      const { createEvent, queue } = makeWorld();
      await resumeHook(baseHook.token, { foo: 'bar' });
      await expectSequential(queue);
      assertWakeAfterWrite(createEvent, queue);
    });

    it('when the env flag is set to 0 (kill switch)', async () => {
      process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = '0';
      const { queue } = makeWorld();
      await resumeHook(baseHook.token, { foo: 'bar' });
      await expectSequential(queue);
    });

    it("when the target run's runtime predates the fence", async () => {
      const hook = {
        ...baseHook,
        resumeContext: { ...fenceContext, hookResumeInputVersion: 1 },
      } satisfies Hook;
      const write = deferred<object>();
      const { createEvent, queue } = makeWorld({
        hook,
        createEvent: vi.fn(() => write.promise),
      });
      const resumed = resumeHook(hook.token, { foo: 'bar' });
      await vi.waitFor(() => expect(createEvent).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 10));
      // No wake may go out before an unfenced consumer can see the event.
      expect(queue).not.toHaveBeenCalled();
      write.resolve({});
      await resumed;
      await expectSequential(queue);
    });

    it('when the target run carries no marker at all', async () => {
      const { hookResumeInputVersion: _omit, ...legacyContext } = fenceContext;
      const hook = { ...baseHook, resumeContext: legacyContext } satisfies Hook;
      const { queue } = makeWorld({ hook });
      await resumeHook(hook.token, { foo: 'bar' });
      await expectSequential(queue);
    });

    it('when the write is claim-less (no resumeId for the consumer to match)', async () => {
      const { createEvent, queue } = makeWorld({}, {});
      await resumeHook(baseHook.token, { foo: 'bar' });
      expect(createEvent.mock.calls[0][2].resumeId).toBeUndefined();
      await expectSequential(queue);
      assertWakeAfterWrite(createEvent, queue);
    });
  });
});
