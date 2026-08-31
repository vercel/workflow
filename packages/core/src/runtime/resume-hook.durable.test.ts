import {
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
import { CONSUMER_SETTLED_OP } from '../symbols.js';
import { resumeHook, resumeWebhook } from './resume-hook.js';
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
        if (typeof value === 'object' && value !== null) {
          if ('payloadOpRejection' in value) {
            ops.push(
              Promise.reject(
                (value as { payloadOpRejection: unknown }).payloadOpRejection
              )
            );
          }
          // A producer-push upload op the flush must await before the write.
          if ('flushOp' in value) {
            ops.push((value as { flushOp: Promise<unknown> }).flushOp);
          }
          // A consumer-settled reader op (see CONSUMER_SETTLED_OP): the real
          // WritableStream reducer tags these because they only resolve once
          // the woken workflow writes into the stream. The flush must
          // background it, never await it.
          if ('consumerSettledOp' in value) {
            const op = (value as { consumerSettledOp: Promise<unknown> })
              .consumerSettledOp;
            (op as any)[CONSUMER_SETTLED_OP] = true;
            ops.push(op);
          }
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
    const [, wake] = queue.mock.calls[0];
    // The wake is a plain trigger: the payload lives in the event log, so
    // nothing rides on the queue message but the runId (+ timing metadata).
    expect(wake.runId).toBe(hook.runId);
    expect(wake.hookInput).toBeUndefined();
    expect(wake.hookResume).toBeUndefined();
    expect(wake.hookResumeTiming.strategy).toBe('sequential');
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

  it('awaits producer-push payload ops before the durable write', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    let finishUpload!: () => void;
    const flushOp = new Promise<void>((resolve) => (finishUpload = resolve));
    const { createEvent, queue } = makeWorld(hook);

    const resume = resumeHook(hook.token, { flushOp });
    // Upload in flight: the event must not commit with the payload still
    // pointing at bytes that are not on the server yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createEvent).not.toHaveBeenCalled();

    finishUpload();
    await resume;
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('backgrounds consumer-settled ops instead of deadlocking on them', async () => {
    // The regression this pins: a manual webhook's `responseWritable`
    // dehydrates into a server-stream READER op that only settles once the
    // woken workflow writes the response. Awaiting it before the write/wake
    // deadlocks the resume against its own wake.
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const neverSettles = new Promise(() => {});
    const { createEvent, queue } = makeWorld(hook);

    await expect(
      resumeHook(hook.token, { consumerSettledOp: neverSettles })
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

  it('does not spend the wake retry budget on a definitive 4xx', async () => {
    const hook = { ...baseHook, resumeContext: currentContext } satisfies Hook;
    const badRequest = Object.assign(new Error('bad request'), {
      status: 400,
    });
    const queue = vi.fn().mockRejectedValue(badRequest);
    makeWorld(hook, { queue });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(
      badRequest
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
});
