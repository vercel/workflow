import {
  type Hook,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateStepArguments } from '../serialization.js';
import { getHookByToken, resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));
// Stub (de)serialization so these tests assert *when* hydration happens rather
// than devalue/encryption byte behavior, which the sibling `resume-hook.test.ts`
// covers with real serialization.
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    dehydrateStepReturnValue: vi.fn(async () => 'serialized'),
    hydrateStepArguments: vi.fn(async (value: unknown) => value),
  };
});

const hydrateSpy = vi.mocked(hydrateStepArguments);

describe('getHookByToken (lazy metadata)', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  const baseHook = {
    runId: 'wrun_lazy',
    hookId: 'hook_lazy',
    token: 'order:lazy',
    ownerId: 'owner_1',
    projectId: 'project_1',
    environment: 'production',
    createdAt: new Date(),
    specVersion: SPEC_VERSION_CURRENT,
  } satisfies Hook;

  const resumeContext = {
    deploymentId: 'deployment_lazy',
    workflowName: 'processOrder',
    runSpecVersion: SPEC_VERSION_CURRENT,
    workflowCoreVersion: '5.0.0',
  };

  // A syntactically valid 32-byte X25519 public key (base64), enough for
  // `decodeRunPublicKey` to accept it. With one in the resume context, a
  // resume seals its payload and resolves no key of its own — so any
  // `getEncryptionKeyForRun` call can only have come from metadata hydration.
  const resumeContextWithKey = {
    ...resumeContext,
    encryptionPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  };

  const makeWorld = (
    hook: Hook,
    overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}
  ) => {
    const getByToken = overrides.getByToken ?? vi.fn().mockResolvedValue(hook);
    const runsGet = overrides.runsGet ?? vi.fn();
    const getEncryptionKeyForRun =
      overrides.getEncryptionKeyForRun ??
      vi.fn().mockResolvedValue(new Uint8Array(32).fill(0x4d));
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      hooks: { getByToken },
      runs: { get: runsGet },
      events: { create: overrides.createEvent ?? vi.fn() },
      getEncryptionKeyForRun,
      queue: overrides.queue ?? vi.fn(),
    } as unknown as World);
    return { getByToken, runsGet, getEncryptionKeyForRun };
  };

  it('costs a single read even when the hook carries metadata', async () => {
    // The whole point: looking a hook up by token must not pay the run fetch
    // and `run-key` API round trip that hydrating metadata needs. Callers that
    // only want `runId`/`token` — hook resumption above all — never touch it.
    const hook = {
      ...baseHook,
      resumeContext,
      metadata: { customData: 'stored' } as unknown as Hook['metadata'],
    } satisfies Hook;
    const { getByToken, runsGet, getEncryptionKeyForRun } = makeWorld(hook);

    const found = await getHookByToken(hook.token);

    expect(found.runId).toBe(hook.runId);
    expect(getByToken).toHaveBeenCalledTimes(1);
    expect(runsGet).not.toHaveBeenCalled();
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(hydrateSpy).not.toHaveBeenCalled();
  });

  it('hydrates metadata on first access and memoizes it', async () => {
    const metadata = { customData: 'stored' };
    const hook = {
      ...baseHook,
      resumeContext,
      metadata: metadata as unknown as Hook['metadata'],
    } satisfies Hook;
    const { runsGet, getEncryptionKeyForRun } = makeWorld(hook);

    const found = await getHookByToken(hook.token);

    expect(await found.metadata).toEqual(metadata);
    // Metadata is fixed at hook-creation time, so repeat reads are free.
    expect(await found.metadata).toEqual(metadata);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    expect(getEncryptionKeyForRun).toHaveBeenCalledTimes(1);
    // Hydration resolves the key from the stored resume context — still no
    // run read, just as the resume path does.
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(hook.runId, {
      deploymentId: resumeContext.deploymentId,
    });
    expect(runsGet).not.toHaveBeenCalled();
    // Hydrating metadata is a decrypting READ, so it gets the derived
    // read-side payload keys rather than no key at all.
    expect(hydrateSpy.mock.calls[0]?.[2]).toBeDefined();
  });

  it('resolves undefined with no I/O when the hook stored no metadata', async () => {
    // The common default webhook — createWebhook() with no `respondWith`.
    // Awaiting is safe and free, so callers never need to branch first.
    const hook = { ...baseHook, resumeContext } satisfies Hook;
    const { runsGet, getEncryptionKeyForRun } = makeWorld(hook);

    const found = await getHookByToken(hook.token);

    expect(await found.metadata).toBeUndefined();
    expect(runsGet).not.toHaveBeenCalled();
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(hydrateSpy).not.toHaveBeenCalled();
  });

  it('falls back to a run read when the hook has no resumeContext', async () => {
    const hook = {
      ...baseHook,
      metadata: { customData: 'stored' } as unknown as Hook['metadata'],
    } satisfies Hook;
    const run = {
      runId: hook.runId,
      status: 'running',
      deploymentId: 'deployment_fallback',
      workflowName: 'processOrder',
      specVersion: SPEC_VERSION_CURRENT,
      createdAt: new Date(),
      updatedAt: new Date(),
      attributes: {},
    } as unknown as WorkflowRun;
    const runsGet = vi.fn().mockResolvedValue(run);
    const { getEncryptionKeyForRun } = makeWorld(hook, { runsGet });

    const found = await getHookByToken(hook.token);
    expect(runsGet).not.toHaveBeenCalled();

    await found.metadata;

    expect(runsGet).toHaveBeenCalledWith(hook.runId);
    // The fallback reuses the run it just fetched rather than re-resolving by
    // runId + deploymentId.
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(run);
  });

  it('surfaces a hydration failure on access, not on lookup', async () => {
    // A lookup that only reads `runId` must not fail because the run key is
    // unreachable; the error belongs to whoever awaits `metadata`.
    const hook = {
      ...baseHook,
      resumeContext,
      metadata: { customData: 'stored' } as unknown as Hook['metadata'],
    } satisfies Hook;
    makeWorld(hook, {
      getEncryptionKeyForRun: vi
        .fn()
        .mockRejectedValue(new Error('run-key unavailable')),
    });

    const found = await getHookByToken(hook.token);

    expect(found.runId).toBe(hook.runId);
    await expect(found.metadata).rejects.toThrow('run-key unavailable');
  });

  it('propagates a failed lookup', async () => {
    makeWorld(baseHook, {
      getByToken: vi.fn().mockRejectedValue(new Error('hook not found')),
    });

    await expect(getHookByToken('nope')).rejects.toThrow('hook not found');
  });

  it('leaves the World-supplied record untouched', async () => {
    // The wrap is a shallow copy: a World that caches or reuses hook records
    // must not end up with a Promise where its serialized bytes were.
    const metadata = { customData: 'stored' } as unknown as Hook['metadata'];
    const hook = { ...baseHook, resumeContext, metadata } satisfies Hook;
    makeWorld(hook);

    const found = await getHookByToken(hook.token);
    await found.metadata;

    expect(hook.metadata).toBe(metadata);
  });

  it('does not hydrate when the hook is spread or serialized', async () => {
    // The accessor is non-enumerable, like `Run.returnValue`. An incidental
    // spread or `JSON.stringify` must not kick off hydration nobody awaits —
    // an unconsumed rejected Promise takes the process down.
    const hook = {
      ...baseHook,
      resumeContext,
      metadata: { customData: 'stored' } as unknown as Hook['metadata'],
    } satisfies Hook;
    const { getEncryptionKeyForRun } = makeWorld(hook);

    const found = await getHookByToken(hook.token);
    const spread = { ...found };
    JSON.stringify(found);

    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(spread).not.toHaveProperty('metadata');
    // Everything else still comes along.
    expect(spread.runId).toBe(hook.runId);
    expect(spread.token).toBe(hook.token);
  });

  it('gives a resumed hook the same lazy metadata accessor', async () => {
    // `resumeHook` used to hand back the raw record, whose `metadata` was still
    // the serialized bytes. It now carries the same lazy accessor — and because
    // it is lazy, resuming still pays nothing for metadata it never reads.
    const metadata = { customData: 'stored' };
    const hook = {
      ...baseHook,
      resumeContext: resumeContextWithKey,
      metadata: metadata as unknown as Hook['metadata'],
    } satisfies Hook;
    const { runsGet, getEncryptionKeyForRun } = makeWorld(hook);

    const resumed = await resumeHook(hook.token, { approved: true });

    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(hydrateSpy).not.toHaveBeenCalled();

    expect(await resumed.metadata).toEqual(metadata);
    expect(runsGet).not.toHaveBeenCalled();
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it('does not double-wrap a hook handed back to resumeHook', async () => {
    // Passing the result of `getHookByToken` into `resumeHook` must not wrap a
    // Promise in another Promise (which would hand hydration a thenable).
    const metadata = { customData: 'stored' };
    const hook = {
      ...baseHook,
      resumeContext,
      metadata: metadata as unknown as Hook['metadata'],
    } satisfies Hook;
    makeWorld(hook);

    const found = await getHookByToken(hook.token);
    const resumed = await resumeHook(found, { approved: true });

    expect(await resumed.metadata).toEqual(metadata);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy.mock.calls[0]?.[0]).toBe(metadata);
  });
});
