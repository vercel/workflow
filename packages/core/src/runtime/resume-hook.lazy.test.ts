import { HookNotFoundError, RunExpiredError } from '@workflow/errors';
import {
  HOOK_RESUME_DEDUP_VERSION,
  HOOK_RESUME_INPUT_VERSION,
  type Hook,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dehydrateStepReturnValue } from '../serialization.js';
import { resumeHook, resumeWebhook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));
// Return raw bytes from dehydration so `dehydratedPayload instanceof Uint8Array`
// is true and the lazy resume strategy activates. The sibling
// `resume-hook.fast-path.test.ts` returns a string and thus stays sequential;
// this file exercises the complementary lazy branch.
const PAYLOAD_BYTES = new Uint8Array([1, 2, 3, 4]);
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    dehydrateStepReturnValue: vi.fn(async () => PAYLOAD_BYTES),
    hydrateStepArguments: vi.fn(async (value: unknown) => value),
  };
});

describe('resumeHook (lazy path)', () => {
  afterEach(() => setWorld(undefined));

  const baseHook = {
    runId: 'wrun_lazy',
    hookId: 'hook_lazy',
    token: 'order:lazy',
    ownerId: 'owner_1',
    projectId: 'project_1',
    environment: 'production',
    createdAt: new Date(),
    // Non-legacy run: v1Compat is false, so the lazy path is eligible.
    specVersion: SPEC_VERSION_CURRENT,
  } satisfies Hook;

  // The run carries an explicit `hookResumeInputVersion` marker (its creating
  // deployment materializes the event from `hookInput`). Combined with a
  // backend that declares `hookResumeDedup`, a CBOR-transport spec version, and
  // a raw-byte payload, resumeHook takes the lazy path.
  const lazyContext = {
    deploymentId: 'deployment_lazy',
    workflowName: 'processOrder',
    runSpecVersion: SPEC_VERSION_CURRENT,
    workflowCoreVersion: '5.0.0',
    hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
  };

  const makeWorld = (
    hook: Hook,
    overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
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

  it('publishes the resume on the queue and writes no hook_received event', async () => {
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    const result = await resumeHook(hook.token, { foo: 'bar' });
    // The flag is retained on the type but no longer produced by any path.
    expect(result.resilientResume).toBeUndefined();

    // The whole point of the lazy path: the producer performs no event write,
    // so the resume costs one round trip. The consumer materializes
    // `hook_received` from `hookInput` before it replays.
    expect(createEvent).not.toHaveBeenCalled();

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.runId).toBe(hook.runId);
    expect(payloadArg.hookInput).toEqual({
      // Idempotency key for the consumer's write: a redelivery of this message
      // converges on the one committed event via (runId, resumeId).
      resumeId: expect.any(String),
      hookId: hook.hookId,
      token: hook.token,
      payload: PAYLOAD_BYTES,
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      // The run's pinned deployment from the resume context, for the
      // consumer's cheap pre-write affinity check.
      deploymentId: 'deployment_lazy',
    });
  });

  it('mints a distinct resumeId per resume of the same hook', async () => {
    // Two resumes of a reusable hook must not collide on the dedup constraint,
    // or the second would be swallowed as a redelivery of the first and the
    // run would only ever see one payload.
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const { queue } = makeWorld(hook);

    await resumeHook(hook.token, { foo: 'one' });
    await resumeHook(hook.token, { foo: 'two' });

    const [, first] = queue.mock.calls[0];
    const [, second] = queue.mock.calls[1];
    expect(first.hookInput.resumeId).not.toBe(second.hookInput.resumeId);
  });

  it('stamps the resume TTR window on the queue message', async () => {
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const { queue } = makeWorld(hook);

    const before = Date.now();
    await resumeHook(hook.token, { foo: 'bar' });
    const after = Date.now();

    const [, payloadArg] = queue.mock.calls[0];
    const timing = payloadArg.hookResumeTiming;
    expect(timing.strategy).toBe('lazy');
    // T0 is entry into resumeHook and T1 the publish request, so both fall
    // inside this call and in that order.
    expect(timing.resumeRequestedAtMs).toBeGreaterThanOrEqual(before);
    expect(timing.queuePublishRequestedAtMs).toBeGreaterThanOrEqual(
      timing.resumeRequestedAtMs
    );
    expect(timing.queuePublishRequestedAtMs).toBeLessThanOrEqual(after);
    // The consumer boundaries belong to the consuming invocation.
    expect(timing.consumerStartedAtMs).toBeUndefined();
    expect(timing.setupSource).toBeUndefined();
  });

  it('throws when the queue publish fails', async () => {
    // The message carries both the trigger and the only copy of the payload,
    // so a failed publish is a failed resume with nothing persisted behind it.
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const queueErr = new Error('queue unavailable');
    const { queue } = makeWorld(hook, {
      queue: vi.fn().mockRejectedValue(queueErr),
    });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(queueErr);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('accepts a resume against an ended run instead of throwing HookNotFoundError', async () => {
    // Contract change from the write-then-publish paths: this resume runs off
    // a stored `resumeContext`, so it never reads the run, and it never
    // writes, so it cannot observe the server's rejection of `hook_received`
    // for a terminal run either. It resolves. Nothing resumes — the consumer's
    // own write is rejected the same way and the delivery is consumed. A World
    // whose events.create would reject is never consulted. The complementary
    // run-fallback case is the test below.
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const createEvent = vi
      .fn()
      .mockRejectedValue(new RunExpiredError('run has expired'));
    const { queue } = makeWorld(hook, { createEvent });

    await expect(resumeHook(hook.token, { foo: 'bar' })).resolves.toMatchObject(
      { hookId: hook.hookId }
    );
    expect(createEvent).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('still rejects an ended run when the hook carries no resumeContext', async () => {
    // The lazy path removes the producer's write, not the run-fallback
    // terminal pre-check. A World that serves no `resumeContext` on its hooks
    // (world-local) makes every resume fetch the run, so an ended run is
    // caught locally and throws before anything is published — even though
    // that World statically attests dedup and would otherwise go lazy.
    const hook = { ...baseHook } satisfies Hook;
    const run = {
      runId: hook.runId,
      status: 'completed',
      deploymentId: 'deployment_lazy',
      workflowName: 'processOrder',
      createdAt: new Date(),
      updatedAt: new Date(),
      attributes: {},
      specVersion: SPEC_VERSION_CURRENT,
    } as unknown as WorkflowRun;
    const createEvent = vi.fn();
    const queue = vi.fn();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: { hookResumeDedup: true },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      runs: { get: vi.fn().mockResolvedValue(run) },
      events: { create: createEvent },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      queue,
    } as unknown as World);

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toSatisfy(
      (e: unknown) =>
        HookNotFoundError.is(e) && (e as HookNotFoundError).token === hook.token
    );
    expect(createEvent).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('forces the sequential path when WORKFLOW_DISABLE_LAZY_HOOK_RESUME=1 despite every other precondition passing', async () => {
    // The operational kill switch must win over an otherwise fully lazy-
    // eligible resume (marker present, dedup-capable backend, CBOR transport,
    // raw-byte payload). Follows the SDK convention of other disable flags
    // (e.g. WORKFLOW_DISABLE_COMPRESSION): enabled by default, strict '1'.
    const ORIG = process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME;
    process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME = '1';
    try {
      const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
      const { createEvent, queue } = makeWorld(hook);

      await resumeHook(hook.token, { foo: 'bar' });

      // Sequential: the event is written before the publish, with no
      // idempotency key, and the queue message carries no hookInput — the
      // payload rides the event log.
      expect(createEvent).toHaveBeenCalledTimes(1);
      const [, , optsArg] = createEvent.mock.calls[0];
      expect(optsArg.resumeId).toBeUndefined();
      expect(optsArg.resumePayloadDigest).toBeUndefined();

      expect(queue).toHaveBeenCalledTimes(1);
      const [, payloadArg] = queue.mock.calls[0];
      expect(payloadArg.hookInput).toBeUndefined();
    } finally {
      if (ORIG === undefined) {
        delete process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME;
      } else {
        process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME = ORIG;
      }
    }
  });

  it('does NOT force sequential for values other than the exact string "1"', async () => {
    // Strict comparison: only '1' disables. A stray 'true'/'0'/'' must leave
    // the lazy path enabled, matching the other WORKFLOW_DISABLE_* flags.
    const ORIG = process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME;
    process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME = 'true';
    try {
      const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
      const { createEvent, queue } = makeWorld(hook);

      await resumeHook(hook.token, { foo: 'bar' });

      expect(createEvent).not.toHaveBeenCalled();
      const [, payloadArg] = queue.mock.calls[0];
      expect(payloadArg.hookInput).toBeDefined();
    } finally {
      if (ORIG === undefined) {
        delete process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME;
      } else {
        process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME = ORIG;
      }
    }
  });

  it('falls back to the sequential path when the payload exceeds the inline queue bound', async () => {
    // A payload larger than the queue's inline ceiling would fail the publish
    // on the lazy path, and with no eager write there would be nothing left of
    // the resume. The size gate must instead select the sequential path, whose
    // queue message carries only the run ID — the payload rides the event log.
    const oversized = new Uint8Array(256 * 1024).fill(7);
    vi.mocked(dehydrateStepReturnValue).mockResolvedValueOnce(oversized);
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    expect(optsArg.resumePayloadDigest).toBeUndefined();

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
    // TTR is measured on both dispatch paths — the sequential message carries
    // no hookInput but still reports its own strategy.
    expect(payloadArg.hookResumeTiming).toMatchObject({
      strategy: 'sequential',
      resumeRequestedAtMs: expect.any(Number),
      queuePublishRequestedAtMs: expect.any(Number),
    });
  });

  it('falls back to the sequential path when the run lacks the hookResumeInput marker', async () => {
    // The run's creating deployment did not stamp `hookResumeInputVersion`, so
    // its queue consumer will NOT materialize hook_received from hookInput.
    // Without an eager write the resume would be lost outright, so even with a
    // dedup-capable backend, raw-byte payloads, and CBOR transport, resumeHook
    // writes then publishes and carries neither resumeId nor hookInput.
    expect(SPEC_VERSION_CURRENT).toBeGreaterThanOrEqual(
      SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
    );
    const { hookResumeInputVersion: _omit, ...contextWithoutMarker } =
      lazyContext;
    const hook = {
      ...baseHook,
      resumeContext: contextWithoutMarker,
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    expect(optsArg.resumePayloadDigest).toBeUndefined();

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });

  it('falls back to the sequential path for a legacy (v1Compat) run', async () => {
    // A legacy run omits `token` from the eagerly written event body, but the
    // consumer's write always includes it — the same resume would produce a
    // different event depending on which side wrote it. Legacy runs must stay
    // sequential regardless of every other precondition.
    const hook = {
      ...baseHook,
      specVersion: 1,
      resumeContext: lazyContext,
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    expect(optsArg.resumePayloadDigest).toBeUndefined();

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });

  it('falls back to the sequential path when the backend does not declare hookResumeDedup', async () => {
    // The target runtime supports lazy resume (marker present, CBOR transport,
    // raw bytes) but the World backend has not opted in — e.g. Postgres, which
    // has no (runId, resumeId) dedup. resumeHook must fail closed to the
    // sequential path, or a queue redelivery would commit a second
    // hook_received.
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(
      hook,
      {},
      { hookResumeDedup: false }
    );

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    expect(optsArg.resumePayloadDigest).toBeUndefined();

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });

  it('takes the lazy path on a dynamic backend attestation (resumeCapabilities) with no static capability', async () => {
    // world-vercel no longer declares the static `hookResumeDedup`; it attests
    // dedup support FRESH per by-token lookup via the response-only
    // `resumeCapabilities`. The lazy path must engage on that signal alone,
    // with an otherwise-empty World capability set.
    const hook = {
      ...baseHook,
      resumeContext: lazyContext,
      resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION },
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeDefined();
  });

  it('falls back to sequential when neither the static capability nor resumeCapabilities attest dedup (rollback / kill switch)', async () => {
    // A rolled-back or kill-switched server returns a hook with no
    // `resumeCapabilities`, and world-vercel declares no static capability.
    // With both attestations absent, resumeHook must fail closed — every new
    // resume degrades to the eager write with no stranded hooks.
    const hook = { ...baseHook, resumeContext: lazyContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    expect(optsArg.resumePayloadDigest).toBeUndefined();

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });

  it('fails closed when a caller supplies a Hook object carrying resumeCapabilities (not freshly looked up)', async () => {
    // The response-only `resumeCapabilities` is only trustworthy when fetched
    // during THIS resume. A public caller passing a pre-fetched Hook object —
    // e.g. one cached before a server rollback or kill switch, still carrying
    // `hookResumeDedupVersion` — must NOT reactivate the lazy path against a
    // backend that no longer dedups. Passing a Hook (not a token) skips the
    // by-token lookup, so its capability is stale by construction and ignored.
    const hook = {
      ...baseHook,
      resumeContext: lazyContext,
      resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION },
    } satisfies Hook;
    // Empty world capabilities (world-vercel: no static hookResumeDedup) and
    // getByToken deliberately NOT consulted — we pass the hook object directly.
    const { createEvent, queue } = makeWorld(hook, {}, {});

    await resumeHook(hook, { foo: 'bar' });

    // Sequential: eager write with no idempotency key, no hookInput on the
    // queue message.
    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    expect(optsArg.resumePayloadDigest).toBeUndefined();
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });

  it('resumeWebhook takes the lazy path via its internal fresh attestation on a dynamic-only backend', async () => {
    // The complement to the "caller supplies a stale Hook" fail-closed test:
    // `resumeWebhook` fetches the hook by token in-line (`getHookByTokenWithKey`)
    // during this resume, then calls the private `resumeHookImpl` with the
    // freshness attestation set. That is the ONLY path allowed to trust the
    // response-only `resumeCapabilities` on a Hook object, so with no static
    // world capability the lazy path must still engage — proving the
    // attestation flows through the webhook entry point (which cannot be
    // exercised through the public three-arg `resumeHook`).
    const hook = {
      ...baseHook,
      isWebhook: true,
      resumeContext: lazyContext,
      resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION },
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    const response = await resumeWebhook(hook.token, new Request('http://x'));
    // Default webhook (no `respondWith`) resolves to a 202.
    expect(response.status).toBe(202);

    // Lazy: no event write, hookInput on the queue message.
    expect(createEvent).not.toHaveBeenCalled();
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeDefined();
  });

  it('opens the resumeWebhook TTR window before its own hook lookup', async () => {
    // `resumeWebhook` does real producer-side work before it reaches the
    // shared implementation: the by-token lookup and the run-key resolution
    // it can trigger. Stamping T0 inside the implementation would silently
    // exclude that, so webhook resumes would report a systematically shorter
    // total than `resumeHook` ones into the same distribution. The clock is
    // pinned and advanced only by the lookup, so the assertion is exact.
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const hook = {
        ...baseHook,
        isWebhook: true,
        resumeContext: lazyContext,
      } satisfies Hook;
      const { queue } = makeWorld(hook, {
        // The lookup takes 500ms of wall clock.
        getByToken: vi.fn(async () => {
          clock += 500;
          return hook;
        }),
      });

      await resumeWebhook(hook.token, new Request('http://x'));

      const [, payloadArg] = queue.mock.calls[0];
      const timing = payloadArg.hookResumeTiming;
      expect(timing.resumeRequestedAtMs).toBe(1_000);
      expect(
        timing.queuePublishRequestedAtMs - timing.resumeRequestedAtMs
      ).toBeGreaterThanOrEqual(500);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('ignores a stale resumeCapabilities below the required dedup version', async () => {
    // Forward-compat: a future server that lowers its attested version (or a
    // corrupted/old field below HOOK_RESUME_DEDUP_VERSION) must not engage the
    // lazy path — the version gate is a floor, not a mere presence check.
    const hook = {
      ...baseHook,
      resumeContext: lazyContext,
      resumeCapabilities: {
        hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION - 1,
      },
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });
});
