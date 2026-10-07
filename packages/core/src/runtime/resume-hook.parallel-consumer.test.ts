/**
 * End-to-end coverage for the parallel hook wake: the REAL `resumeHook()`
 * producer (with WORKFLOW_PARALLEL_HOOK_WAKE on) publishes a fenced wake, and
 * the REAL `workflowEntrypoint` consumer receives it, including before the
 * producer's `hook_received` write has committed.
 *
 * The scenarios are the hazards the serial dispatch (vercel/workflow#3841)
 * was introduced to avoid, replayed against the fence:
 *
 * - consumer before commit: the wake overtakes the write. Unfenced, the
 *   replay parks on `await hook` and the deduplicated wake never comes back
 *   (the control scenario reproduces exactly that); fenced, it completes.
 * - write failure after publish: the consumer gives up after the window and
 *   replays an unchanged log, and never writes the event itself.
 * - disposal racing the resume, in both orders (vercel/workflow#3794): the
 *   consumer never writes `hook_received` from the message.
 * - redelivery / duplicate wake.
 * - a misrouted delivery forwards the fence to the pinned deployment.
 */
import { HookNotFoundError } from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  HOOK_RESUME_DEDUP_VERSION,
  HOOK_RESUME_INPUT_VERSION,
  type Hook,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { createContext } from '../vm/index.js';
import { PARALLEL_HOOK_WAKE_ENV_VAR } from './hook-resume-fence.js';
import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const HOOK_WORKFLOW = `
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow(token) {
    const hook = createHook({ token });
    const payload = await hook;
    return payload.value;
  }
  ;globalThis.__private_workflows = new Map([["workflow", workflow]]);
`;

type ProducerWrite =
  /** Commit only when the scenario calls `commitWrite()`. */
  | 'held'
  /** Refuse as a missing hook (disposed / terminal run). */
  | 'not-found';

