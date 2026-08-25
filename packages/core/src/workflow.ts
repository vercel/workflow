import type { Span } from '@opentelemetry/api';
import {
  ERROR_SLUGS,
  ReplayDivergenceError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  createWorkflowBaseUrl,
  type PromiseWithResolvers,
  withResolvers,
} from '@workflow/utils';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, WorkflowRun, WorldCapabilities } from '@workflow/world';
import { SPEC_VERSION_SUPPORTS_COMPRESSION } from '@workflow/world/spec-version';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { EventConsumerResult, EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import { ENOTSUP, WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { isDeliveryIdle } from './private.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { getPortLazy } from './runtime/get-port-lazy.js';
import { runIdCreatedAt } from './runtime/run-id-time.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { getWorld } from './runtime/world.js';
import type { PayloadKey } from './serialization/encryption.js';
import {
  dehydrateWorkflowReturnValue,
  hydrateWorkflowArguments,
} from './serialization.js';
import { createUseStep } from './step.js';
import {
  BODY_INIT_SYMBOL,
  STABLE_ULID,
  WORKFLOW_CREATE_HOOK,
  WORKFLOW_GET_STREAM_ID,
  WORKFLOW_SET_ATTRIBUTES,
  WORKFLOW_SLEEP,
  WORKFLOW_USE_STEP,
} from './symbols.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import { applyWorkflowSuspensionToSpan, trace } from './telemetry.js';
import { getWorkflowRunStreamId } from './util.js';
import { createContext } from './vm/index.js';
import { runCachedWorkflowScript } from './vm/script-cache.js';
import {
  createAbortSignalStatics,
  createCreateAbortController,
} from './workflow/abort-controller.js';
import { createSetAttributes } from './workflow/attribute-dispatcher.js';
import type { WorkflowMetadata } from './workflow/get-workflow-metadata.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './workflow/get-workflow-metadata.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

/**
 * Drain pending queue items at workflow completion (success or failure).
 *
 * Treats completion as a final suspension so unawaited hook, wait, and
 * attribute operations are recorded before the run becomes terminal. This
 * also lets a final `controller.abort()` reach in-flight steps.
 *
 * It records `*_created` and native attribute events, but never executes step
 * bodies: `step_started` is rejected after the run becomes terminal. A
 * fire-and-forget step therefore needs a later suspension to be scheduled.
 *
 * Drain failures do not change the workflow's terminal outcome.
 */
async function drainPendingQueueItems(
  runId: string,
  pendingQueue: Map<string, QueueItem>,
  vmGlobalThis: typeof globalThis,
  workflowRun: WorkflowRun,
  outcome: 'completed' | 'failed',
  /**
   * In turbo mode, gates final `*_created` writes on backgrounded
   * `run_started`. Undefined when `run_started` is awaited.
   */
  runReadyBarrier?: Promise<unknown>
): Promise<void> {
  if (pendingQueue.size === 0) return;
  // Implicitly dispose any abort hooks (system hooks) that are still alive at
  // workflow completion so they don't leak rows in the hooks table for the
  // run's lifetime. Skip hooks that already have an abort in flight; those
  // will emit hook_received via the abort processing path. User hooks
  // (isSystem !== true) are intentionally left alone: their lifetime is
  // managed by the user's code, not the runtime.
  for (const item of pendingQueue.values()) {
    if (
      item.type === 'hook' &&
      item.isSystem &&
      !item.disposed &&
      !item.abortRequested
    ) {
      item.disposed = true;
    }
  }
  try {
    const world = await getWorld();
    const synthesized = new WorkflowSuspension(pendingQueue, vmGlobalThis);
    await handleSuspension({
      suspension: synthesized,
      world,
      run: workflowRun,
      runReadyBarrier,
    });
  } catch (err) {
    runtimeLogger.warn(
      `Failed to drain pending queue items for ${outcome} workflow run`,
      {
        workflowRunId: runId,
        message: err instanceof Error ? err.message : String(err),
      }
    );
  }
}

/** Everything needed to cold-start a workflow VM over an event log. */
interface WorkflowSessionOptions {
  readonly workflowCode: string;
  readonly workflowRun: WorkflowRun;
  readonly events: Event[];
  readonly encryptionKey: PayloadKey | undefined;
  readonly replayPayloadCache: ReplayPayloadCache;
  readonly runReadyBarrier?: Promise<unknown>;
  readonly worldCapabilities?: WorldCapabilities;
}

/**
 * A live workflow VM, parked at a suspension boundary. `resume` advances it
 * by appending events instead of replaying from scratch.
 */
export interface WorkflowSession {
  readonly workflowRun: WorkflowRun;
  readonly argumentCount: number;
  resume(events: Event[]): Promise<WorkflowResumeResult>;
}

/** A finished execution attempt: the workflow's output or a live boundary. */
export type WorkflowResult =
  | {
      readonly type: 'completed';
      readonly output: unknown;
      /** `typeof` the raw return value, for telemetry. */
      readonly resultType: string;
    }
  | {
      readonly type: 'suspended';
      readonly suspension: WorkflowSuspension;
      readonly session: WorkflowSession;
      /**
       * Events the replay walked past unclaimed and is still holding, if any.
       * Ordinary on a suspension, and only actionable across a run's
       * suspensions, so it is reported for telemetry rather than acted on here.
       */
      readonly parked?: {
        readonly count: number;
        readonly eventId: string;
        readonly eventType: string;
      };
    };

/**
 * `resume` can additionally decline: `{ type: 'replay' }` means "this
 * session is unusable, cold-replay instead". A fresh replay never declines.
 */
export type WorkflowResumeResult = WorkflowResult | { readonly type: 'replay' };

/** The session's private state machine. */
type WorkflowSessionState =
  | {
      readonly type: 'running';
      readonly interruption: PromiseWithResolvers<never>;
    }
  | { readonly type: 'suspended'; readonly suspension: WorkflowSuspension }
  | { readonly type: 'replay' }
  | { readonly type: 'completed' };

/** Cold-start: build a fresh VM session and replay it over `events`. */
export function replayWorkflow(
  options: WorkflowSessionOptions
): Promise<WorkflowResult> {
  return traceExecution(
    'replay',
    options.workflowRun,
    options.events,
    async (span) => {
      const { session, execution } = await createWorkflowSession(options);
      span?.setAttributes({
        ...Attribute.WorkflowArgumentsCount(session.argumentCount),
      });
      return recordResult(await execution, span);
    }
  );
}

/** Warm-start: advance a retained session by appending events. */
export function resumeWorkflow(
  session: WorkflowSession,
  events: Event[]
): Promise<WorkflowResumeResult> {
  return traceExecution(
    'retained',
    session.workflowRun,
    events,
    async (span) => {
      span?.setAttributes({
        ...Attribute.WorkflowArgumentsCount(session.argumentCount),
      });
      const result = await session.resume(events);
      return result.type === 'replay' ? result : recordResult(result, span);
    }
  );
}

function traceExecution<T>(
  mode: 'replay' | 'retained',
  workflowRun: WorkflowRun,
  events: Event[],
  fn: (span: Span | undefined) => Promise<T>
): Promise<T> {
  return trace(`workflow.run ${workflowRun.workflowName}`, (span) => {
    span?.setAttributes({
      ...Attribute.WorkflowName(workflowRun.workflowName),
      ...Attribute.WorkflowRunId(workflowRun.runId),
      ...Attribute.WorkflowRunStatus(workflowRun.status),
      ...Attribute.WorkflowEventsCount(events.length),
      ...Attribute.WorkflowExecutionMode(mode),
    });
    return fn(span);
  });
}

function recordResult(
  result: WorkflowResult,
  span: Span | undefined
): WorkflowResult {
  if (result.type === 'completed') {
    span?.setAttributes({
      ...Attribute.WorkflowResultType(result.resultType),
    });
  } else if (span) {
    applyWorkflowSuspensionToSpan(result.suspension, span);
    // Events this pass walked past unclaimed and is still holding. Ordinary on
    // a suspension: an out-of-band delivery that landed ahead of the code that
    // reads it waits for the pass that reaches that code, and failing here
    // would fail exactly the runs that tolerance exists for. The case that is
    // not ordinary (the same event still held pass after pass) is a shape
    // across these spans, which is why the eventId is on each one and no pass
    // tries to rule on it alone.
    if (result.parked) {
      span.setAttributes({
        ...Attribute.WorkflowParkedEventsCount(result.parked.count),
        ...Attribute.WorkflowParkedEventId(result.parked.eventId),
        ...Attribute.WorkflowParkedEventType(result.parked.eventType),
      });
    }
  }
  return result;
}

/**
 * Single-shot replay: execute the workflow over `events` and either return
 * its output or throw its suspension. Kept for the extensive existing test
 * suites; production code goes through `replayWorkflow`/`resumeWorkflow`.
 */
export async function runWorkflow(
  workflowCode: string,
  workflowRun: WorkflowRun,
  events: Event[],
  encryptionKey: PayloadKey | undefined,
  /**
   * Optional per-run cache for replay payload preparation and immutable final
   * values. Owned by the inline execution loop for this invocation.
   */
  replayPayloadCache: ReplayPayloadCache = new ReplayPayloadCache(
    encryptionKey
  ),
  /**
   * Turbo mode only: resolves once the backgrounded `run_started` has landed.
   * Threaded into the end-of-run drain so fire-and-forget `*_created` writes
   * committed at workflow completion order after the run's creation. Undefined
   * outside turbo, where `run_started` is awaited up front.
   */
  runReadyBarrier?: Promise<unknown>,
  /**
   * Features supported by the World executing this workflow. Missing
   * capabilities are treated as unsupported.
   */
  worldCapabilities?: WorldCapabilities
): Promise<Uint8Array | unknown> {
  const result = await replayWorkflow({
    workflowCode,
    workflowRun,
    events,
    encryptionKey,
    replayPayloadCache,
    runReadyBarrier,
    worldCapabilities,
  });
  if (result.type === 'suspended') throw result.suspension;
  return result.output;
}

async function createWorkflowSession({
  workflowCode,
  workflowRun,
  events,
  encryptionKey,
  replayPayloadCache,
  runReadyBarrier,
  worldCapabilities,
}: WorkflowSessionOptions): Promise<{
  session: WorkflowSession;
  execution: Promise<WorkflowResult>;
}> {
  const startedAt = workflowRun.startedAt;
  if (!startedAt) {
    throw new WorkflowRuntimeError(
      `Workflow run "${workflowRun.runId}" has no "startedAt" timestamp (should not happen)`
    );
  }

  // Seed and initial clock must be available before I/O and remain stable on
  // replay. After the first event, EventsConsumer advances the VM clock from
  // each event's `createdAt`.
  const fixedTimestamp =
    runIdCreatedAt(workflowRun.runId) ?? +workflowRun.createdAt;

  // Truthiness, not presence: `vercel env pull` writes `VERCEL_URL=""` into
  // `.env.local`, and a framework that loads that file locally would otherwise
  // put us on the Vercel branch with nothing to build a host from, making
  // `https://` the base URL of every run.
  const isVercel = Boolean(process.env.VERCEL_URL);
  // Load getPort lazily to prevent Turbopack from tracing get-port's
  // fs ops (readdir, readFile) into the flow route bundle. The resolved
  // port is cached per process (see get-port-lazy.ts), so this is cheap
  // on replays after the first.
  const workflowBaseUrl = createWorkflowBaseUrl(
    isVercel
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${(await getPortLazy()) ?? 3000}`
  );

  const {
    context,
    globalThis: vmGlobalThis,
    updateTimestamp,
  } = createContext({
    seed: `${workflowRun.runId}:${workflowRun.workflowName}:${workflowRun.deploymentId}`,
    fixedTimestamp,
  });

  const initialInterruption = withResolvers<never>();
  let state: WorkflowSessionState = {
    type: 'running',
    interruption: initialInterruption,
  };

  const onWorkflowError = (error: Error): void => {
    switch (state.type) {
      case 'running': {
        const { interruption } = state;
        state = WorkflowSuspension.is(error)
          ? { type: 'suspended', suspension: error }
          : { type: 'replay' };
        // Each parked step consumer schedules its own (identical) suspension
        // signal; the first one lands here, and bumping the generation makes
        // the step-consumer guard drop the rest at fire time.
        workflowContext.suspensionGeneration++;
        interruption.reject(error);
        return;
      }
      case 'suspended':
        // Same-boundary duplicates were staled by the generation bump above,
        // so anything landing here is out-of-band: an unguarded sleep/hook/
        // attribute signal or a divergence. Those boundaries are unretainable
        // (the runtime demotes them too), so fall back to replay.
        state = { type: 'replay' };
        return;
      case 'replay':
      case 'completed':
        return;
    }
    state satisfies never;
  };

  const ulid = monotonicFactory(() => vmGlobalThis.Math.random());
  // Correlation IDs must be replay-stable. `startedAt` differs between a turbo
  // delivery and a later server-backed replay, so use fixedTimestamp.
  // The draw counter is the progress metric for `quiesceEarlierCascades`
  // (WORKFLOW_LOG_ORDER_DRAWS): a quiet turn is one that drew nothing. It
  // counts EVERY draw from this sequence. This same function is installed as
  // the `STABLE_ULID` global below, which serialization draws stream ids
  // from during dehydration. This is deliberate because quiescence must also
  // wait out serialization-driven draws, and counting extra draws only extends
  // the wait (see the termination note on `quiesceEarlierCascades`).
  let mintCount = 0;
  const generateUlid = () => {
    mintCount += 1;
    return ulid(fixedTimestamp);
  };
  const generateNanoid = nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
    new Uint8Array(size).map(() => 256 * vmGlobalThis.Math.random())
  );

  // Create a mutable holder for the promise queue so the EventsConsumer
  // can access the current queue state via a getter. The queue is mutated
  // by step/hook/sleep callbacks as events are processed.
  const promiseQueueHolder = { current: Promise.resolve() };

  // Same reason as the queue holder: the consumer is built before the context
  // whose delivery state it has to read. Idle until the context exists, which
  // is before any delivery can be registered against it.
  const deliveryIdleHolder = { current: (): boolean => true };

  // The VM clock only ever moves forward. Consumption order is log order for
  // everything whose order the replay decides, but an event the consumer
  // parked is delivered after the walk has already passed events written after
  // it, and letting its `createdAt` set the clock would make `Date.now()` go
  // backwards inside a single replay.
  let clock = fixedTimestamp;

  const eventsConsumer = new EventsConsumer(events, {
    onConsumedEvent: (event) => {
      const at = +event.createdAt;
      if (at > clock) {
        clock = at;
        updateTimestamp(at);
      }
    },
    onUnconsumedEvent: (event) => {
      onWorkflowError(
        new ReplayDivergenceError(
          `Replay could not consume event: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}.`,
          { eventId: event.eventId }
        )
      );
    },
    // Both branches log at `debug`, so neither reaches the console unless
    // `DEBUG` matches. A duplicate is a permanent feature of the log: every
    // later replay re-reads it and lands here again, so anything the logger
    // prints unconditionally would print once per replay for the life of the
    // run. There is also nothing to act on. Ignoring the event is the correct
    // outcome, not a degraded one, and no user change makes the straggler go
    // away. What the levels are for is diagnosis after the fact, which is
    // exactly what `DEBUG=workflow:runtime:debug` is for.
    onDuplicateEvent: (event, firstEventType) => {
      const details = {
        workflowRunId: workflowRun.runId,
        eventId: event.eventId,
        eventType: event.eventType,
        firstEventType,
        correlationId: event.correlationId,
      };
      if (firstEventType !== event.eventType) {
        // Two writers reached opposite conclusions about one entity: a
        // `step_failed` behind a `step_completed`, or the reverse. Ignoring it
        // is still correct and still deterministic (replay reads the first one
        // at the same position every time), but unlike a re-commit of the same
        // outcome there is no reading of this where both writers were right,
        // so the discarded outcome gets its own message.
        runtimeLogger.debug(
          'Ignoring inert event that decides an already-decided outcome differently',
          details
        );
        return;
      }
      // The first event of this class decided the outcome at a lower log
      // position and replay reads that one. Recorded because a straggler is
      // still evidence of two replays writing for the same entity, which is
      // worth seeing when diagnosing a run.
      runtimeLogger.debug(
        'Ignoring inert event that repeats a class already in the event log',
        details
      );
    },
    getPromiseQueue: () => promiseQueueHolder.current,
    isDeliveryIdle: () => deliveryIdleHolder.current(),
  });

  const workflowContext: WorkflowOrchestratorContext = {
    runId: workflowRun.runId,
    encryptionKey,
    worldCapabilities,
    globalThis: vmGlobalThis,
    onWorkflowError,
    eventsConsumer,
    generateUlid,
    generateNanoid,
    get mintCount() {
      return mintCount;
    },
    invocationsQueue: new Map(),
    // Use getter/setter so the EventsConsumer's getPromiseQueue() always
    // sees the latest queue state as it's mutated by step/hook/sleep callbacks.
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
    pendingDeliveries: 0,
    suspensionGeneration: 0,
    pendingDeliveryBarriers: new Map(),
    replayPayloadCache,
  };

  deliveryIdleHolder.current = () => isDeliveryIdle(workflowContext);

  // Consume run lifecycle events - these are structural events that don't
  // need special handling in the workflow, but must be consumed to advance
  // past them in the event log
  let consumedRunStarted = false;
  workflowContext.eventsConsumer.subscribe((event) => {
    if (!event) {
      return EventConsumerResult.NotConsumed;
    }

    // Consume run_created - every run has exactly one
    if (event.eventType === 'run_created') {
      return EventConsumerResult.Consumed;
    }

    // Consume the first run_started. Two replays can each write one (the
    // create is idempotent for a run already running, which makes the write
    // safe, not single-shot); the first is the one the replay observes, and
    // the consumer skips the rest rather than advancing the workflow clock
    // twice.
    if (event.eventType === 'run_started') {
      if (consumedRunStarted) {
        return EventConsumerResult.NotConsumed;
      }
      consumedRunStarted = true;
      return EventConsumerResult.Consumed;
    }

    // Attribute writes performed from a step have no workflow-body call to
    // consume them during replay; they are already reflected in the run
    // snapshot and remain structural until a read API is introduced.
    if (
      event.eventType === 'attr_set' &&
      event.eventData.writer.type === 'step'
    ) {
      return EventConsumerResult.Consumed;
    }

    return EventConsumerResult.NotConsumed;
  });

  const useStep = createUseStep(workflowContext);
  const createHook = createCreateHook(workflowContext);
  const sleep = createSleep(workflowContext);
  const setAttributes = createSetAttributes(workflowContext);

  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_USE_STEP] = useStep;
  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_SET_ATTRIBUTES] = setAttributes;
  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_CREATE_HOOK] = createHook;
  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_SLEEP] = sleep;
  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_GET_STREAM_ID] = (namespace?: string) =>
    getWorkflowRunStreamId(workflowRun.runId, namespace);

  // For the workflow VM, we store the context in a symbol on the `globalThis` object
  const ctx: WorkflowMetadata = {
    workflowName: workflowRun.workflowName,
    workflowRunId: workflowRun.runId,
    workflowStartedAt: new vmGlobalThis.Date(+startedAt),
    url: workflowBaseUrl,
    features: { encryption: !!encryptionKey },
  };

  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[WORKFLOW_CONTEXT_SYMBOL] = ctx;
  // Serialization mints stream ids through this symbol, and calls it with no
  // seed time. `monotonicFactory` returns `encodeTime(lastTime)` on its
  // increment branch, so one such call latches the *host* wall clock into
  // `lastTime`, and every id the run mints afterwards carries that timestamp
  // instead of `fixedTimestamp`, a value that differs on every replay. Binding
  // the seed time here keeps the whole run on one replay-stable clock.
  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[STABLE_ULID] = generateUlid;

  // Workflow code must import the deterministic `fetch` step from `workflow`.
  vmGlobalThis.fetch = () => {
    throw new vmGlobalThis.Error(
      `Global "fetch" is unavailable in workflow functions. Use the "fetch" step function from "workflow" to make HTTP requests.\n\nLearn more: https://workflow-sdk.dev/err/${ERROR_SLUGS.FETCH_IN_WORKFLOW_FUNCTION}`
    );
  };

  // Override timeout/interval functions to throw helpful errors
  // These are not supported in workflow functions because they rely on
  // asynchronous scheduling which breaks deterministic replay
  const timeoutErrorMessage =
    'Timeout functions like "setTimeout" and "setInterval" are not supported in workflow functions. Use the "sleep" function from "workflow" for time-based delays.';

  (vmGlobalThis as any).setTimeout = () => {
    throw new WorkflowRuntimeError(timeoutErrorMessage, {
      slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
    });
  };
  (vmGlobalThis as any).setInterval = () => {
    throw new WorkflowRuntimeError(timeoutErrorMessage, {
      slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
    });
  };
  (vmGlobalThis as any).clearTimeout = () => {
    throw new WorkflowRuntimeError(timeoutErrorMessage, {
      slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
    });
  };
  (vmGlobalThis as any).clearInterval = () => {
    throw new WorkflowRuntimeError(timeoutErrorMessage, {
      slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
    });
  };
  (vmGlobalThis as any).setImmediate = () => {
    throw new WorkflowRuntimeError(timeoutErrorMessage, {
      slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
    });
  };
  (vmGlobalThis as any).clearImmediate = () => {
    throw new WorkflowRuntimeError(timeoutErrorMessage, {
      slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
    });
  };

  // `AbortController` and `AbortSignal` in the workflow VM are hook-backed
  // for deterministic replay. The controller's abort() queues a hook resumption,
  // and signal.aborted is updated when the hook event is processed during replay.
  (vmGlobalThis as any).AbortController =
    createCreateAbortController(workflowContext);
  const abortSignalStatics = createAbortSignalStatics();
  (vmGlobalThis as any).AbortSignal = {
    abort: abortSignalStatics.abort,
    any: abortSignalStatics.any,
    timeout: abortSignalStatics.timeout,
  };

  // `Request` and `Response` are special built-in classes that invoke steps
  // for the `json()`, `text()` and `arrayBuffer()` instance methods
  class Request implements globalThis.Request {
    cache!: globalThis.Request['cache'];
    credentials!: globalThis.Request['credentials'];
    destination!: globalThis.Request['destination'];
    headers!: Headers;
    integrity!: string;
    method!: string;
    mode!: globalThis.Request['mode'];
    redirect!: globalThis.Request['redirect'];
    referrer!: string;
    referrerPolicy!: globalThis.Request['referrerPolicy'];
    url!: string;
    keepalive!: boolean;
    signal!: AbortSignal;
    duplex!: 'half';
    body!: ReadableStream<any> | null;

    constructor(input: any, init?: RequestInit) {
      // Handle URL input
      if (typeof input === 'string' || input instanceof vmGlobalThis.URL) {
        const urlString = String(input);
        // Validate URL format
        try {
          new vmGlobalThis.URL(urlString);
          this.url = urlString;
        } catch (cause) {
          throw new TypeError(`Failed to parse URL from ${urlString}`, {
            cause,
          });
        }
      } else {
        // Input is a Request object - clone its properties
        this.url = input.url;
        if (!init) {
          this.method = input.method;
          this.headers = new vmGlobalThis.Headers(input.headers);
          this.body = input.body;
          this.mode = input.mode;
          this.credentials = input.credentials;
          this.cache = input.cache;
          this.redirect = input.redirect;
          this.referrer = input.referrer;
          this.referrerPolicy = input.referrerPolicy;
          this.integrity = input.integrity;
          this.keepalive = input.keepalive;
          this.signal = input.signal;
          this.duplex = input.duplex;
          this.destination = input.destination;
          return;
        }
        // If init is provided, merge: use source properties, then override with init
        // Copy all properties from the source Request first
        this.method = input.method;
        this.headers = new vmGlobalThis.Headers(input.headers);
        this.body = input.body;
        this.mode = input.mode;
        this.credentials = input.credentials;
        this.cache = input.cache;
        this.redirect = input.redirect;
        this.referrer = input.referrer;
        this.referrerPolicy = input.referrerPolicy;
        this.integrity = input.integrity;
        this.keepalive = input.keepalive;
        this.signal = input.signal;
        this.duplex = input.duplex;
        this.destination = input.destination;
      }

      // Override with init options if provided
      // Set method
      if (init?.method) {
        this.method = init.method.toUpperCase();
      } else if (typeof this.method !== 'string') {
        // Fallback to default for string input case
        this.method = 'GET';
      }

      // Set headers
      if (init?.headers) {
        this.headers = new vmGlobalThis.Headers(init.headers);
      } else if (
        typeof input === 'string' ||
        input instanceof vmGlobalThis.URL
      ) {
        // For string/URL input, create empty headers
        this.headers = new vmGlobalThis.Headers();
      }

      // Set other properties with init values or defaults
      if (init?.mode !== undefined) {
        this.mode = init.mode;
      } else if (typeof this.mode !== 'string') {
        this.mode = 'cors';
      }

      if (init?.credentials !== undefined) {
        this.credentials = init.credentials;
      } else if (typeof this.credentials !== 'string') {
        this.credentials = 'same-origin';
      }

      // `any` cast here because @types/node v22 does not yet have `cache`
      if ((init as any)?.cache !== undefined) {
        this.cache = (init as any).cache;
      } else if (typeof this.cache !== 'string') {
        this.cache = 'default';
      }

      if (init?.redirect !== undefined) {
        this.redirect = init.redirect;
      } else if (typeof this.redirect !== 'string') {
        this.redirect = 'follow';
      }

      if (init?.referrer !== undefined) {
        this.referrer = init.referrer;
      } else if (typeof this.referrer !== 'string') {
        this.referrer = 'about:client';
      }

      if (init?.referrerPolicy !== undefined) {
        this.referrerPolicy = init.referrerPolicy;
      } else if (typeof this.referrerPolicy !== 'string') {
        this.referrerPolicy = '';
      }

      if (init?.integrity !== undefined) {
        this.integrity = init.integrity;
      } else if (typeof this.integrity !== 'string') {
        this.integrity = '';
      }

      if (init?.keepalive !== undefined) {
        this.keepalive = init.keepalive;
      } else if (typeof this.keepalive !== 'boolean') {
        this.keepalive = false;
      }

      if (init?.signal !== undefined) {
        // @ts-expect-error - AbortSignal stub
        this.signal = init.signal;
      } else if (!this.signal) {
        // @ts-expect-error - AbortSignal stub
        this.signal = { aborted: false };
      }

      if (!this.duplex) {
        this.duplex = 'half';
      }

      if (!this.destination) {
        this.destination = 'document';
      }

      const body = init?.body;

      // Validate that GET/HEAD methods don't have a body
      if (
        body !== null &&
        body !== undefined &&
        (this.method === 'GET' || this.method === 'HEAD')
      ) {
        throw new TypeError(`Request with GET/HEAD method cannot have body.`);
      }

      // Store the original BodyInit for serialization
      if (body !== null && body !== undefined) {
        // Create a "fake" ReadableStream that stores the original body
        // This avoids doing async work during workflow replay
        this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
          [BODY_INIT_SYMBOL]: {
            value: body,
            writable: false,
          },
        });
      } else {
        this.body = null;
      }
    }

    clone(): Request {
      ENOTSUP();
    }

    get bodyUsed() {
      return false;
    }

    // TODO: implement these
    blob!: () => Promise<Blob>;
    formData!: () => Promise<FormData>;

    arrayBuffer!: () => Promise<ArrayBuffer>;
    json!: () => Promise<any>;
    text!: () => Promise<string>;

    async bytes() {
      return new Uint8Array(await this.arrayBuffer());
    }
  }
  vmGlobalThis.Request = Request;

  Object.defineProperties(Request.prototype, {
    arrayBuffer: {
      value: useStep<[], ArrayBuffer>('__builtin_response_array_buffer'),
      writable: true,
      configurable: true,
    },
    json: {
      value: useStep<[], any>('__builtin_response_json'),
      writable: true,
      configurable: true,
    },
    text: {
      value: useStep<[], string>('__builtin_response_text'),
      writable: true,
      configurable: true,
    },
  });

  class Response implements globalThis.Response {
    type!: globalThis.Response['type'];
    url!: string;
    status!: number;
    statusText!: string;
    body!: ReadableStream<Uint8Array> | null;
    headers!: Headers;
    redirected!: boolean;

    constructor(body?: any, init?: ResponseInit) {
      this.status = init?.status ?? 200;
      this.statusText = init?.statusText ?? '';
      this.headers = new vmGlobalThis.Headers(init?.headers);
      this.type = 'default';
      this.url = '';
      this.redirected = false;

      // Validate that null-body status codes don't have a body
      // Per HTTP spec: 204 (No Content), 205 (Reset Content), and 304 (Not Modified)
      if (
        body !== null &&
        body !== undefined &&
        (this.status === 204 || this.status === 205 || this.status === 304)
      ) {
        throw new TypeError(
          `Response constructor: Invalid response status code ${this.status}`
        );
      }

      // Store the original BodyInit for serialization
      if (body !== null && body !== undefined) {
        // Create a "fake" ReadableStream that stores the original body
        // This avoids doing async work during workflow replay
        this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
          [BODY_INIT_SYMBOL]: {
            value: body,
            writable: false,
          },
        });
      } else {
        this.body = null;
      }
    }

    // TODO: implement these
    clone!: () => Response;
    blob!: () => Promise<globalThis.Blob>;
    formData!: () => Promise<globalThis.FormData>;

    get ok() {
      return this.status >= 200 && this.status < 300;
    }

    get bodyUsed() {
      return false;
    }

    arrayBuffer!: () => Promise<ArrayBuffer>;
    json!: () => Promise<any>;
    text!: () => Promise<string>;

    async bytes() {
      return new Uint8Array(await this.arrayBuffer());
    }

    static json(data: any, init?: ResponseInit): Response {
      const body = JSON.stringify(data);
      const headers = new vmGlobalThis.Headers(init?.headers);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return new Response(body, { ...init, headers });
    }

    static error(): Response {
      ENOTSUP();
    }

    static redirect(url: string | URL, status: number = 302): Response {
      // Validate status code - only specific redirect codes are allowed
      if (![301, 302, 303, 307, 308].includes(status)) {
        throw new RangeError(
          `Invalid redirect status code: ${status}. Must be one of: 301, 302, 303, 307, 308`
        );
      }

      // Create response with Location header
      const headers = new vmGlobalThis.Headers();
      headers.set('Location', String(url));

      const response = Object.create(Response.prototype);
      response.status = status;
      response.statusText = '';
      response.headers = headers;
      response.body = null;
      response.type = 'default';
      response.url = '';
      response.redirected = false;

      return response;
    }
  }
  vmGlobalThis.Response = Response;

  Object.defineProperties(Response.prototype, {
    arrayBuffer: {
      value: useStep<[], ArrayBuffer>('__builtin_response_array_buffer'),
      writable: true,
      configurable: true,
    },
    json: {
      value: useStep<[], any>('__builtin_response_json'),
      writable: true,
      configurable: true,
    },
    text: {
      value: useStep<[], string>('__builtin_response_text'),
      writable: true,
      configurable: true,
    },
  });

  class ReadableStream<T> implements globalThis.ReadableStream<T> {
    constructor() {
      ENOTSUP();
    }

    get locked() {
      return false;
    }

    cancel(): any {
      ENOTSUP();
    }

    getReader(): any {
      ENOTSUP();
    }

    pipeThrough(): any {
      ENOTSUP();
    }

    pipeTo(): any {
      ENOTSUP();
    }

    tee(): any {
      ENOTSUP();
    }

    values(): any {
      ENOTSUP();
    }

    static from(): any {
      ENOTSUP();
    }

    [Symbol.asyncIterator](): any {
      ENOTSUP();
    }
  }
  vmGlobalThis.ReadableStream = ReadableStream;

  class WritableStream<T> implements globalThis.WritableStream<T> {
    constructor() {
      ENOTSUP();
    }

    get locked() {
      return false;
    }

    abort(): any {
      ENOTSUP();
    }

    close(): any {
      ENOTSUP();
    }

    getWriter(): any {
      ENOTSUP();
    }
  }
  vmGlobalThis.WritableStream = WritableStream;

  class TransformStream<I, O> implements globalThis.TransformStream<I, O> {
    readable: globalThis.ReadableStream<O>;
    writable: globalThis.WritableStream<I>;

    constructor() {
      ENOTSUP();
    }
  }
  vmGlobalThis.TransformStream = TransformStream;

  vmGlobalThis.console = globalThis.console;

  // Expose the request-context symbol required by AI Gateway.
  const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');
  // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
  vmGlobalThis[SYMBOL_FOR_REQ_CONTEXT] = (globalThis as any)[
    SYMBOL_FOR_REQ_CONTEXT
  ];

  // Get a reference to the user-defined workflow function.
  // The filename parameter ensures stack traces show a meaningful name
  // (e.g., "example/workflows/99_e2e.ts") instead of "evalmachine.<anonymous>".
  const parsedName = parseWorkflowName(workflowRun.workflowName);
  const filename = parsedName?.moduleSpecifier || workflowRun.workflowName;

  // Reuse compiled scripts by `(code, filename)`: compilation is deterministic
  // and the filename preserves workflow source attribution in stack traces.
  // The bundle registers workflows on `globalThis.__private_workflows`.
  runCachedWorkflowScript(workflowCode, filename, context);
  const workflowFn = runCachedWorkflowScript(
    `globalThis.__private_workflows?.get(${JSON.stringify(workflowRun.workflowName)})`,
    filename,
    context
  );

  if (typeof workflowFn !== 'function') {
    throw new WorkflowNotRegisteredError(workflowRun.workflowName);
  }

  // Chain workflow argument hydration onto the promiseQueue so that the
  // unconsumed event check (which waits for the queue to drain) doesn't
  // fire during the async gap between run_started consumption and the
  // workflow function subscribing its first step callbacks.
  let args: unknown[] = [];
  workflowContext.promiseQueue = workflowContext.promiseQueue.then(async () => {
    const prepared = await replayPayloadCache.prepareWorkflowInput(workflowRun);
    args = await hydrateWorkflowArguments(
      workflowRun.input,
      workflowRun.runId,
      encryptionKey,
      vmGlobalThis,
      {},
      prepared
    );
  });
  await workflowContext.promiseQueue;

  // The user function's promise. It may stay pending across many resumes
  // (each parked step promise holds it up) and is raced against the current
  // attempt's interruption in waitForExecution.
  const workflowBody = (async (): Promise<unknown> => {
    return await workflowFn(...args);
  })();

  const failWorkflow = async (error: unknown): Promise<never> => {
    // Control-flow signals are handled by the runtime and do not mean the
    // workflow has terminally failed. `onWorkflowError` usually already moved
    // the state machine, but a divergence can also arrive via a step
    // promise's direct rejection (bypassing `onWorkflowError`); demote so
    // every control-flow path converges on `replay` and a later resume falls
    // back instead of throwing.
    if (WorkflowSuspension.is(error) || ReplayDivergenceError.is(error)) {
      if (state.type === 'running') state = { type: 'replay' };
      throw error;
    }
    state = { type: 'completed' };

    await drainPendingQueueItems(
      workflowRun.runId,
      workflowContext.invocationsQueue,
      vmGlobalThis,
      workflowRun,
      'failed',
      runReadyBarrier
    );

    throw error;
  };

  const waitForExecution = async (
    interruption: PromiseWithResolvers<never>
  ): Promise<WorkflowResult> => {
    let result: unknown;
    try {
      result = await Promise.race([workflowBody, interruption.promise]);
    } catch (error) {
      if (state.type === 'suspended' && error === state.suspension) {
        return {
          type: 'suspended',
          suspension: state.suspension,
          session,
          // A suspension is not a settling point: the consumer for something
          // held may well be registered by the replay that follows this one.
          // So it is carried out for the span instead of being judged here.
          parked: eventsConsumer.parkedSummary,
        };
      }
      return failWorkflow(error);
    }

    state = { type: 'completed' };
    // The consumer walks past events whose type carries no ordering claim and
    // holds them for a consumer it expects a later `subscribe()` to register.
    // The workflow function returning is the point where that expectation is
    // settled: nothing more will subscribe, so anything still held was never
    // anyone's, and completing here would drop it silently.
    const stranded = eventsConsumer.strandedEvent;
    if (stranded) {
      return failWorkflow(
        new ReplayDivergenceError(
          `Replay finished without consuming event: eventType=${stranded.eventType}, correlationId=${stranded.correlationId}, eventId=${stranded.eventId}.`,
          { eventId: stranded.eventId }
        )
      );
    }
    try {
      const output = await dehydrateWorkflowReturnValue(
        result,
        workflowRun.runId,
        encryptionKey,
        vmGlobalThis,
        false,
        // Only compression-capable runs (spec >= 5) may write compressed
        // payloads. The serializer uses zstd when supported and may use gzip.
        (workflowRun.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION
      );

      await drainPendingQueueItems(
        workflowRun.runId,
        workflowContext.invocationsQueue,
        vmGlobalThis,
        workflowRun,
        'completed',
        runReadyBarrier
      );

      return { type: 'completed', output, resultType: typeof result };
    } catch (error) {
      return failWorkflow(error);
    }
  };

  const session: WorkflowSession = {
    workflowRun,
    argumentCount: args.length,
    async resume(nextEvents) {
      switch (state.type) {
        case 'suspended': {
          // The full O(known events) prefix compare is required: the runtime
          // usually grows one array in place, but its wait-completion and
          // stale-reload paths REPLACE the array with a fresh full fetch, so
          // a rewritten prefix is a real input, not paranoia. The compares
          // are cheap string equality and dwarfed by the replay they avoid.
          const knownEvents = eventsConsumer.events;
          const isStrictExtension =
            nextEvents.length > knownEvents.length &&
            knownEvents.every(
              (event, index) => event.eventId === nextEvents[index].eventId
            );
          if (!isStrictExtension) {
            state = { type: 'replay' };
            return { type: 'replay' };
          }
          const interruption = withResolvers<never>();
          state = { type: 'running', interruption };
          workflowContext.suspensionGeneration++;
          eventsConsumer.append(nextEvents.slice(knownEvents.length));
          return waitForExecution(interruption);
        }
        case 'replay':
          return { type: 'replay' };
        case 'completed':
        case 'running':
          throw new WorkflowRuntimeError(
            `Cannot resume ${state.type} workflow "${workflowRun.runId}"`
          );
      }
      state satisfies never;
    },
  };

  return {
    session,
    execution: waitForExecution(initialInterruption),
  };
}
