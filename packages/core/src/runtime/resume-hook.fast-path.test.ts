import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
} from '@workflow/errors';
import {
  type Hook,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeHook, resumeWebhook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));
// Stub payload (de)serialization so these control-flow tests don't depend on
// devalue/encryption/Request framing — SerializationFormat is kept real for
// the capability checks. Byte-level sealing is covered by the sibling
// `resume-hook.test.ts`, which runs serialization for real.
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    dehydrateStepReturnValue: vi.fn(async () => 'serialized'),
    hydrateStepArguments: vi.fn(async (value: unknown) => value),
  };
});

describe('resumeHook (resumeContext fast path)', () => {
  afterEach(() => setWorld(undefined));

  const baseHook = {
    runId: 'wrun_ctx',
    hookId: 'hook_ctx',
    token: 'order:ctx',
    ownerId: 'owner_1',
    projectId: 'project_1',
    environment: 'production',
    createdAt: new Date(),
  } satisfies Hook;

  const resumeContext = {
    deploymentId: 'deployment_ctx',
    workflowName: 'processOrder',
    runSpecVersion: SPEC_VERSION_CURRENT,
    workflowCoreVersion: '5.0.0',
  };

  // A syntactically valid 32-byte X25519 public key (base64). Enough for
  // `decodeRunPublicKey` to accept it and route resumeHook down the seal
  // branch; byte-level sealing is verified with real serialization in
  // resume-hook.test.ts.
  const resumeContextWithKey = {
    ...resumeContext,
    encryptionPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  };

  const makeWorld = (
    hook: Hook,
    overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}
  ) => {
    const runsGet = overrides.runsGet ?? vi.fn();
    const getEncryptionKeyForRun =
      overrides.getEncryptionKeyForRun ?? vi.fn().mockResolvedValue(undefined);
    const createEvent = overrides.createEvent ?? vi.fn();
    const queue = overrides.queue ?? vi.fn();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      runs: { get: runsGet },
      events: { create: createEvent },
      getEncryptionKeyForRun,
      queue,
    } as unknown as World);
    return { runsGet, getEncryptionKeyForRun, createEvent, queue };
  };

  it('resumes from stored resumeContext without fetching the run', async () => {
    const hook = { ...baseHook, resumeContext } satisfies Hook;
    const { runsGet, getEncryptionKeyForRun, createEvent, queue } =
      makeWorld(hook);

    await resumeHook(hook.token, { foo: 'bar' });

    // Fast path: no run read.
    expect(runsGet).not.toHaveBeenCalled();
    // Key resolved by runId + deploymentId, not a run entity.
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(hook.runId, {
      deploymentId: resumeContext.deploymentId,
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
    // Queue routing comes from the stored context.
    expect(queue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ runId: hook.runId }),
      expect.objectContaining({
        deploymentId: resumeContext.deploymentId,
        specVersion: SPEC_VERSION_CURRENT,
      })
    );
  });

  it('uses the fast path when given a Hook object carrying resumeContext', async () => {
    const hook = { ...baseHook, resumeContext } satisfies Hook;
    const { runsGet, queue } = makeWorld(hook);

    await resumeHook(hook, { foo: 'bar' });

    expect(runsGet).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('falls back to runs.get when the hook has no resumeContext', async () => {
    const hook = { ...baseHook } satisfies Hook;
    const run = {
      runId: hook.runId,
      status: 'running',
      deploymentId: 'deployment_fallback',
      workflowName: 'processOrder',
      createdAt: new Date(),
      updatedAt: new Date(),
      attributes: {},
      specVersion: SPEC_VERSION_CURRENT,
    } as unknown as WorkflowRun;
    const runsGet = vi.fn().mockResolvedValue(run);
    const { queue } = makeWorld(hook, { runsGet });

    await resumeHook(hook.token, { foo: 'bar' });

    expect(runsGet).toHaveBeenCalledWith(hook.runId);
    expect(queue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ runId: hook.runId }),
      expect.objectContaining({ deploymentId: 'deployment_fallback' })
    );
  });

  it('surfaces a terminal-run rejection from the server on the fast path (no re-trigger)', async () => {
    // The fast path does not pre-check the run's terminal status; the server
    // rejects hook_received for an ended run, and resumeHook must re-key that
    // rejection to HookNotFoundError(token). Model that: events.create rejects,
    // and the queue must not be re-triggered.
    const hook = { ...baseHook, resumeContext } satisfies Hook;
    // A genuinely missing hook maps to HookNotFoundError keyed on the hook ID
    // (the event correlationId), NOT the token — resumeHook must re-key it.
    const createEvent = vi
      .fn()
      .mockRejectedValue(new HookNotFoundError(hook.hookId));
    const { runsGet, queue } = makeWorld(hook, { createEvent });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toSatisfy(
      (err: unknown) =>
        HookNotFoundError.is(err) &&
        // Byte-for-byte contract: `.token` is the hook token, not the ID.
        (err as HookNotFoundError).token === hook.token
    );
    expect(runsGet).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('re-keys an EntityConflictError (compat / conflict-shaped rejection) from events.create to HookNotFoundError(token)', async () => {
    // Current Vercel behavior returns 404 for a terminal run (mapped to
    // HookNotFoundError, covered above). EntityConflictError is kept for
    // compatibility with older / conflict-shaped (HTTP 409) rejection
    // behavior. On the fast path it surfaces from events.create and must be
    // re-keyed to HookNotFoundError(token), matching the pre-fast-path
    // contract where resumeHook threw HookNotFoundError.
    const hook = { ...baseHook, resumeContext } satisfies Hook;
    const createEvent = vi
      .fn()
      .mockRejectedValue(new EntityConflictError('run has already ended'));
    const { runsGet, queue } = makeWorld(hook, { createEvent });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toSatisfy(
      (err: unknown) =>
        HookNotFoundError.is(err) &&
        (err as HookNotFoundError).token === hook.token
    );
    expect(runsGet).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('re-keys a RunExpiredError (world-local / world-postgres terminal run) from events.create to HookNotFoundError(token)', async () => {
    // world-local and world-postgres reject hook_received for a terminal run
    // with RunExpiredError. Same re-keying requirement as the compat case.
    const hook = { ...baseHook, resumeContext } satisfies Hook;
    const createEvent = vi
      .fn()
      .mockRejectedValue(new RunExpiredError('run has expired'));
    const { runsGet, queue } = makeWorld(hook, { createEvent });

    await expect(resumeHook(hook.token, { foo: 'bar' })).rejects.toSatisfy(
      (err: unknown) =>
        HookNotFoundError.is(err) &&
        (err as HookNotFoundError).token === hook.token
    );
    expect(runsGet).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('does not resolve the key again when one is passed in (resumeHook override)', async () => {
    const hook = { ...baseHook, resumeContext } satisfies Hook;
    const { runsGet, getEncryptionKeyForRun } = makeWorld(hook);
    const override = {} as unknown as Awaited<
      ReturnType<typeof import('../encryption.js').importKey>
    >;

    await resumeHook(hook, { foo: 'bar' }, override);

    expect(runsGet).not.toHaveBeenCalled();
    // Override supplied → the world key resolver is never consulted.
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
  });

  it('resumeWebhook default (no metadata) pays no key lookup and seals to the run', async () => {
    // The common default webhook — createWebhook() with no `respondWith` —
    // stores no metadata, so getHookByTokenWithKey resolves no key and
    // resumeHook seals to the run's public key carried in the resume context.
    // Zero run reads, zero `run-key` API round trips. (Byte-level `encp` is
    // asserted with real serialization in resume-hook.test.ts.)
    const hook = {
      ...baseHook,
      isWebhook: true,
      resumeContext: resumeContextWithKey,
    } satisfies Hook;
    const getEncryptionKeyForRun = vi
      .fn()
      .mockResolvedValue(new Uint8Array(32));
    const { runsGet, queue } = makeWorld(hook, { getEncryptionKeyForRun });

    const response = await resumeWebhook(hook.token, new Request('http://x'));

    expect(response.status).toBe(202);
    expect(runsGet).not.toHaveBeenCalled();
    // The P1 fix: the default webhook must not pay the run-key lookup.
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('resumeWebhook with metadata resolves the run key exactly once', async () => {
    // A webhook that stored metadata genuinely needs the symmetric key to
    // hydrate it. That single lookup (in getHookByTokenWithKey) is then reused
    // for the payload write, so the key is resolved exactly once end-to-end.
    const hook = {
      ...baseHook,
      isWebhook: true,
      resumeContext: resumeContextWithKey,
      metadata: { note: 'stored' } as unknown as Hook['metadata'],
    } satisfies Hook;
    const getEncryptionKeyForRun = vi
      .fn()
      .mockResolvedValue(new Uint8Array(32));
    const { runsGet, queue } = makeWorld(hook, { getEncryptionKeyForRun });

    const response = await resumeWebhook(hook.token, new Request('http://x'));

    expect(response.status).toBe(202);
    expect(runsGet).not.toHaveBeenCalled();
    expect(getEncryptionKeyForRun).toHaveBeenCalledTimes(1);
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(hook.runId, {
      deploymentId: resumeContext.deploymentId,
    });
    expect(queue).toHaveBeenCalledTimes(1);
  });
});