async function setupScenario(options: {
  producerWrite: ProducerWrite;
  /**
   * Commit a takeover's `hook_disposed{forceClaimedBy}` before the producer's
   * write is attempted: the one way a hook a workflow is still awaiting gets
   * disposed (its awaiter then rejects with HookForceClaimedError).
   */
  disposedBeforeWrite?: boolean;
  /** The consumer's ambient deployment, when it differs from the run's. */
  consumerDeploymentId?: string;
}) {
  const runId = 'wrun_parallel_consumer';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_parallel_consumer';
  const hookToken = 'parallel-consumer-token';
  const startedAt = new Date('2026-05-19T12:00:00.000Z');

  const workflowArgs = await dehydrateWorkflowArguments(
    [hookToken],
    runId,
    undefined
  );
  const { globalThis: vmGlobalThis } = createContext({
    seed: `${runId}:${workflowName}:${deploymentId}`,
    fixedTimestamp: +startedAt,
  });
  const vmUlid = monotonicFactory(() => vmGlobalThis.Math.random());
  const hookId = `hook_${vmUlid(+startedAt)}`;

  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input: workflowArgs,
    deploymentId,
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const hook: Hook = {
    runId,
    hookId,
    token: hookToken,
    ownerId: 'owner',
    projectId: 'project',
    environment: 'production',
    createdAt: startedAt,
    specVersion: SPEC_VERSION_CURRENT,
    resumeContext: {
      deploymentId,
      workflowName,
      runSpecVersion: SPEC_VERSION_CURRENT,
      workflowCoreVersion: '5.1.0',
      hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
    },
    resumeCapabilities: { hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION },
  };

  let slot = 0;
  const event = (data: CreateEventRequest, extra: Partial<Event> = {}) =>
    ({
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(++slot),
      createdAt: new Date(+startedAt + slot * 100),
      ...extra,
    }) as Event;

  const durableEvents: Event[] = [
    event({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId, workflowName, input: workflowArgs },
    }),
    event({ eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT }),
    event({
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: hookId,
      eventData: { token: hookToken },
    }),
  ];
  const disposeHook = (forceClaimed = false) =>
    durableEvents.push(
      event({
        eventType: 'hook_disposed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookId,
        eventData: {
          token: hookToken,
          ...(forceClaimed
            ? {
                forceClaimedBy: {
                  runId: 'wrun_claimer',
                  hookId: 'hook_claimer',
                },
              }
            : {}),
        },
      } as CreateEventRequest)
    );
  if (options.disposedBeforeWrite) disposeHook(true);

  const consumerCreates: CreateEventRequest[] = [];
  let releaseWrite: (() => void) | undefined;
  let producerWriteSettled = false;

  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: CreateEventParams
    ) => {
      if (request.eventType === 'hook_received' && params?.requestId) {
        // Only the queue consumer passes a requestId: it must never write
        // the event in this protocol.
        consumerCreates.push(request);
      }
      if (request.eventType === 'run_started') {
        return {
          run: workflowRun,
          events: [...durableEvents],
          cursor: durableEvents.at(-1)?.eventId ?? null,
          hasMore: false,
        };
      }
      if (request.eventType === 'hook_received') {
        if (options.producerWrite === 'not-found') {
          producerWriteSettled = true;
          throw new HookNotFoundError(hookId);
        }
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        const committed = event(request, { resumeId: params?.resumeId });
        durableEvents.push(committed);
        producerWriteSettled = true;
        return { event: committed };
      }
      if (params?.requestId) consumerCreates.push(request);
      const created = event(request);
      durableEvents.push(created);
      return { event: created };
    }
  );

  const listEvents = vi.fn(
    async (params: { pagination?: { cursor?: string } }) => {
      const cursor = params.pagination?.cursor;
      const data = durableEvents.filter(
        (e) => cursor === undefined || e.eventId > cursor
      );
      return {
        data,
        hasMore: false,
        cursor: data.at(-1)?.eventId ?? cursor ?? null,
      };
    }
  );

  let capturedHandler:
    | ((message: unknown, metadata: unknown) => Promise<unknown>)
    | undefined;
  const queue = vi.fn().mockResolvedValue({ messageId: 'msg_wake' });
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { deploymentAffinity: true },
    getDeploymentId: vi.fn(
      async () => options.consumerDeploymentId ?? deploymentId
    ),
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    hooks: { getByToken: vi.fn(async () => hook) },
    events: { list: listEvents, create: createEvent },
    runs: { get: vi.fn(async () => workflowRun) },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  const handler = workflowEntrypoint(HOOK_WORKFLOW);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  let delivery = 0;
  const deliver = async (message: unknown) => {
    try {
      await capturedHandler?.(message, {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: `msg_delivery_${++delivery}`,
        attempt: 1,
      });
      return undefined;
    } catch (err) {
      return err;
    }
  };

  /** Start the producer and return its first (fenced) wake message. */
  const startResume = async () => {
    const resumed = resumeHook(hookToken, { value: 'hook-wins' });
    // Do not let an expected rejection surface as unhandled before the
    // scenario awaits it.
    resumed.catch(() => {});
    await vi.waitFor(() => expect(queue).toHaveBeenCalled());
    const wake = queue.mock.calls[0][1] as Record<string, any>;
    return { resumed, wake };
  };

  return {
    hookId,
    durableEvents,
    consumerCreates,
    listEvents,
    queue,
    deliver,
    startResume,
    disposeHook,
    commitWrite: () => {
      expect(releaseWrite).toBeDefined();
      releaseWrite?.();
    },
    producerWriteSettled: () => producerWriteSettled,
    runCompleted: () =>
      durableEvents.some((e) => e.eventType === 'run_completed'),
  };
}

