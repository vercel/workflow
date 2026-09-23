import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCrossDeploymentSpecVersion, start } from './start.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
  getActiveSpan: vi.fn().mockResolvedValue(undefined),
}));

/**
 * A run's spec version must describe the deployment that executes it. For a
 * cross-deployment `start()` that is the target, whose version comes back on
 * the capability probe — not the caller's World (vercel/workflow#4251).
 */
describe('cross-deployment start() spec version', () => {
  const workflow = Object.assign(() => Promise.resolve('result'), {
    workflowId: 'test-workflow',
  });

  let mockEventsCreate: ReturnType<typeof vi.fn>;
  let mockQueue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockEventsCreate = vi
      .fn()
      .mockImplementation((runId) =>
        Promise.resolve({ run: { runId, status: 'pending' } })
      );
    mockQueue = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  /**
   * A caller World at `callerSpecVersion` whose cross-deployment probe is
   * answered with `probeResponse` (a JSON object, or raw text as sent by
   * pre-versioned deployments).
   */
  function callerWorld(
    callerSpecVersion: number,
    probeResponse: Record<string, unknown> | string
  ) {
    const body =
      typeof probeResponse === 'string'
        ? probeResponse
        : JSON.stringify({
            healthy: true,
            endpoint: 'workflow',
            workflowCoreVersion: '0.0.0-test',
            ...probeResponse,
          });
    setWorld({
      specVersion: callerSpecVersion,
      getDeploymentId: vi.fn().mockResolvedValue('dpl_caller'),
      events: { create: mockEventsCreate },
      queue: mockQueue,
      streams: {
        get: vi.fn(
          async () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
              },
            })
        ),
      },
    });
  }

  /** Every place `start()` writes the run's spec version. */
  function stamped() {
    const created = mockEventsCreate.mock.calls[0];
    const enqueued = mockQueue.mock.calls.find(
      (c) => !String(c[0]).endsWith('health_check')
    );
    return {
      runCreated: created?.[1].specVersion,
      runInput: enqueued?.[1].runInput?.specVersion,
      queueOption: enqueued?.[2].specVersion,
    };
  }

  function probeSent() {
    return mockQueue.mock.calls.some((c) =>
      String(c[0]).endsWith('health_check')
    );
  }

  it('same deployment: stamps the World version and does not probe', async () => {
    callerWorld(SPEC_VERSION_SUPPORTS_SEALED_LOG, {
      specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
    });

    await start(workflow, [], { deploymentId: 'dpl_caller' });

    expect(probeSent()).toBe(false);
    expect(stamped()).toEqual({
      runCreated: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      runInput: SPEC_VERSION_SUPPORTS_SEALED_LOG,
      queueOption: SPEC_VERSION_SUPPORTS_SEALED_LOG,
    });
  });

  it('new starter -> older executor: stamps the target version', async () => {
    callerWorld(SPEC_VERSION_SUPPORTS_SEALED_LOG, {
      specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
    });

    await start(workflow, [], { deploymentId: 'dpl_target' });

    expect(probeSent()).toBe(true);
    // Below the sealed log, so the older executor never meets a `noop`.
    expect(stamped()).toEqual({
      runCreated: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
      runInput: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
      queueOption: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
    });
  });

  it('older starter -> newer executor: caps at the caller World version', async () => {
    // The target reports a version this caller cannot write; stamping it
    // would promise a log this SDK could not have produced.
    callerWorld(SPEC_VERSION_SUPPORTS_SLOT_IDENTITY, {
      specVersion: SPEC_VERSION_MAX_SUPPORTED + 1,
    });

    await start(workflow, [], { deploymentId: 'dpl_target' });

    expect(stamped().runCreated).toBe(SPEC_VERSION_SUPPORTS_SLOT_IDENTITY);
  });

  it('adopts a newer target version up to the caller World version', async () => {
    callerWorld(SPEC_VERSION_CURRENT, {
      specVersion: SPEC_VERSION_MAX_SUPPORTED + 1,
    });

    await start(workflow, [], { deploymentId: 'dpl_target' });

    expect(stamped().runCreated).toBe(SPEC_VERSION_CURRENT);
  });

  it('a pre-CBOR target gets a JSON-transport run it can read', async () => {
    // Below spec 3 the queue message carries no CBOR `runInput`, so the
    // older target reads it with the JSON transport it understands.
    callerWorld(SPEC_VERSION_CURRENT, {
      specVersion: SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
    });

    await start(workflow, [], { deploymentId: 'dpl_target' });

    expect(stamped()).toEqual({
      runCreated: SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
      runInput: undefined,
      queueOption: SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
    });
  });

  it('a target answering in the pre-JSON text format is stamped as event-sourced', async () => {
    callerWorld(
      SPEC_VERSION_CURRENT,
      'Workflow SDK "workflow" endpoint is healthy'
    );

    await start(workflow, [], { deploymentId: 'dpl_target' });

    expect(stamped().runCreated).toBe(SPEC_VERSION_SUPPORTS_EVENT_SOURCING);
  });

  it('with no probe channel, falls back to the lowest served version', async () => {
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn().mockResolvedValue('dpl_caller'),
      events: { create: mockEventsCreate },
      queue: mockQueue,
    });

    await start(workflow, [], { deploymentId: 'dpl_target' });

    expect(stamped().runCreated).toBe(SPEC_VERSION_SUPPORTS_SLOT_IDENTITY);
  });

  it('an explicit specVersion still wins over the probe', async () => {
    callerWorld(SPEC_VERSION_CURRENT, {
      specVersion: SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
    });

    await start(workflow, [], {
      deploymentId: 'dpl_target',
      specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
    });

    expect(stamped().runCreated).toBe(
      SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
    );
  });

  it('rejects attributes the target deployment cannot store, naming the target', async () => {
    callerWorld(SPEC_VERSION_CURRENT, {
      specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES - 1,
    });

    await expect(
      start(workflow, [], {
        deploymentId: 'dpl_target',
        attributes: { team: 'core' },
      })
    ).rejects.toThrow(
      /spec version 4 or later, but the target deployment \(dpl_target\) runs spec version 3/
    );
    expect(mockEventsCreate).not.toHaveBeenCalled();
  });
});

