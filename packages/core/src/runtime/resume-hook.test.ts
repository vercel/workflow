import { HookNotFoundError } from '@workflow/errors';
import {
  type Hook,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importKey } from '../encryption.js';
import { bytesToBase64, deriveRunKeyPair } from '../sealed-box.js';
import {
  hydrateStepReturnValue,
  peekFormatPrefix,
  runPayloadKeys,
  SerializationFormat,
} from '../serialization.js';
import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

describe('resumeHook', () => {
  afterEach(() => setWorld(undefined));

  it('rejects a retained Hook after its run ends', async () => {
    const hook = {
      runId: 'wrun_1',
      hookId: 'hook_1',
      token: 'order:1',
      ownerId: 'owner_1',
      projectId: 'project_1',
      environment: 'production',
      createdAt: new Date(),
    } satisfies Hook;
    const run = {
      runId: hook.runId,
      status: 'completed',
      deploymentId: 'deployment_1',
      workflowName: 'processOrder',
      output: undefined,
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      attributes: {},
    } satisfies WorkflowRun;
    const createEvent = vi.fn();
    const getEncryptionKeyForRun = vi.fn();
    const queue = vi.fn();

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      runs: { get: vi.fn().mockResolvedValue(run) },
      events: { create: createEvent },
      getEncryptionKeyForRun,
      queue,
    } as unknown as World);

    await expect(resumeHook(hook.token, {})).rejects.toSatisfy(
      HookNotFoundError.is
    );
    expect(createEvent).not.toHaveBeenCalled();
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  describe('payload encryption', () => {
    const RUN_KEY_MATERIAL = new Uint8Array(32).fill(0x4d);

    function makeHook(): Hook {
      return {
        runId: 'wrun_1',
        hookId: 'hook_1',
        token: 'order:1',
        ownerId: 'owner_1',
        projectId: 'project_1',
        environment: 'production',
        createdAt: new Date(),
        specVersion: SPEC_VERSION_CURRENT,
      } as Hook;
    }

    function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
      return {
        runId: 'wrun_1',
        status: 'running',
        deploymentId: 'deployment_1',
        workflowName: 'processOrder',
        specVersion: SPEC_VERSION_CURRENT,
        createdAt: new Date(),
        updatedAt: new Date(),
        attributes: {},
        executionContext: { workflowCoreVersion: '5.0.0-beta.40' },
        ...overrides,
      } as WorkflowRun;
    }

    /** Wire up a world and return the spies plus the captured event. */
    function setupWorld(run: WorkflowRun) {
      const createEvent = vi.fn().mockResolvedValue(undefined);
      const getEncryptionKeyForRun = vi
        .fn()
        .mockResolvedValue(RUN_KEY_MATERIAL);
      const queue = vi.fn().mockResolvedValue(undefined);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        hooks: { getByToken: vi.fn().mockResolvedValue(makeHook()) },
        runs: { get: vi.fn().mockResolvedValue(run) },
        events: { create: createEvent },
        getEncryptionKeyForRun,
        queue,
        getDeploymentId: vi.fn().mockResolvedValue('deployment_2'),
      } as unknown as World);

      return { createEvent, getEncryptionKeyForRun, queue };
    }

    function capturedPayload(
      createEvent: ReturnType<typeof vi.fn>
    ): Uint8Array {
      return createEvent.mock.calls[0][1].eventData.payload as Uint8Array;
    }

    it('seals the payload to the run public key without fetching a key', async () => {
      // This is the whole point of the change: a cross-deployment resume
      // should not need `getEncryptionKeyForRun` at all, because that is the
      // ~350ms `run-key` API round trip.
      const { publicKey } = await deriveRunKeyPair(RUN_KEY_MATERIAL);
      const run = makeRun({ encryptionPublicKey: bytesToBase64(publicKey) });
      const { createEvent, getEncryptionKeyForRun } = setupWorld(run);

      await resumeHook('order:1', { approved: true });

      expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
      expect(peekFormatPrefix(capturedPayload(createEvent))).toBe(
        SerializationFormat.SEALED
      );
    });

    it('produces a payload the owning run can actually open', async () => {
      // End-to-end: seal as the resumer, then hydrate exactly as the owning
      // deployment would after re-deriving its own key material.
      const keyPair = await deriveRunKeyPair(RUN_KEY_MATERIAL);
      const run = makeRun({
        encryptionPublicKey: bytesToBase64(keyPair.publicKey),
      });
      const { createEvent } = setupWorld(run);

      await resumeHook('order:1', { approved: true, count: 7 });

      const keys = runPayloadKeys(await importKey(RUN_KEY_MATERIAL), keyPair);
      const hydrated = await hydrateStepReturnValue(
        capturedPayload(createEvent),
        'wrun_1',
        keys
      );
      expect(hydrated).toEqual({ approved: true, count: 7 });
    });

    it('falls back to the symmetric path when the run has no public key', async () => {
      // Runs created by older SDKs carry no public key; those must keep
      // working exactly as before.
      const run = makeRun();
      const { createEvent, getEncryptionKeyForRun } = setupWorld(run);

      await resumeHook('order:1', { approved: true });

      expect(getEncryptionKeyForRun).toHaveBeenCalledWith(run);
      expect(peekFormatPrefix(capturedPayload(createEvent))).toBe(
        SerializationFormat.ENCRYPTED
      );
    });

    it('falls back to the symmetric path when the public key is malformed', async () => {
      // A corrupt stored value must degrade to the previous behavior rather
      // than fail the resumption.
      for (const bad of ['not-base64!!', bytesToBase64(new Uint8Array(31))]) {
        const run = makeRun({ encryptionPublicKey: bad });
        const { createEvent, getEncryptionKeyForRun } = setupWorld(run);

        await resumeHook('order:1', { approved: true });

        expect(getEncryptionKeyForRun).toHaveBeenCalled();
        expect(peekFormatPrefix(capturedPayload(createEvent))).toBe(
          SerializationFormat.ENCRYPTED
        );
        setWorld(undefined);
      }
    });

    it('seals even when the target reports a core version predating encp', async () => {
      // Presence of the public key is the gate, deliberately not the version
      // table: a run only has a key if the runtime that created it could open
      // one, which is a stronger attestation than a version compare and stays
      // correct when package versions drift.
      const { publicKey } = await deriveRunKeyPair(RUN_KEY_MATERIAL);
      const run = makeRun({
        encryptionPublicKey: bytesToBase64(publicKey),
        executionContext: { workflowCoreVersion: '4.2.0-beta.64' },
      });
      const { createEvent, getEncryptionKeyForRun } = setupWorld(run);

      await resumeHook('order:1', { approved: true });

      expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
      expect(peekFormatPrefix(capturedPayload(createEvent))).toBe(
        SerializationFormat.SEALED
      );
    });

    it('reuses a caller-supplied symmetric key instead of sealing', async () => {
      // resumeWebhook already had to fetch the symmetric key to hydrate hook
      // metadata, so sealing would add an ECDH without saving a round trip.
      const keyPair = await deriveRunKeyPair(RUN_KEY_MATERIAL);
      const run = makeRun({
        encryptionPublicKey: bytesToBase64(keyPair.publicKey),
      });
      const { createEvent, getEncryptionKeyForRun } = setupWorld(run);

      await resumeHook(
        makeHook(),
        { approved: true },
        await importKey(RUN_KEY_MATERIAL)
      );

      expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
      expect(peekFormatPrefix(capturedPayload(createEvent))).toBe(
        SerializationFormat.ENCRYPTED
      );
    });

    it('writes plaintext when encryption is disabled entirely', async () => {
      const run = makeRun();
      const createEvent = vi.fn().mockResolvedValue(undefined);
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        hooks: { getByToken: vi.fn().mockResolvedValue(makeHook()) },
        runs: { get: vi.fn().mockResolvedValue(run) },
        events: { create: createEvent },
        // No getEncryptionKeyForRun at all — encryption not configured.
        queue: vi.fn().mockResolvedValue(undefined),
        getDeploymentId: vi.fn().mockResolvedValue('deployment_2'),
      } as unknown as World);

      await resumeHook('order:1', { approved: true });

      expect(peekFormatPrefix(capturedPayload(createEvent))).toBe(
        SerializationFormat.DEVALUE_V1
      );
    });
  });
});
