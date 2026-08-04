/**
 * Consumer-side coverage for lazy hook resume Perf (Option A): the queue
 * consumer that receives a `hookInput` must idempotently ensure the
 * `hook_received` event before replay — EXCEPT when the producer's concurrent
 * direct write already landed in the `run_started` preload, in which case the
 * re-ensure round trip is pure overhead and is skipped.
 *
 * Drives the real `workflowEntrypoint` replay loop (not just the helpers) so
 * the skip / re-ensure decision, the `eventData` reconstruction from
 * `hookInput`, and the in-order splice into the preloaded log are all exercised
 * end to end. Uses real ULID event IDs and a seeded VM context so the derived
 * hook correlation id matches what replay computes — modeled on
 * precondition-guard-replay.test.ts.
 */
import { EntityConflictError, HookNotFoundError } from '@workflow/errors';
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { createContext } from '../vm/index.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

function getWorkflowTransformCode(workflowName: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;
}

// A workflow that creates a hook and awaits its single payload. On a resume
// delivery the hook_received event (whether preloaded or re-ensured) resolves
// the await and the workflow returns the payload's `value`.
const HOOK_WORKFLOW = `
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow(token) {
    const hook = createHook({ token });
    const payload = await hook;
    return payload.value;
  }
  ${getWorkflowTransformCode('workflow')}
`;

async function runResumeConsumerScenario(options: {
  /**
   * When true, seed the run_started preload with the producer's concurrent
   * hook_received write (carrying the resumeId) so the consumer can skip its
   * re-ensure. When false, the preload lacks it and the consumer must
   * re-ensure + splice.
   */
  preloadHasHookReceived: boolean;
  /**
   * When set, the consumer's `hook_received` re-ensure `events.create` rejects
   * with this error, exercising the consumer's terminal-vs-transient error
   * classification (consume the message vs rethrow for redelivery).
   */
  reEnsureRejection?: Error;
}) {
  const runId = 'wrun_resume_consumer_preload';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_resume_consumer_preload';
  const hookToken = 'resume-consumer-token';
  const resumeId = 'resume-consumer-1';
  const payloadDigest = 'c'.repeat(64);
  const startedAt = new Date('2026-05-19T12:00:00.000Z');

  const workflowArgs = await dehydrateWorkflowArguments(
    [hookToken],
    runId,
    undefined
  );

  // Derive the hook correlation id the seeded VM will compute during replay,
  // so the preloaded / re-ensured hook_received matches the workflow's own
  // createHook call (id assignment order: the hook is the first id derived).
  const { globalThis: vmGlobalThis } = createContext({
    seed: `${runId}:${workflowName}:${deploymentId}`,
    fixedTimestamp: +startedAt,
  });
  const vmUlid = monotonicFactory(() => vmGlobalThis.Math.random());
  const hookCorrelationId = `hook_${vmUlid(+startedAt)}`;

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

  const hostUlid = monotonicFactory();
  let eventIndex = 0;
  const event = (data: CreateEventRequest): Event => {
    const t = +startedAt + ++eventIndex * 100;
    return {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: `evnt_${hostUlid(t)}`,
      createdAt: new Date(t),
    } as Event;
  };

  // Bytes the queue message carries in `hookInput.payload` (and, on the skip
  // path, what the preloaded hook_received also carries).
  const payloadBytes = await dehydrateStepReturnValue(
    { value: 'hook-wins' },
    runId,
    undefined
  );

  // The event log as it exists on this resume delivery: the hook was created
  // on a prior delivery, so hook_created is always present.
  const preloadEvents: Event[] = [
    event({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId, workflowName, input: workflowArgs },
    }),
    event({ eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT }),
    event({
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: hookCorrelationId,
      eventData: { token: hookToken },
    }),
  ];
  if (options.preloadHasHookReceived) {
    // The producer's concurrent direct write already landed — it carries the
    // persisted resumeId that the consumer's skip check keys on.
    preloadEvents.push({
      ...event({
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookCorrelationId,
        eventData: { token: hookToken, payload: payloadBytes },
      }),
      resumeId,
    } as Event);
  }

  const durableEvents: Event[] = [...preloadEvents];
  const createdEvents: CreateEventRequest[] = [];

  const listEvents = vi.fn(async () => ({
    data: [...durableEvents],
    hasMore: false,
    cursor: durableEvents.at(-1)?.eventId ?? null,
  }));

  const createEvent = vi.fn(
    async (_runId: string, request: CreateEventRequest) => {
      createdEvents.push(request);
      if (request.eventType === 'run_started') {
        return {
          run: workflowRun,
          events: [...preloadEvents],
          cursor: preloadEvents.at(-1)?.eventId ?? null,
          hasMore: false,
        };
      }
      // Simulate the re-ensure failing (terminal or transient) so the
      // consumer's error classification runs. Recorded in `createdEvents`
      // above, so the attempt is still observable to assertions.
      if (
        request.eventType === 'hook_received' &&
        options.reEnsureRejection !== undefined
      ) {
        throw options.reEnsureRejection;
      }
      const created = event(request);
      durableEvents.push(created);
      return { event: created };
    }
  );

  let capturedHandler:
    | ((message: unknown, metadata: unknown) => Promise<unknown>)
    | undefined;
  const queue = vi.fn().mockResolvedValue({ messageId: 'msg_resume' });
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: { list: listEvents, create: createEvent },
    runs: { get: vi.fn(async () => workflowRun) },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  const handler = workflowEntrypoint(HOOK_WORKFLOW);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  // A continuation delivery carrying the resume's hookInput (no runInput, so
  // turbo is off and the hookInput re-ensure branch runs). Capture whether the
  // handler rethrew: on the transient re-ensure failure it must reject so the
  // queue redelivers; on a terminal one it resolves (consumes the message).
  let handlerError: unknown;
  try {
    await capturedHandler?.(
      {
        runId,
        hookInput: {
          hookId: hookCorrelationId,
          resumeId,
          token: hookToken,
          payload: payloadBytes,
          payloadDigest,
        },
      },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: 'msg_workflow',
        attempt: 1,
      }
    );
  } catch (err) {
    handlerError = err;
  }

  const hookReceivedCreates = createdEvents.filter(
    (e) => e.eventType === 'hook_received'
  );
  const runCompletedCreates = createdEvents.filter(
    (e) => e.eventType === 'run_completed'
  );

  return {
    hookReceivedCreates,
    runCompletedCreates,
    listEvents,
    createEvent,
    handlerError,
  };
}

