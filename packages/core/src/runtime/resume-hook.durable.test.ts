import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  HOOK_RESUME_DEDUP_VERSION,
  type Hook,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeHook, resumeWebhook } from './resume-hook.js';
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
    dehydrateStepReturnValue: vi.fn(
      async (
        value: unknown,
        _runId: string,
        _key: unknown,
        ops: Promise<unknown>[] = [],
        _global?: unknown,
        _v1Compat?: boolean,
        _framedByteStreams?: boolean,
        _compression?: boolean,
        _runReadyBarrier?: Promise<unknown>,
        readbackOps: Promise<unknown>[] = ops
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
        // A producer-push upload op: the durability flush must await it
        // before the hook_received write commits.
        if (
          typeof value === 'object' &&
          value !== null &&
          'payloadOp' in value
        ) {
          ops.push((value as { payloadOp: Promise<unknown> }).payloadOp);
        }
        // A workflow readback pipe (e.g. a manual webhook's response
        // writable): it only settles once the woken workflow writes into it,
        // so the flush must background it, never await it.
        if (
          typeof value === 'object' &&
          value !== null &&
          'payloadReadbackOp' in value
        ) {
          readbackOps.push(
            (value as { payloadReadbackOp: Promise<unknown> }).payloadReadbackOp
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
    vi.clearAllMocks();
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

  it('durably writes hook_received, then publishes a payload-less wake', async () => {
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
    const [, wake, wakeOptions] = queue.mock.calls[0];
    // The wake is a plain trigger: the payload lives in the event log, so
    // nothing rides on the queue message but the runId (+ timing metadata).
    expect(wake.runId).toBe(hook.runId);
    expect(wake.hookInput).toBeUndefined();
    expect(wake.hookResume).toBeUndefined();
    expect(wake.hookResumeTiming.strategy).toBe('sequential');
    // Publish retries whose response was lost dedup on the claim key, so a
    // duplicate wake (one full replay of the run) is not enqueued.
    expect(wakeOptions.idempotencyKey).toBe(`hook-${params.resumeId}`);

    const attributes = Object.assign(
      {},
      ...telemetrySpan.setAttributes.mock.calls.map(([value]) => value)
    );
    expect(attributes['workflow.hook.resume_strategy']).toBe('sequential');
  });

  it('opens the resumeHook timing window at public entry', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const { queue } = makeWorld(hook);
    const before = Date.now();

    await resumeHook(hook.token, { foo: 'bar' });

    const after = Date.now();
    const timing = queue.mock.calls[0][1].hookResumeTiming;
    expect(timing.resumeRequestedAtMs).toBeGreaterThanOrEqual(before);
    expect(timing.queuePublishRequestedAtMs).toBeGreaterThanOrEqual(
      timing.resumeRequestedAtMs
    );
    expect(timing.queuePublishRequestedAtMs).toBeLessThanOrEqual(after);
  });

  it('publishes the wake only after the durable write has resolved', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    let finishWrite!: () => void;
    const createEvent = vi.fn(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    );
    const queue = vi.fn();
    makeWorld(hook, { createEvent, queue });

    let resolved = false;
    const resume = resumeHook(hook.token, { foo: 'bar' }).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => {
      expect(createEvent).toHaveBeenCalledTimes(1);
    });
    // Write still pending: no wake, no resolution.
    expect(queue).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    finishWrite();
    await resume;
    expect(queue).toHaveBeenCalledTimes(1);
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

  it('awaits producer uploads before writing or waking', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const upload = Promise.withResolvers<void>();
    const { createEvent, queue } = makeWorld(hook);

    const resume = resumeHook(hook.token, { payloadOp: upload.promise });
    await Promise.resolve();
    await Promise.resolve();
    expect(createEvent).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();

    upload.resolve();
    await resume;
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('does not await workflow readback pipes before writing and waking', async () => {
    // The regression this pins: a manual webhook's `responseWritable`
    // dehydrates into a server-stream reader that only settles once the woken
    // workflow writes the response. Awaiting it ahead of the wake deadlocks
    // the resume against its own wake.
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const readback = new Promise<void>(() => {});
    const { createEvent, queue } = makeWorld(hook);

    await expect(
      resumeHook(hook.token, { payloadReadbackOp: readback })
    ).resolves.toBeDefined();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
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

  it('does not publish a wake when the durable write rejects a disposed or ended hook', async () => {
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
    // Nothing was committed, so nothing may be dispatched.
    expect(queue).not.toHaveBeenCalled();
  });

  it('passes a transient write conflict (409) through as retryable, not HookNotFound', async () => {
    // Every 409 the backend emits on this write today is transient (an
    // event-slot conflict past the server's internal retry budget, or a
    // resume-claim race mid-resolution) and its transaction committed
    // nothing. Re-keying it to HookNotFoundError told the caller a retryable
    // failure was permanent — a webhook route would answer 404 and the
    // sender would drop the resume.
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const conflict = new EntityConflictError('event slot is already taken');
    const createEvent = vi.fn().mockRejectedValue(conflict);
    const { queue } = makeWorld(hook, { createEvent });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(conflict);
    expect(HookNotFoundError.is(conflict)).toBe(false);
    expect(queue).not.toHaveBeenCalled();
  });

  it('passes a resumeId-reuse rejection through unmapped', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const reuseError = Object.assign(
      new Error('resumeId reused with a different payload'),
      { status: 422, code: 'hook-resume-id-reuse' }
    );
    const createEvent = vi.fn().mockRejectedValue(reuseError);
    const { queue } = makeWorld(hook, { createEvent });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(
      reuseError
    );
    expect(queue).not.toHaveBeenCalled();
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

  it.each([
    // @vercel/queue errors carry no status field; they classify by name.
    [
      'a named queue 4xx',
      Object.assign(new Error('bad request'), { name: 'BadRequestError' }),
    ],
    [
      'a numeric-status 4xx',
      Object.assign(new Error('bad request'), { status: 400 }),
    ],
  ])('does not spend the wake retry budget on %s', async (_name, badRequest) => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const queue = vi.fn().mockRejectedValue(badRequest);
    makeWorld(hook, { queue });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(
      badRequest
    );
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('does not retry the wake against an unavailable deployment', async () => {
    // A deployment the queue cannot discover will not come back within the
    // ~125ms retry budget; the World's own classifier decides.
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const discovery = Object.assign(new Error('no consumer'), {
      name: 'ConsumerDiscoveryError',
    });
    const queue = vi.fn().mockRejectedValue(discovery);
    const { getByToken } = makeWorld(hook, { queue });
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: { hookResumeDedup: true },
      hooks: { getByToken },
      runs: { get: vi.fn() },
      events: { create: vi.fn() },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      queue,
      isDeploymentUnavailableError: (error: unknown) =>
        (error as Error)?.name === 'ConsumerDiscoveryError',
    } as unknown as World);

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(
      discovery
    );
    expect(queue).toHaveBeenCalledTimes(1);
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

  it('attaches no idempotency claim when the backend does not attest dedup', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(
      hook,
      {},
      { hookResumeDedup: false }
    );

    await resumeHook(hook.token, { foo: 'bar' });

    const [, , params] = createEvent.mock.calls[0];
    expect(params.resumeId).toBeUndefined();
    expect(params.resumePayloadDigest).toBeUndefined();
    expect(queue).toHaveBeenCalledTimes(1);
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

    // Token string: the lookup is fresh, so the response-only attestation is
    // trusted and the write carries the idempotency claim.
    await resumeHook(hook.token, { foo: 'fresh' });
    expect(first.createEvent.mock.calls[0][2].resumeId).toBeDefined();

    // Hook object: possibly cached before a server rollback; the stale
    // attestation is ignored and the write stays claim-less.
    const second = makeWorld(hook, {}, {});
    await resumeHook(hook, { foo: 'stale' });
    expect(second.createEvent.mock.calls[0][2].resumeId).toBeUndefined();
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
    // resumeWebhook's in-line lookup is fresh, so the claim rides the write.
    expect(createEvent.mock.calls[0][2].resumeId).toBeDefined();
    const [, wake] = queue.mock.calls[0];
    expect(wake.hookResume).toBeUndefined();
    expect(wake.hookResumeTiming.strategy).toBe('sequential');
  });

  it('opens the resumeWebhook timing window before its hook lookup', async () => {
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const hook = {
        ...baseHook,
        isWebhook: true,
        resumeContext: currentContext,
        resumeCapabilities: {
          hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION,
        },
      } satisfies Hook;
      const { queue } = makeWorld(
        hook,
        {
          getByToken: vi.fn(async () => {
            clock += 500;
            return hook;
          }),
        },
        {}
      );

      await resumeWebhook(hook.token, new Request('http://x'));

      const timing = queue.mock.calls[0][1].hookResumeTiming;
      expect(timing.resumeRequestedAtMs).toBe(1_000);
      expect(
        timing.queuePublishRequestedAtMs - timing.resumeRequestedAtMs
      ).toBeGreaterThanOrEqual(500);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