describe('parallel hook wake consumer fence', () => {
  const original = process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
  beforeEach(() => {
    process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = '1';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
    else process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = original;
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('control: an UNFENCED wake that overtakes the write parks and strands the resume', async () => {
    const s = await setupScenario({ producerWrite: 'held' });
    const { resumed, wake } = await s.startResume();
    const { hookResumeFence: _drop, ...unfenced } = wake;

    expect(await s.deliver(unfenced)).toBeUndefined();
    // Replayed over a log without the event: parked on `await hook`.
    expect(s.runCompleted()).toBe(false);

    s.commitWrite();
    await resumed;
    // The event is durable now, but nothing will replay the run again.
    expect(s.durableEvents.some((e) => e.eventType === 'hook_received')).toBe(
      true
    );
    expect(s.runCompleted()).toBe(false);
  });

  it('consumer before commit: the fenced replay waits for the write and completes the run', async () => {
    const s = await setupScenario({ producerWrite: 'held' });
    const { resumed, wake } = await s.startResume();
    expect(wake.hookResumeFence).toMatchObject({ hookId: s.hookId });
    expect(s.producerWriteSettled()).toBe(false);

    // The write commits 60ms into the consumer's fence.
    setTimeout(() => s.commitWrite(), 60);
    expect(await s.deliver(wake)).toBeUndefined();

    expect(s.runCompleted()).toBe(true);
    await expect(resumed).resolves.toMatchObject({ hookId: s.hookId });
    // The producer's write is the only writer of the event.
    expect(s.consumerCreates.map((e) => e.eventType)).not.toContain(
      'hook_received'
    );
    expect(
      s.durableEvents.filter((e) => e.eventType === 'hook_received')
    ).toHaveLength(1);
    // The fence re-read from the cursor rather than reloading the log.
    expect(
      s.listEvents.mock.calls.some(
        ([params]) => params.pagination?.cursor !== undefined
      )
    ).toBe(true);
  });

  it('a slow write is rescued by the insurance wake when the window closed first', async () => {
    const s = await setupScenario({ producerWrite: 'held' });
    const { resumed, wake } = await s.startResume();

    // Window closes before the write commits: replays without it, parks.
    expect(
      await s.deliver({
        ...wake,
        hookResumeFence: { ...wake.hookResumeFence, windowMs: 50 },
      })
    ).toBeUndefined();
    expect(s.runCompleted()).toBe(false);

    // The producer measured a write far beyond half the window, so it sent
    // the insurance wake once the write committed.
    const perfNow = performance.now.bind(performance);
    let shifted = false;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      // Jump the producer's monotonic clock past the insurance threshold for
      // the write acknowledgement read.
      return perfNow() + (shifted ? 10_000 : 0);
    });
    shifted = true;
    s.commitWrite();
    await resumed;
    spy.mockRestore();

    expect(s.queue).toHaveBeenCalledTimes(2);
    const [, insurance, insuranceOptions] = s.queue.mock.calls[1];
    expect(insuranceOptions.idempotencyKey).toMatch(/-late$/);
    expect(await s.deliver(insurance)).toBeUndefined();
    expect(s.runCompleted()).toBe(true);
  });

  it('write failure after publish: replays after the window and never writes the event', async () => {
    const s = await setupScenario({ producerWrite: 'not-found' });
    const { resumed, wake } = await s.startResume();
    await expect(resumed).rejects.toBeInstanceOf(HookNotFoundError);

    const startedAt = performance.now();
    expect(
      await s.deliver({
        ...wake,
        hookResumeFence: { ...wake.hookResumeFence, windowMs: 100 },
      })
    ).toBeUndefined();
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(s.runCompleted()).toBe(false);
    expect(s.consumerCreates.map((e) => e.eventType)).not.toContain(
      'hook_received'
    );
    expect(s.durableEvents.some((e) => e.eventType === 'hook_received')).toBe(
      false
    );
  });

  it('disposal before the write: stops fencing early and never writes the event', async () => {
    const s = await setupScenario({
      producerWrite: 'not-found',
      disposedBeforeWrite: true,
    });
    const { resumed, wake } = await s.startResume();
    await expect(resumed).rejects.toBeInstanceOf(HookNotFoundError);

    const startedAt = performance.now();
    expect(await s.deliver(wake)).toBeUndefined();
    // Did not wait out the (default 1s) window.
    expect(performance.now() - startedAt).toBeLessThan(800);
    expect(s.consumerCreates.map((e) => e.eventType)).not.toContain(
      'hook_received'
    );
    expect(s.durableEvents.some((e) => e.eventType === 'hook_received')).toBe(
      false
    );
  });

  it('disposal after the committed write: the payload is still delivered', async () => {
    const s = await setupScenario({ producerWrite: 'held' });
    const { resumed, wake } = await s.startResume();
    s.commitWrite();
    await resumed;
    s.disposeHook();

    expect(await s.deliver(wake)).toBeUndefined();
    expect(s.runCompleted()).toBe(true);
    expect(s.consumerCreates.map((e) => e.eventType)).not.toContain(
      'hook_received'
    );
  });

  it('redelivery and duplicate wakes converge on one completion', async () => {
    const s = await setupScenario({ producerWrite: 'held' });
    const { resumed, wake } = await s.startResume();
    s.commitWrite();
    await resumed;

    expect(await s.deliver(wake)).toBeUndefined();
    expect(await s.deliver(wake)).toBeUndefined();
    expect(await s.deliver({ ...wake, hookResumeFence: undefined })).toBe(
      undefined
    );
    expect(
      s.durableEvents.filter((e) => e.eventType === 'run_completed')
    ).toHaveLength(1);
    expect(
      s.durableEvents.filter((e) => e.eventType === 'hook_received')
    ).toHaveLength(1);
  });

  it('a misrouted delivery forwards the fence to the pinned deployment without fencing itself', async () => {
    const s = await setupScenario({
      producerWrite: 'held',
      consumerDeploymentId: 'dpl_somewhere_else',
    });
    const { resumed, wake } = await s.startResume();
    const listCallsBefore = s.listEvents.mock.calls.length;

    expect(await s.deliver(wake)).toBeUndefined();
    const rerouted = s.queue.mock.calls.at(-1)?.[1] as Record<string, any>;
    expect(s.queue.mock.calls.length).toBeGreaterThan(1);
    expect(rerouted.hookResumeFence).toEqual(wake.hookResumeFence);
    expect(s.listEvents.mock.calls.length).toBe(listCallsBefore);

    s.commitWrite();
    await resumed;
  });
});
