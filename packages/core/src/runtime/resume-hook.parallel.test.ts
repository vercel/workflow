import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  ThrottleError,
} from '@workflow/errors';
import {
  HOOK_RESUME_DEDUP_VERSION,
  HOOK_RESUME_INPUT_VERSION,
  type Hook,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
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
// is true and the parallel resume strategy activates. The sibling
// `resume-hook.fast-path.test.ts` returns a string and thus stays sequential;
// this file exercises the complementary parallel branch.
const PAYLOAD_BYTES = new Uint8Array([1, 2, 3, 4]);
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    dehydrateStepReturnValue: vi.fn(async () => PAYLOAD_BYTES),
    hydrateStepArguments: vi.fn(async (value: unknown) => value),
  };
});

describe('resumeHook (parallel fast path)', () => {
  afterEach(() => setWorld(undefined));

  const baseHook = {
    runId: 'wrun_par',
    hookId: 'hook_par',
    token: 'order:par',
    ownerId: 'owner_1',
    projectId: 'project_1',
    environment: 'production',
    createdAt: new Date(),
    // Non-legacy run: v1Compat is false, so the parallel path is eligible.
    specVersion: SPEC_VERSION_CURRENT,
  } satisfies Hook;

  // The run carries an explicit `hookResumeInputVersion` marker (its creating
  // deployment re-ensures from `hookInput`). Combined with a backend that
  // declares `hookResumeDedup`, a CBOR-transport spec version, and a raw-byte
  // payload, resumeHook takes the parallel path.
  const parallelContext = {
    deploymentId: 'deployment_par',
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
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities,
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      runs: { get: vi.fn() },
      events: { create: createEvent },
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
      queue,
    } as unknown as World);
    return { createEvent, queue };
  };

  it('dispatches the event write and queue publish concurrently with a shared resumeId + digest', async () => {
    const hook = { ...baseHook, resumeContext: parallelContext } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook);

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [runIdArg, eventArg, optsArg] = createEvent.mock.calls[0];
    expect(runIdArg).toBe(hook.runId);
    expect(eventArg).toMatchObject({
      eventType: 'hook_received',
      correlationId: hook.hookId,
    });
    // Both writers must carry the same idempotency key and content digest.
    const resumeId = optsArg.resumeId as string;
    const digest = optsArg.resumePayloadDigest as string;
    expect(resumeId).toEqual(expect.any(String));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.runId).toBe(hook.runId);
    expect(payloadArg.hookInput).toEqual({
      resumeId,
      hookId: hook.hookId,
      token: hook.token,
      payload: PAYLOAD_BYTES,
      payloadDigest: digest,
    });
  });

  it('always throws when the queue publish fails', async () => {
    const hook = { ...baseHook, resumeContext: parallelContext } satisfies Hook;
    const queueErr = new Error('queue unavailable');
    const { queue } = makeWorld(hook, {
      queue: vi.fn().mockRejectedValue(queueErr),
    });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toBe(queueErr);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('swallows a retryable event-write failure because the queue consumer re-ensures the event', async () => {
    // 429/5xx/transport on the direct write is resilient: the run WAS
    // re-triggered via the queue, whose consumer idempotently re-ensures the
    // hook_received event before replay. resumeHook must not fail the caller.
    const hook = { ...baseHook, resumeContext: parallelContext } satisfies Hook;
    const createEvent = vi
      .fn()
      .mockRejectedValue(new ThrottleError('slow down'));
    const queue = vi.fn().mockResolvedValue({ messageId: 'm_1' });
    makeWorld(hook, { createEvent, queue });

    await expect(resumeHook(hook.token, { foo: 'bar' })).resolves.toMatchObject(
      { hookId: hook.hookId }
    );
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('re-keys a terminal-run rejection from the event write to HookNotFoundError(token)', async () => {
    // The queue publish succeeds, but the run has genuinely ended: the direct
    // write rejects with a terminal "hook gone" error and resumeHook surfaces
    // the pre-fast-path contract (HookNotFoundError keyed on the token). The
    // queue consumer's re-ensure will also no-op against the terminal run.
    for (const err of [
      new HookNotFoundError(baseHook.hookId),
      new RunExpiredError('run has expired'),
    ]) {
      const hook = {
        ...baseHook,
        resumeContext: parallelContext,
      } satisfies Hook;
      const createEvent = vi.fn().mockRejectedValue(err);
      const queue = vi.fn().mockResolvedValue({ messageId: 'm_1' });
      makeWorld(hook, { createEvent, queue });

      await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toSatisfy(
        (e: unknown) =>
          HookNotFoundError.is(e) &&
          (e as HookNotFoundError).token === hook.token
      );
      setWorld(undefined);
    }
  });

  it('swallows an EntityConflict (409) from the event write on the parallel path', async () => {
    // Unlike the sequential path, a 409 here is NOT "hook gone": the parallel
    // write raced its own re-ensuring queue consumer (or a redrive) on the
    // shared resumeId. The run was re-triggered via the queue, whose consumer
    // converges on the single committed event, so resumeHook must resolve
    // rather than re-key to HookNotFoundError.
    const hook = { ...baseHook, resumeContext: parallelContext } satisfies Hook;
    const createEvent = vi
      .fn()
      .mockRejectedValue(new EntityConflictError('resumeId already claimed'));
    const queue = vi.fn().mockResolvedValue({ messageId: 'm_1' });
    makeWorld(hook, { createEvent, queue });

    await expect(resumeHook(hook.token, { foo: 'bar' })).resolves.toMatchObject(
      { hookId: hook.hookId }
    );
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('forces the sequential path when WORKFLOW_DISABLE_LAZY_HOOK_RESUME=1 despite every other precondition passing', async () => {
    // The operational kill switch must win over an otherwise fully fast-path-
    // eligible resume (marker present, dedup-capable backend, CBOR transport,
    // raw-byte payload). Follows the SDK convention of other disable flags
    // (e.g. WORKFLOW_DISABLE_COMPRESSION): enabled by default, strict '1'.
    const ORIG = process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME;
    process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME = '1';
    try {
      const hook = {
        ...baseHook,
        resumeContext: parallelContext,
      } satisfies Hook;
      const { createEvent, queue } = makeWorld(hook);

      await resumeHook(hook.token, { foo: 'bar' });

      // Sequential: no shared idempotency key on the write, no hookInput on the
      // queue message — the payload rides the event log.
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
    // the fast path enabled, matching the other WORKFLOW_DISABLE_* flags.
    const ORIG = process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME;
    process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME = 'true';
    try {
      const hook = {
        ...baseHook,
        resumeContext: parallelContext,
      } satisfies Hook;
      const { createEvent, queue } = makeWorld(hook);

      await resumeHook(hook.token, { foo: 'bar' });

      const [, , optsArg] = createEvent.mock.calls[0];
      expect(optsArg.resumeId).toEqual(expect.any(String));
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
    // A payload larger than the queue's inline ceiling would fail the oversized
    // publish on the parallel path, persisting hook_received but never
    // re-triggering the run. The size gate must instead select the sequential
    // path, whose queue message carries only the run ID (no resumeId / no
    // hookInput) — the payload rides the event log.
    const oversized = new Uint8Array(256 * 1024).fill(7);
    vi.mocked(dehydrateStepReturnValue).mockResolvedValueOnce(oversized);
    const hook = { ...baseHook, resumeContext: parallelContext } satisfies Hook;
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

  it('falls back to the sequential path when the run lacks the hookResumeInput marker', async () => {
    // The run's creating deployment did not stamp `hookResumeInputVersion`, so
    // its queue consumer will NOT re-ensure hook_received from hookInput. Even
    // with a dedup-capable backend, raw-byte payloads, and CBOR transport,
    // resumeHook writes then publishes and carries neither resumeId nor
    // hookInput — the payload rides the event log.
    expect(SPEC_VERSION_CURRENT).toBeGreaterThanOrEqual(
      SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
    );
    const { hookResumeInputVersion: _omit, ...contextWithoutMarker } =
      parallelContext;
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
    // A legacy run omits `token` from the producer's event body, but the queue
    // consumer's re-ensure always includes it — the two writers would disagree
    // on the event body. Legacy runs must stay sequential regardless of every
    // other precondition.
    const hook = {
      ...baseHook,
      specVersion: 1,
      resumeContext: parallelContext,
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
    // sequential path so the two writers can never diverge.
    const hook = { ...baseHook, resumeContext: parallelContext } satisfies Hook;
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

  it('takes the parallel path on a dynamic backend attestation (resumeCapabilities) with no static capability', async () => {
    // world-vercel no longer declares the static `hookResumeDedup`; it attests
    // dedup support FRESH per by-token lookup via the response-only
    // `resumeCapabilities`. The parallel path must engage on that signal alone,
    // with an otherwise-empty World capability set.
    const hook = {
      ...baseHook,
      resumeContext: parallelContext,
      resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION },
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    await resumeHook(hook.token, { foo: 'bar' });

    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toEqual(expect.any(String));
    expect(optsArg.resumePayloadDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(queue).toHaveBeenCalledTimes(1);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeDefined();
  });

  it('falls back to sequential when neither the static capability nor resumeCapabilities attest dedup (rollback / kill switch)', async () => {
    // A rolled-back or kill-switched server returns a hook with no
    // `resumeCapabilities`, and world-vercel declares no static capability.
    // With both attestations absent, resumeHook must fail closed — every new
    // resume degrades to the single-writer path with no stranded hooks.
    const hook = { ...baseHook, resumeContext: parallelContext } satisfies Hook;
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
    // `hookResumeDedupVersion` — must NOT reactivate the parallel path against
    // a backend that no longer dedups. Passing a Hook (not a token) skips the
    // by-token lookup, so its capability is stale by construction and ignored.
    const hook = {
      ...baseHook,
      resumeContext: parallelContext,
      resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION },
    } satisfies Hook;
    // Empty world capabilities (world-vercel: no static hookResumeDedup) and
    // getByToken deliberately NOT consulted — we pass the hook object directly.
    const { createEvent, queue } = makeWorld(hook, {}, {});

    await resumeHook(hook, { foo: 'bar' });

    // Sequential: no shared idempotency key, no hookInput on the queue message.
    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    expect(optsArg.resumePayloadDigest).toBeUndefined();
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });

  it('resumeWebhook takes the parallel path via its internal fresh attestation on a dynamic-only backend', async () => {
    // The complement to the "caller supplies a stale Hook" fail-closed test:
    // `resumeWebhook` fetches the hook by token in-line (`getHookByTokenWithKey`)
    // during this resume, then calls the private `resumeHookImpl` with the
    // freshness attestation set. That is the ONLY path allowed to trust the
    // response-only `resumeCapabilities` on a Hook object, so with no static
    // world capability the parallel path must still engage — proving the
    // attestation flows through the webhook entry point (which cannot be
    // exercised through the public three-arg `resumeHook`).
    const hook = {
      ...baseHook,
      isWebhook: true,
      resumeContext: parallelContext,
      resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION },
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    const response = await resumeWebhook(hook.token, new Request('http://x'));
    // Default webhook (no `respondWith`) resolves to a 202.
    expect(response.status).toBe(202);

    // Parallel: shared idempotency key + hookInput on the queue message.
    expect(createEvent).toHaveBeenCalledTimes(1);
    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toEqual(expect.any(String));
    expect(optsArg.resumePayloadDigest).toMatch(/^[0-9a-f]{64}$/);
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeDefined();
  });

  it('ignores a stale resumeCapabilities below the required dedup version', async () => {
    // Forward-compat: a future server that lowers its attested version (or a
    // corrupted/old field below HOOK_RESUME_DEDUP_VERSION) must not engage the
    // parallel path — the version gate is a floor, not a mere presence check.
    const hook = {
      ...baseHook,
      resumeContext: parallelContext,
      resumeCapabilities: {
        hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION - 1,
      },
    } satisfies Hook;
    const { createEvent, queue } = makeWorld(hook, {}, {});

    await resumeHook(hook.token, { foo: 'bar' });

    const [, , optsArg] = createEvent.mock.calls[0];
    expect(optsArg.resumeId).toBeUndefined();
    const [, payloadArg] = queue.mock.calls[0];
    expect(payloadArg.hookInput).toBeUndefined();
  });
});