describe('resolveCrossDeploymentSpecVersion', () => {
  it('uses the probed version when it is at or below the caller', () => {
    expect(
      resolveCrossDeploymentSpecVersion(
        { healthy: true, specVersion: 6 },
        SPEC_VERSION_SUPPORTS_SEALED_LOG
      )
    ).toBe(6);
  });

  it('caps the probed version at the caller', () => {
    expect(
      resolveCrossDeploymentSpecVersion({ healthy: true, specVersion: 12 }, 7)
    ).toBe(7);
  });

  it('floors a probe miss at slot identity, not the caller version', () => {
    // What `healthCheck()` resolves with on a timeout.
    expect(resolveCrossDeploymentSpecVersion({ healthy: false }, 7)).toBe(
      SPEC_VERSION_SUPPORTS_SLOT_IDENTITY
    );
    expect(resolveCrossDeploymentSpecVersion(undefined, 7)).toBe(
      SPEC_VERSION_SUPPORTS_SLOT_IDENTITY
    );
  });

  it('never exceeds the caller, even on the fallbacks', () => {
    expect(resolveCrossDeploymentSpecVersion(undefined, 2)).toBe(2);
    expect(resolveCrossDeploymentSpecVersion({ healthy: true }, 1)).toBe(1);
  });

  it('ignores a malformed probed version', () => {
    for (const specVersion of [0, -1, 6.5, Number.NaN]) {
      expect(
        resolveCrossDeploymentSpecVersion({ healthy: false, specVersion }, 7)
      ).toBe(SPEC_VERSION_SUPPORTS_SLOT_IDENTITY);
    }
  });
});