describe('lazy hook resume consumer preload (Perf Option A)', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('skips the re-ensure when the run_started preload already carries the matching resumeId', async () => {
    const { hookReceivedCreates, runCompletedCreates, listEvents } =
      await runResumeConsumerScenario({ preloadHasHookReceived: true });

    // The producer's concurrent write is already in the preloaded log, so the
    // consumer must NOT issue its own hook_received create.
    expect(hookReceivedCreates).toHaveLength(0);
    // Replay still observed the hook and completed the run.
    expect(runCompletedCreates).toHaveLength(1);
    // The skip path consumes the preload as-is: no fresh events.list.
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('re-ensures and splices the canonical hook_received without a fresh events.list when the preload lacks it', async () => {
    const { hookReceivedCreates, runCompletedCreates, listEvents } =
      await runResumeConsumerScenario({ preloadHasHookReceived: false });

    // The producer's write had not landed, so the consumer re-ensures exactly
    // one hook_received event...
    expect(hookReceivedCreates).toHaveLength(1);
    // ...and replay completes off the spliced-in event.
    expect(runCompletedCreates).toHaveLength(1);
    // The canonical event was spliced into the preloaded log in-order, so no
    // fresh events.list round trip was needed to observe it.
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('consumes the message (no rethrow, no replay) when the re-ensure hits a terminal run', async () => {
    // The run went terminal between the producer's dispatch and this delivery,
    // so the re-ensure rejects with HookNotFoundError. There is nothing left to
    // resume: the consumer must consume the message (resolve) and NOT replay —
    // acking a terminal delivery is safe because the run is already ended.
    const { hookReceivedCreates, runCompletedCreates, handlerError } =
      await runResumeConsumerScenario({
        preloadHasHookReceived: false,
        reEnsureRejection: new HookNotFoundError('resume-consumer-token'),
      });

    // The re-ensure was attempted...
    expect(hookReceivedCreates).toHaveLength(1);
    // ...it rejected terminally, so the handler resolved without rethrowing...
    expect(handlerError).toBeUndefined();
    // ...and replay never proceeded to complete the run.
    expect(runCompletedCreates).toHaveLength(0);
  });

  it('rethrows for queue redelivery when the re-ensure hits a transient conflict', async () => {
    // The (runId, resumeId) constraint exists but the matching event is not yet
    // observable — the producer's parallel write is still in flight, or a
    // redrive raced the claim. This is transient: the consumer must rethrow so
    // the queue redelivers and a later attempt converges on the committed event
    // instead of replaying (and acking) without the payload.
    const { hookReceivedCreates, runCompletedCreates, handlerError } =
      await runResumeConsumerScenario({
        preloadHasHookReceived: false,
        reEnsureRejection: new EntityConflictError('resumeId claim in flight'),
      });

    // The re-ensure was attempted...
    expect(hookReceivedCreates).toHaveLength(1);
    // ...and rethrew so VQS redelivers the message.
    expect(handlerError).toBeInstanceOf(EntityConflictError);
    // Replay never proceeded to complete the run on this failed delivery.
    expect(runCompletedCreates).toHaveLength(0);
  });
});
