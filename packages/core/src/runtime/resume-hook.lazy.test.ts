import {
  HookNotFoundError,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  HOOK_RESUME_DEDUP_VERSION,
  HOOK_RESUME_INPUT_VERSION,
  type Hook,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeHook, resumeHookDurable, resumeWebhook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

const PAYLOAD_BYTES = new Uint8Array([1, 2, 3, 4]);
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    dehydrateStepReturnValue: vi.fn(
      async (
        value: unknown,
        _runId: string,
        _key: unknown,
        ops: Promise<unknown>[] = []
      ) => {
        if (
          typeof value === 'object' &&
          value !== null &&
          'payloadOpRejection' in value
        ) {
          ops.push(
            Promise.reject(
              (value as { payloadOpRejection: unknown }).payloadOpRejection
            )
          );
        }
        return PAYLOAD_BYTES;
      }
    ),
    hydrateStepArguments: vi.fn(async (value: unknown) => value),
  };
});

describe('resumeHook durable resume', () => {
  afterEach(() => {
    setWorld(undefined);
    delete process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME;
  });

  const baseHook = {
    runId: 'wrun_resume',
    hookId: 'hook_resume',
    token: 'order:resume',
    ownerId: 'owner_1',
    projectId: 'project_1',
    environment: 'production',
    createdAt: new Date(),
    specVersion: SPEC_VERSION_CURRENT,
  } satisfies Hook;

  const currentContext = {
    deploymentId: 'deployment_resume',
    workflowName: 'processOrder',
    runSpecVersion: SPEC_VERSION_CURRENT,
    workflowCoreVersion: '5.0.0',
    hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
  };

  const makeWorld = (
    hook: Hook,
    overrides: {
      createEvent?: ReturnType<typeof vi.fn>;
      queue?: ReturnType<typeof vi.fn>;
      getByToken?: ReturnType<typeof vi.fn>;
    } = {},
    capabilities: World['capabilities'] = { hookResumeDedup: true }
  ) => {
    const createEvent = overrides.createEvent ?? vi.fn();
    const queue = overrides.queue ?? vi.fn();
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

  it('durably writes hook_received and publishes a correlated wake', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    await expect(resumeHook(hook.token, { foo: 'bar' })).resolves.toMatchObject(
      {
        hookId: hook.hookId,
      }
    );

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, event, params] = createEvent.mock.calls[0];
    expect(event).toMatchObject({
      eventType: 'hook_received',
      correlationId: hook.hookId,
      eventData: { token: hook.token, payload: PAYLOAD_BYTES },
    });
    expect(params).toMatchObject({
      resumeId: expect.any(String),
      resumePayloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    expect(queue).toHaveBeenCalledTimes(1);
    const [, wake] = queue.mock.calls[0];
    expect(wake.hookInput).toBeUndefined();
    expect(wake.hookResume).toEqual({
      resumeId: params.resumeId,
      hookId: hook.hookId,
      strategy: 'producer_committed',
      version: 1,
    });
    expect(wake.hookResumeTiming.strategy).toBe('parallel');
  });

  it('starts the durable write and wake in parallel, but awaits both', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    let finishWrite!: () => void;
    let finishWake!: () => void;
    const createEvent = vi.fn(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    );
    const queue = vi.fn(
      () => new Promise<void>((resolve) => (finishWake = resolve))
    );
    makeWorld(hook, { createEvent, queue });

    let resolved = false;
    const resume = resumeHook(hook.token, { foo: 'bar' }).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => {
      expect(createEvent).toHaveBeenCalledTimes(1);
      expect(queue).toHaveBeenCalledTimes(1);
    });
    expect(resolved).toBe(false);

    finishWake();
    await Promise.resolve();
    expect(resolved).toBe(false);
    finishWrite();
    await resume;
    expect(resolved).toBe(true);
  });

  it('mints a distinct claim for each resume of a reusable hook', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const { createEvent } = makeWorld(hook);

    await resumeHook(hook.token, { foo: 'one' });
    await resumeHook(hook.token, { foo: 'two' });

    expect(createEvent.mock.calls[0][2].resumeId).not.toBe(
      createEvent.mock.calls[1][2].resumeId
    );
  });

  it('preserves the webhook bundle tolerance for undefined payload-op rejections', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    await expect(
      resumeHook(hook.token, { payloadOpRejection: undefined })
    ).resolves.toBeDefined();

    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('surfaces non-undefined payload-op rejections before writing or waking', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const payloadError = new Error('payload upload failed');
    const { createEvent, queue } = makeWorld(hook);

    await expect(
      resumeHook(hook.token, { payloadOpRejection: payloadError })
    ).rejects.toBe(payloadError);

    expect(createEvent).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('does not report success when the durable write rejects a disposed or ended hook', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const createEvent = vi
      .fn()
      .mockRejectedValue(new RunExpiredError('run has expired'));
    const { queue } = makeWorld(hook, { createEvent });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toSatisfy(
      (error: unknown) =>
        HookNotFoundError.is(error) &&
        (error as HookNotFoundError).token === hook.token
    );
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('retries the wake and resolves only after it is accepted', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const queue = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValueOnce(undefined);
    const { createEvent } = makeWorld(hook, { queue });

    await expect(resumeHook(hook.token, { foo: 'bar' })).resolves.toBeDefined();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it('surfaces a wake failure after the event has been made durable', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const queueError = new Error('queue unavailable');
    const queue = vi.fn().mockRejectedValue(queueError);
    const { createEvent } = makeWorld(hook, { queue });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(
      queueError
    );
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it('does not report HookNotFound when only the wake failed', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const queue = vi.fn().mockRejectedValue(new HookNotFoundError('queue'));
    const { createEvent } = makeWorld(hook, { queue });

    const error = await resumeHook(hook.token, { foo: 'bar' }).catch(
      (caught) => caught
    );

    expect(error).toBeInstanceOf(WorkflowRuntimeError);
    expect(HookNotFoundError.is(error)).toBe(false);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['an old consumer', HOOK_RESUME_INPUT_VERSION - 1, true],
    ['a backend without atomic claims', HOOK_RESUME_INPUT_VERSION, false],
  ])('uses write-then-publish for %s', async (_name, inputVersion, dedup) => {
    const order: string[] = [];
    const hook = {
      ...baseHook,
      resumeContext: {
        ...currentContext,
        hookResumeInputVersion: inputVersion,
      },
    } satisfies Hook;
    const createEvent = vi.fn(async () => {
      order.push('write');
    });
    const queue = vi.fn(async () => {
      order.push('wake');
    });
    makeWorld(hook, { createEvent, queue }, { hookResumeDedup: dedup });

    await resumeHook(hook.token, { foo: 'bar' });

    expect(order).toEqual(['write', 'wake']);
    const [, wake] = queue.mock.calls[0];
    expect(wake.hookResume).toBeUndefined();
    expect(wake.hookResumeTiming.strategy).toBe('sequential');
  });

  it('uses write-then-publish when the kill switch is enabled', async () => {
    process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME = '1';
    const order: string[] = [];
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const createEvent = vi.fn(async () => order.push('write'));
    const queue = vi.fn(async () => order.push('wake'));
    makeWorld(hook, { createEvent, queue });

    await resumeHook(hook.token, { foo: 'bar' });

    expect(order).toEqual(['write', 'wake']);
  });

  it('only trusts dynamic backend capability from the current token lookup', async () => {
    const hook = {
      ...baseHook,
      resumeContext: currentContext,
      resumeCapabilities: {
        hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION,
      },
    } satisfies Hook;
    const first = makeWorld(hook, {}, {});

    await resumeHook(hook.token, { foo: 'fresh' });
    expect(first.queue.mock.calls[0][1].hookResume).toBeDefined();

    const second = makeWorld(hook, {}, {});
    await resumeHook(hook, { foo: 'stale' });
    expect(second.queue.mock.calls[0][1].hookResume).toBeUndefined();
  });

  it('keeps resumeHookDurable as a compatibility alias', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    await resumeHookDurable(hook.token, { aborted: true });

    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('uses the same durable path for webhooks', async () => {
    const hook = {
      ...baseHook,
      isWebhook: true,
      resumeContext: currentContext,
      resumeCapabilities: {
        hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION,
      },
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    const response = await resumeWebhook(hook.token, new Request('http://x'));

    expect(response.status).toBe(202);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][1].hookResume).toBeDefined();
  });
});
