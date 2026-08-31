/**
 * Consumer-side coverage for lazy hook resume: the queue consumer that
 * receives a `hookInput` hoists its idempotent `hook_received` re-ensure
 * above `run_started` and asks the World to return the current replay log
 * with the write (`preloadEvents`). A usable preload initializes the whole
 * invocation from that one call (no `run_started` write, no `events.list`);
 * anything else — including a bounded `hasMore` page, which this path has no
 * continuation machinery for — falls back to the generic `run_started` setup
 * without posting the hook a second time.
 *
 * Drives the real `workflowEntrypoint` replay loop (not just the helpers) so
 * the fast path, the fallback, the preload validation, and the error
 * classification are all exercised end to end. Uses real ULID event IDs and a
 * seeded VM context so the derived hook correlation id matches what replay
 * computes — modeled on precondition-guard-replay.test.ts.
 */
import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { EntityConflictError, HookNotFoundError } from '@workflow/errors';
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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { createContext } from '../vm/index.js';
import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

// In-memory span capture so scenarios can assert the execution span's
// attributes (setup source, run status) — the runtime writes them via the
// global tracer provider.
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider();

beforeAll(() => {
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  otelTrace.setGlobalTracerProvider(tracerProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  otelTrace.disable();
});

/** Merged attributes of every span finished during the scenario. */
function finishedSpanAttributes(): Record<string, unknown> {
  return Object.assign(
    {},
    ...spanExporter.getFinishedSpans().map((s) => s.attributes)
  );
}

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

/**
 * What the fake World returns for the consumer's hoisted `hook_received`
 * create (the one carrying `preloadEvents: true`):
 *
 * - 'event-only' — the plain materialized result. Models an older server
 *   (CBOR response) or a World that ignores `preloadEvents`.
 * - 'complete' — run + the complete replay log + cursor, hasMore: false.
 * - 'partial' — same but hasMore: true (bounded stream); the runtime must
 *   NOT trust it and must fall back to the run_started setup.
 * - 'missing-run' — the log without a reconstructed run entity.
 * - 'missing-resume' — run + log whose hook_received lacks the resumeId.
 * - 'missing-max-events' — complete preload without the event ceiling; the
 *   runtime must not run with limit enforcement disabled.
 */
type HookPreloadMode =
  | 'event-only'
  | 'complete'
  | 'partial'
  | 'missing-run'
  | 'missing-resume'
  | 'missing-max-events';

async function runResumeConsumerScenario(options: {
  /**
   * When true, seed the durable log with the producer's concurrent
   * hook_received write (carrying the resumeId) before the delivery runs —
   * the producer won the resume claim, so the consumer's hoisted write
   * converges on that canonical event instead of creating one.
   */
  preloadHasHookReceived: boolean;
  hookPreload?: HookPreloadMode;
  /**
   * When true, a `run_failed` committed concurrently (after the hook claim
   * won its TOCTOU race) rides in the durable log — and therefore in the
   * preload. The fast path must consume the delivery before any engine
   * dispatch instead of replaying against a terminal run.
   */
  logHasTerminalEvent?: boolean;
  /**
   * When set, the consumer's hoisted `hook_received` `events.create` rejects
   * with this error, exercising the consumer's terminal-vs-transient error
   * classification (consume the message vs rethrow for redelivery).
   */
  reEnsureRejection?: Error;
  /**
   * Drive the queue message through the real (serial, durable-first)
   * `resumeHook()` producer, then commit `hook_disposed` before delivering
   * its wake to the consumer.
   */
  disposeAfterDurableResume?: boolean;
  /**
   * When set, the queue message's hookInput carries the producer-stamped
   * pinned deployment id, activating the consumer's cheap pre-write
   * affinity check. Omitted by default so most scenarios double as
   * older-message fixtures (no deploymentId still parses and runs).
   */
  hookDeploymentId?: string;
}) {
  const hookPreload = options.hookPreload ?? 'event-only';
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
  const hook: Hook = {
    runId,
    hookId: hookCorrelationId,
    token: hookToken,
    ownerId: 'owner_resume_consumer',
    projectId: 'project_resume_consumer',
    environment: 'production',
    createdAt: startedAt,
    specVersion: SPEC_VERSION_CURRENT,
    resumeContext: {
      deploymentId,
      workflowName,
      runSpecVersion: SPEC_VERSION_CURRENT,
      workflowCoreVersion: '5.0.0',
      hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
    },
    resumeCapabilities: {
      hookResumeDedupVersion: HOOK_RESUME_DEDUP_VERSION,
    },
  };

  let eventIndex = 0;
  const event = (data: CreateEventRequest): Event => {
    const t = +startedAt + ++eventIndex * 100;
    return {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(eventIndex),
      createdAt: new Date(t),
    } as Event;
  };

  // Bytes the queue message carries in `hookInput.payload` (and what the
  // canonical hook_received event carries in its eventData).
  const payloadBytes = await dehydrateStepReturnValue(
    { value: 'hook-wins' },
    runId,
    undefined
  );

  // The event log as it exists on this resume delivery: the hook was created
  // on a prior delivery, so hook_created is always present.
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
      correlationId: hookCorrelationId,
      eventData: { token: hookToken },
    }),
  ];
  if (options.preloadHasHookReceived) {
    // The producer's concurrent direct write already landed — it carries the
    // persisted resumeId, so the consumer's hoisted write converges on it.
    durableEvents.push({
      ...event({
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookCorrelationId,
        eventData: { token: hookToken, payload: payloadBytes },
      }),
      resumeId,
    } as Event);
  }
  if (options.logHasTerminalEvent) {
    durableEvents.push(
      event({
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { error: 'concurrent failure' },
      } as CreateEventRequest)
    );
  }

  const createdEvents: CreateEventRequest[] = [];
  const createdParams: Array<CreateEventParams | undefined> = [];
  let reEnsureRejection = options.reEnsureRejection;

  const listEvents = vi.fn(async () => ({
    data: [...durableEvents],
    hasMore: false,
    cursor: durableEvents.at(-1)?.eventId ?? null,
  }));

  const createEvent = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: CreateEventParams
    ) => {
      createdEvents.push(request);
      createdParams.push(params);
      if (request.eventType === 'run_started') {
        // Like the real server, the duplicate run_started preload reads the
        // CURRENT log — including a hook_received the consumer's hoisted
        // write committed moments earlier.
        return {
          run: workflowRun,
          events: [...durableEvents],
          cursor: durableEvents.at(-1)?.eventId ?? null,
          hasMore: false,
        };
      }
      if (request.eventType === 'hook_received') {
        // Simulate the write failing (terminal or transient) so the
        // consumer's error classification runs. Recorded in `createdEvents`
        // above, so the attempt is still observable to assertions.
        if (reEnsureRejection !== undefined) {
          throw reEnsureRejection;
        }
        // Converge on the producer's canonical event when it exists
        // (the (runId, resumeId) claim), otherwise persist ours with the
        // resumeId stamped on it — like the real server does.
        let canonical = durableEvents.find(
          (e) => e.eventType === 'hook_received' && e.resumeId === resumeId
        );
        if (!canonical) {
          canonical = {
            ...event(request),
            resumeId: params?.resumeId,
          } as Event;
          durableEvents.push(canonical);
        }
        if (params?.preloadEvents !== true || hookPreload === 'event-only') {
          return { event: canonical };
        }
        const page = {
          events: [...durableEvents],
          cursor: durableEvents.at(-1)?.eventId ?? null,
          hasMore: hookPreload === 'partial',
          ...(hookPreload === 'missing-max-events'
            ? {}
            : { maxEvents: 25_000 }),
        };
        if (hookPreload === 'missing-run') {
          return { event: canonical, ...page };
        }
        if (hookPreload === 'missing-resume') {
          return {
            event: canonical,
            run: workflowRun,
            ...page,
            // The streamed log's hook_received lost its resumeId (a server
            // that doesn't emit it on the wire): the consumer must not trust
            // the preload as replay input.
            events: page.events.map((e) =>
              e.eventType === 'hook_received'
                ? ({ ...e, resumeId: undefined } as Event)
                : e
            ),
          };
        }
        return { event: canonical, run: workflowRun, ...page };
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
  const runsGet = vi.fn(async () => workflowRun);
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    // Atomic, immutable deployments (as world-vercel declares), with the
    // ambient id matching the run's pin — so the affinity pre-check and the
    // authoritative guard both see a correctly routed delivery.
    capabilities: { deploymentAffinity: true },
    getDeploymentId: vi.fn(async () => deploymentId),
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    hooks: { getByToken: vi.fn(async () => hook) },
    events: { list: listEvents, create: createEvent },
    runs: { get: runsGet },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  const handler = workflowEntrypoint(HOOK_WORKFLOW);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  let delivery: unknown = {
    runId,
    hookInput: {
      hookId: hookCorrelationId,
      resumeId,
      token: hookToken,
      payload: payloadBytes,
      payloadDigest,
      ...(options.hookDeploymentId !== undefined
        ? { deploymentId: options.hookDeploymentId }
        : {}),
    },
  };
  let resumedHook: Hook | undefined;
  if (options.disposeAfterDurableResume) {
    resumedHook = await resumeHook(hookToken, { value: 'hook-wins' });
    delivery = queue.mock.calls.at(-1)?.[1];

    // The producer returned only after hook_received was durable. Commit
    // disposal before delivering its payload-less wake: any hook_received
    // write attempted from here on is refused, like the real server's
    // disposal marker would refuse it.
    reEnsureRejection = new HookNotFoundError(hookToken);
    durableEvents.push(
      event({
        eventType: 'hook_disposed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookCorrelationId,
        eventData: { token: hookToken },
      })
    );
  }

  // Deliver the continuation (no runInput, so turbo is off). Capture whether
  // the handler rethrew: on a transient failure it must reject so the queue
  // redelivers; on a terminal one it resolves (consumes the message).
  let handlerError: unknown;
  try {
    await capturedHandler?.(delivery, {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    });
  } catch (err) {
    handlerError = err;
  }

  const hookReceivedCreates = createdEvents.filter(
    (e) => e.eventType === 'hook_received'
  );
  const hookReceivedParams = createdParams.filter(
    (_, i) => createdEvents[i]?.eventType === 'hook_received'
  );
  const runStartedCreates = createdEvents.filter(
    (e) => e.eventType === 'run_started'
  );
  const runCompletedCreates = createdEvents.filter(
    (e) => e.eventType === 'run_completed'
  );

  return {
    hookReceivedCreates,
    hookReceivedParams,
    runStartedCreates,
    runCompletedCreates,
    listEvents,
    createEvent,
    runsGet,
    handlerError,
    durableEvents,
    queue,
    resumedHook,
  };
}

describe('lazy hook resume consumer preload', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
    spanExporter.reset();
  });

  it('initializes the invocation from a complete hook_received preload: no run_started, no events.list', async () => {
    const {
      hookReceivedCreates,
      hookReceivedParams,
      runStartedCreates,
      runCompletedCreates,
      listEvents,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'complete',
    });

    expect(handlerError).toBeUndefined();
    // Exactly one consumer-side HTTP setup request: the hoisted hook_received
    // with the replay preload opt-in.
    expect(hookReceivedCreates).toHaveLength(1);
    expect(hookReceivedParams[0]?.preloadEvents).toBe(true);
    expect(hookReceivedParams[0]?.resumeId).toBe('resume-consumer-1');
    expect(hookReceivedParams[0]?.resumePayloadDigest).toBe('c'.repeat(64));
    // The preload replaced the entire generic setup.
    expect(runStartedCreates).toHaveLength(0);
    expect(listEvents).not.toHaveBeenCalled();
    // Replay completed off the preloaded log.
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('adds no run fetch for a correctly routed modern message (matching hookInput.deploymentId)', async () => {
    // The pre-write affinity check is a pure ambient-id comparison on the
    // matching path: the run is never fetched, and the streamed replay path
    // is selected exactly as without the field.
    const {
      hookReceivedCreates,
      runStartedCreates,
      runCompletedCreates,
      listEvents,
      runsGet,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'complete',
      hookDeploymentId: 'dpl_resume_consumer_preload',
    });

    expect(handlerError).toBeUndefined();
    expect(runsGet).not.toHaveBeenCalled();
    // The streamed replay path remains selected: one setup request, no
    // run_started, no events.list.
    expect(hookReceivedCreates).toHaveLength(1);
    expect(runStartedCreates).toHaveLength(0);
    expect(listEvents).not.toHaveBeenCalled();
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('initializes replay from the producer-won canonical event in the preload', async () => {
    const {
      hookReceivedCreates,
      runStartedCreates,
      runCompletedCreates,
      listEvents,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: true,
      hookPreload: 'complete',
    });

    expect(handlerError).toBeUndefined();
    // The hoisted write converged on the producer's event (no second event
    // was persisted — the fake's durable log kept a single hook_received) and
    // its preload initialized replay.
    expect(hookReceivedCreates).toHaveLength(1);
    expect(runStartedCreates).toHaveLength(0);
    expect(listEvents).not.toHaveBeenCalled();
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('falls back to run_started when the preload is bounded (hasMore: true)', async () => {
    // This path deliberately has no cursor-continuation machinery: a bounded
    // page must not be replayed (it could be missing the log's tail), so the
    // runtime takes the generic setup instead.
    const {
      hookReceivedCreates,
      runStartedCreates,
      runCompletedCreates,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'partial',
    });

    expect(handlerError).toBeUndefined();
    expect(hookReceivedCreates).toHaveLength(1);
    expect(runStartedCreates).toHaveLength(1);
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('falls back to run_started without re-posting the hook when the World returns no preload', async () => {
    const {
      hookReceivedCreates,
      hookReceivedParams,
      runStartedCreates,
      runCompletedCreates,
      listEvents,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'event-only',
    });

    expect(handlerError).toBeUndefined();
    // The write succeeded (older server / CBOR response) — never posted twice.
    expect(hookReceivedCreates).toHaveLength(1);
    expect(hookReceivedParams[0]?.preloadEvents).toBe(true);
    // Generic setup ran; its preload was read after the hook write committed,
    // so the canonical event is already in the log — no events.list, no splice.
    expect(runStartedCreates).toHaveLength(1);
    expect(listEvents).not.toHaveBeenCalled();
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('falls back to run_started when the producer won and the World returns no preload', async () => {
    const { hookReceivedCreates, runStartedCreates, runCompletedCreates } =
      await runResumeConsumerScenario({
        preloadHasHookReceived: true,
        hookPreload: 'event-only',
      });

    // The hoisted write converges on the producer's canonical event — exactly
    // one write despite both sides attempting it.
    expect(hookReceivedCreates).toHaveLength(1);
    expect(runStartedCreates).toHaveLength(1);
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('uses the safe fallback when the preload lacks a reconstructed run', async () => {
    const {
      hookReceivedCreates,
      runStartedCreates,
      runCompletedCreates,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'missing-run',
    });

    expect(handlerError).toBeUndefined();
    expect(hookReceivedCreates).toHaveLength(1);
    // Unusable preload → generic run_started setup, no second hook post.
    expect(runStartedCreates).toHaveLength(1);
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('consumes the delivery when the complete preload contains a terminal run event', async () => {
    // The hook claim won its race, but a run_failed committed concurrently
    // and rides in the streamed log. The reconstructed run always reads
    // 'running', and QuickJS dispatches before the node replay loop's
    // terminal check — so the fast path itself must consume the delivery
    // before any engine runs.
    const {
      hookReceivedCreates,
      runStartedCreates,
      runCompletedCreates,
      listEvents,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'complete',
      logHasTerminalEvent: true,
    });

    // The write converged and the delivery was consumed (no rethrow)...
    expect(handlerError).toBeUndefined();
    expect(hookReceivedCreates).toHaveLength(1);
    // ...without falling back to run_started, replaying, or completing.
    expect(runStartedCreates).toHaveLength(0);
    expect(listEvents).not.toHaveBeenCalled();
    expect(runCompletedCreates).toHaveLength(0);

    // The preload still initialized (and ended) this delivery, so the span
    // records the setup source and the run's ACTUAL terminal status — not
    // the reconstructed run's synthetic 'running'.
    const attributes = finishedSpanAttributes();
    expect(attributes['workflow.resume_setup_source']).toBe(
      'hook_received_stream'
    );
    expect(attributes['workflow.run.status']).toBe('failed');
  });

  it('falls back to run_started when the preload lacks the event ceiling (maxEvents)', async () => {
    // The preload response plays run_started's role, so a missing/invalid
    // x-wf-max-events would leave event-limit enforcement disabled for the
    // whole run. Require it, and take the generic setup when absent.
    const {
      hookReceivedCreates,
      runStartedCreates,
      runCompletedCreates,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'missing-max-events',
    });

    expect(handlerError).toBeUndefined();
    expect(hookReceivedCreates).toHaveLength(1);
    expect(runStartedCreates).toHaveLength(1);
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('uses the safe fallback when the preload lacks the matching resumeId', async () => {
    const {
      hookReceivedCreates,
      runStartedCreates,
      runCompletedCreates,
      handlerError,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      hookPreload: 'missing-resume',
    });

    expect(handlerError).toBeUndefined();
    expect(hookReceivedCreates).toHaveLength(1);
    expect(runStartedCreates).toHaveLength(1);
    expect(runCompletedCreates).toHaveLength(1);
  });

  it('consumes the message (no rethrow, no replay) when the hoisted write hits a terminal run', async () => {
    // The run went terminal between the producer's dispatch and this delivery,
    // so the write rejects with HookNotFoundError. There is nothing left to
    // resume: the consumer must consume the message (resolve) and NOT replay —
    // acking a terminal delivery is safe because the run is already ended.
    const { hookReceivedCreates, runCompletedCreates, handlerError } =
      await runResumeConsumerScenario({
        preloadHasHookReceived: false,
        reEnsureRejection: new HookNotFoundError('resume-consumer-token'),
      });

    // The write was attempted...
    expect(hookReceivedCreates).toHaveLength(1);
    // ...it rejected terminally, so the handler resolved without rethrowing...
    expect(handlerError).toBeUndefined();
    // ...and replay never proceeded to complete the run.
    expect(runCompletedCreates).toHaveLength(0);
  });

  it('does not lose a resume when disposal commits after publish', async () => {
    const {
      durableEvents,
      handlerError,
      hookReceivedCreates,
      queue,
      resumedHook,
    } = await runResumeConsumerScenario({
      preloadHasHookReceived: false,
      disposeAfterDurableResume: true,
    });

    // resumeHook() returned only after hook_received was durable and the wake
    // was accepted. Disposal may commit before the wake is consumed, but it
    // cannot erase that event, and the delivery replays it from the log.
    expect(resumedHook?.token).toBe('resume-consumer-token');
    expect(queue).toHaveBeenCalledTimes(1);
    expect(hookReceivedCreates).toHaveLength(1);
    expect(handlerError).toBeUndefined();

    // Durability contract: a successful resume survives the queue gap.
    expect(
      durableEvents.filter((event) => event.eventType === 'hook_received')
    ).toHaveLength(1);
  });

  it('rethrows for queue redelivery when the hoisted write hits a transient conflict', async () => {
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

    // The write was attempted...
    expect(hookReceivedCreates).toHaveLength(1);
    // ...and rethrew so VQS redelivers the message.
    expect(handlerError).toBeInstanceOf(EntityConflictError);
    // Replay never proceeded to complete the run on this failed delivery.
    expect(runCompletedCreates).toHaveLength(0);
  });

  it('rethrows for queue redelivery when the preload stream is interrupted', async () => {
    // world-vercel surfaces a frame stream that ends without the _end
    // sentinel as a plain error. The write may have committed, but the
    // (runId, resumeId) claim makes the retry idempotent — rethrow and let
    // the queue redeliver.
    const truncated = new Error(
      'v4 createEvent: frame stream ended without the end-of-stream sentinel'
    );
    const { runCompletedCreates, handlerError } =
      await runResumeConsumerScenario({
        preloadHasHookReceived: false,
        reEnsureRejection: truncated,
      });

    expect(handlerError).toBe(truncated);
    expect(runCompletedCreates).toHaveLength(0);
  });
});
