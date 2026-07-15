import { types } from 'node:util';
import {
  CorruptedEventLogError,
  EntityConflictError,
  FatalError,
  PreconditionFailedError,
  ReplayDivergenceError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { setWorkflowBasePath } from '@workflow/utils';
import {
  parseWorkflowName,
  workflowDisplayName,
} from '@workflow/utils/parse-name';
import {
  type Event,
  getQueueTopicPrefix,
  ROOT_RUN_ID_ATTRIBUTE,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import {
  classifyRunError,
  isRetryableWorldError,
  isWorldContractError,
} from './classify-error.js';
import { describeError } from './describe-error.js';
import { type StepInvocationQueueItem, WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import {
  getMaxQueueDeliveries,
  getReplayDivergenceMaxRetries,
  isInlineOwnershipEnabled,
  isTurboEnabled,
} from './runtime/constants.js';
import {
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  loadWorkflowRunEvents,
  type MutableEventLog,
  memoizeEncryptionKey,
  parseHealthCheckPayload,
  queueMessage,
  stateUpdatedAtForCreate,
  withHealthCheck,
  withPreconditionRetry,
} from './runtime/helpers.js';
import {
  handleReplayBudgetExhausted,
  ReplayBudget,
} from './runtime/replay-budget.js';
import { runIdCreatedAt } from './runtime/run-id-time.js';
import { executeStep } from './runtime/step-executor.js';
import { computeStepLatencyTracking } from './runtime/step-latency.js';
import {
  backstopIdempotencyKey,
  hasPendingStepOwnedByMessage,
  isStepOwnershipActive,
  stepLeaseRemainingSeconds,
} from './runtime/step-ownership.js';
import { runStepSingleFlight } from './runtime/step-single-flight.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { getWaitContinuationDispatch } from './runtime/wait-continuation.js';
import {
  getWorld,
  getWorldHandlers,
  type WorldHandlers,
} from './runtime/world.js';
import { dehydrateRunError } from './serialization.js';
import { remapErrorStack } from './source-map.js';
import {
  createStepHydrationCache,
  type StepHydrationCache,
} from './step-hydration-cache.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import {
  buildInvocationSpanLinks,
  getNextTraceCarrier,
  getSpanKind,
  getWorkflowTraceMode,
  isUsableTraceCarrier,
  trace,
  withTraceContext,
  withWorkflowBaggage,
} from './telemetry.js';
import { getErrorName, getErrorStack, normalizeUnknownError } from './types.js';
import { buildWorkflowSuspensionMessage } from './util.js';
import { runWorkflow } from './workflow.js';

export type { Event, WorkflowRun };
export { WorkflowSuspension } from './global.js';
export {
  type HealthCheckEndpoint,
  type HealthCheckOptions,
  type HealthCheckResult,
  healthCheck,
} from './runtime/helpers.js';
export {
  getHookByToken,
  resumeHook,
  resumeWebhook,
} from './runtime/resume-hook.js';
export {
  getRun,
  Run,
  type WorkflowReadableStream,
  type WorkflowReadableStreamOptions,
} from './runtime/run.js';
export {
  type CancelRunOptions,
  cancelRun,
  listStreams,
  type ReadStreamOptions,
  type RecreateRunOptions,
  type ReenqueueRunOptions,
  readStream,
  recreateRunFromExisting,
  reenqueueRun,
  type StopSleepOptions,
  type StopSleepResult,
  wakeUpRun,
} from './runtime/runs.js';
export {
  type StartOptions,
  type StartOptionsBase,
  type StartOptionsWithDeploymentId,
  type StartOptionsWithoutDeploymentId,
  start,
} from './runtime/start.js';
// V2: stepEntrypoint is no longer re-exported — the combined handler
// (workflowEntrypoint) executes steps inline. Removing the re-export
// prevents Turbopack from tracing step-handler.js → get-port.js
// filesystem operations into the flow route bundle.
export {
  createWorld,
  createWorldFromModule,
  getWorld,
  getWorldHandlers,
  setWorld,
  type WorldFactoryModule,
} from './runtime/world.js';

function getWorkflowSetupErrorCode(err: unknown): RunErrorCode | null {
  if (WorkflowRuntimeError.is(err)) {
    return RUN_ERROR_CODES.RUNTIME_ERROR;
  }

  if (isWorldContractError(err)) {
    return RUN_ERROR_CODES.WORLD_CONTRACT_ERROR;
  }

  return null;
}

async function recordFatalRunError({
  world,
  workflowRun,
  runId,
  requestId,
  err,
  errorCode,
  logMessage,
}: {
  world: World;
  workflowRun: WorkflowRun | undefined;
  runId: string;
  requestId: string | undefined;
  err: unknown;
  errorCode: RunErrorCode;
  logMessage: string;
}) {
  runtimeLogger.error(logMessage, {
    workflowRunId: runId,
    errorCode,
    error: err instanceof Error ? err.message : String(err),
  });

  try {
    const getEncryptionKey = memoizeEncryptionKey(world, workflowRun ?? runId);
    await world.events.create(
      runId,
      {
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          error: await dehydrateRunError(
            err,
            runId,
            await getEncryptionKey(),
            globalThis,
            (workflowRun?.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION
          ),
          errorCode,
        },
      },
      { requestId }
    );
  } catch (failErr) {
    if (EntityConflictError.is(failErr) || RunExpiredError.is(failErr)) {
      return;
    }
    if (isWorldContractError(failErr)) {
      runtimeLogger.error(
        'Fatal world contract error while recording workflow failure',
        {
          workflowRunId: runId,
          errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
          error: failErr instanceof Error ? failErr.message : String(failErr),
        }
      );
      return;
    }
    throw failErr;
  }
}

function hasRecordedTerminalRunEvent(events: Event[], runId: string): boolean {
  // Terminal run events are always last by construction (no event creation
  // succeeds against a terminal run), but scan the full array for
  // defense-in-depth: a World/backend ordering bug shouldn't make us miss an
  // actual termination signal.
  const terminalRunEvent = events.find(
    (e) =>
      e.runId === runId &&
      (e.eventType === 'run_completed' ||
        e.eventType === 'run_failed' ||
        e.eventType === 'run_cancelled')
  );

  if (!terminalRunEvent) {
    return false;
  }

  runtimeLogger.debug('Run reached terminal event, exiting', {
    workflowRunId: runId,
    eventType: terminalRunEvent.eventType,
    eventId: terminalRunEvent.eventId,
  });
  return true;
}

/**
 * The lineage root of a loaded run: its `$rootRunId` attribute, or its own id
 * when it is itself a root.
 */
function rootRunIdFrom(
  attributes: Record<string, string> | undefined,
  runId: string
): string {
  return attributes?.[ROOT_RUN_ID_ATTRIBUTE] ?? runId;
}

/**
 * Whether the run has any hook or wait that an out-of-band writer could
 * append an event for between an inline step's `step_completed` write and
 * the next replay — namely an open hook (a `hook_created` not yet
 * `hook_disposed`, which a webhook receiver can resolve with
 * `hook_received`) or an open wait (a `wait_created` not yet
 * `wait_completed`, which the wait timer can resolve with
 * `wait_completed`).
 *
 * This gates the inline-delta fast path. The delta returned by the
 * step-terminal write is the event log as of that write; it is consumed
 * on the NEXT loop iteration, so any event a concurrent writer appends in
 * that window would be present in a real `events.list` fetch but absent
 * from the stale delta. Missing such an event for one replay can durably
 * commit a scheduling decision (e.g. inline-executing the loser of a
 * `Promise.race([hook, step])`) that the eventual full replay cannot
 * consume — a `ReplayDivergenceError`. When no hook or wait is open, the
 * only out-of-band writer is cancellation, which is benign to observe one
 * iteration late (the next entity write is rejected against the terminal
 * run and the run is already terminal), so the fast path is safe.
 *
 * Step-body `attr_set` writes are NOT a concern: they land before the
 * step's terminal write and are therefore already inside the returned
 * delta.
 */
function hasOpenHookOrWait(events: Event[]): boolean {
  const disposedHookIds = new Set<string | undefined>();
  const completedWaitIds = new Set<string | undefined>();
  for (const e of events) {
    if (e.eventType === 'hook_disposed') disposedHookIds.add(e.correlationId);
    else if (e.eventType === 'wait_completed') {
      completedWaitIds.add(e.correlationId);
    }
  }
  for (const e of events) {
    if (
      e.eventType === 'hook_created' &&
      !disposedHookIds.has(e.correlationId)
    ) {
      return true;
    }
    if (
      e.eventType === 'wait_created' &&
      !completedWaitIds.has(e.correlationId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Creates a single route which handles workflow execution requests,
 * executing steps inline when possible to reduce function invocations
 * and queue overhead.
 *
 * The handler loops: replay workflow → execute step inline → replay → ...
 * until the workflow completes, times out, or encounters non-step suspensions.
 *
 * @param workflowCode - The workflow bundle code containing all workflow functions
 * @returns A function that can be used as a Vercel API route
 */
export function workflowEntrypoint(
  workflowCode: string,
  options?: {
    namespace?: string;
    routeModuleBodyStartedAt?: number;
    basePath?: string;
  }
): (req: Request) => Promise<Response> {
  setWorkflowBasePath(options?.basePath);

  const NO_INLINE_REPLAY_AFTER_MS =
    Number(process.env.WORKFLOW_V2_TIMEOUT_MS) || 120_000;

  const namespace = resolveQueueNamespace(options?.namespace);
  const workflowPrefix = getQueueTopicPrefix('workflow', namespace);

  const handler = (worldHandlers: WorldHandlers) =>
    worldHandlers.createQueueHandler(
      workflowPrefix,
      async (message_, metadata) => {
        // Check if this is a health check message
        // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
        // They only write a simple status response to a stream and do not expose sensitive data.
        // The stream name includes a unique correlationId that must be known by the caller.
        const healthCheck = parseHealthCheckPayload(message_);
        if (healthCheck) {
          await handleHealthCheckMessage(
            healthCheck,
            'workflow',
            worldHandlers.specVersion
          );
          return;
        }

        const {
          runId,
          traceCarrier: incomingTraceCarrier,
          requestedAt,
          stepId: incomingStepId,
          stepName: incomingStepName,
          replayDivergence,
          runInput,
        } = WorkflowInvokePayloadSchema.parse(message_);
        // `start()` always attaches a trace carrier, but
        // serializeTraceCarrier() returns `{}` when no OTEL SDK is registered
        // or no span is active — treat an empty carrier the same as an
        // absent one so linked mode falls back to a fresh origin instead of
        // forwarding a useless `{}` forever.
        const traceContext = isUsableTraceCarrier(incomingTraceCarrier)
          ? incomingTraceCarrier
          : undefined;
        const { requestId } = metadata;
        const workflowName = metadata.queueName.slice(workflowPrefix.length);

        // --- Max delivery check ---
        // Enforce max delivery limit before any infrastructure calls.
        // This prevents runaway workflows from consuming infinite queue deliveries.
        // Scoped logger for this run — attaches runId/workflowName to every
        // log line and child loggers below, so callers don't repeat it.
        const runLogger = runtimeLogger.forRun(runId, workflowName);

        const maxQueueDeliveries = getMaxQueueDeliveries();
        if (metadata.attempt > maxQueueDeliveries) {
          const maxDeliveriesDescription = describeError(
            undefined,
            RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED
          );
          runLogger.error(
            `Workflow handler exceeded max deliveries (${metadata.attempt}/${maxQueueDeliveries})`,
            {
              attempt: metadata.attempt,
              errorCode: maxDeliveriesDescription.errorCode,
              errorAttribution: maxDeliveriesDescription.attribution,
            }
          );
          try {
            const world = await getWorld();
            const getEncryptionKey = memoizeEncryptionKey(world, runId);
            const err = new FatalError(
              `Workflow exceeded maximum queue deliveries (${metadata.attempt}/${maxQueueDeliveries})`
            );
            await world.events.create(
              runId,
              {
                eventType: 'run_failed',
                specVersion: SPEC_VERSION_CURRENT,
                eventData: {
                  error: await dehydrateRunError(
                    err,
                    runId,
                    await getEncryptionKey()
                  ),
                  errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
                },
              },
              { requestId }
            );
          } catch (err) {
            if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
              // Run already finished, consume the message silently
              return;
            }
            runLogger.error(
              `Failed to mark run as failed after ${metadata.attempt} delivery attempts. ` +
                `A persistent error is preventing the run from being terminated. ` +
                `The run will remain in its current state until manually resolved. ` +
                `This is most likely due to a persistent outage of the workflow backend ` +
                `or a bug in the workflow runtime and should be reported to the Workflow team.`,
              {
                attempt: metadata.attempt,
                errorName: err instanceof Error ? err.name : 'UnknownError',
                errorMessage: err instanceof Error ? err.message : String(err),
                errorStack: err instanceof Error ? err.stack : undefined,
              }
            );
          }
          return;
        }

        // --- Trace correlation mode ---
        // 'linked' (default): the workflow.execute span below stays a CHILD
        // of the local delivery (flow-route) context, so one invocation —
        // route handler, workflow replay, inline steps, event writes — is a
        // single bounded trace. The run-origin context travels as a span
        // LINK (not a parent), and re-enqueues forward the original carrier
        // unchanged, so a (potentially hours-long) run is never stitched
        // into one giant trace across invocations.
        // 'continuous': legacy behavior — the restored run-origin context
        // becomes the parent of this invocation's spans.
        const traceMode = getWorkflowTraceMode();

        // Trace carrier to attach to messages this invocation enqueues —
        // see getNextTraceCarrier for the linked/continuous semantics.
        const nextTraceCarrier = (): Promise<Record<string, string>> =>
          getNextTraceCarrier(traceMode, traceContext);

        // Span links to the incoming delivery context and (in linked mode)
        // the run-origin context from the trace carrier.
        const spanLinks = await buildInvocationSpanLinks(
          traceMode,
          traceContext
        );

        // --- Replay budget bookkeeping ---
        // The replay budget bounds the *non-step* portion of a single
        // handler invocation: deterministic event-log replay, workflow-VM
        // execution between step boundaries, suspension handling, queue
        // round-trips, etc. Inline step bodies (`"use step"` functions
        // invoked via `executeStep`) are intentionally excluded — they are
        // bounded by the platform's function `maxDuration` and the
        // `NO_INLINE_REPLAY_AFTER_MS` early-return guard below.
        //
        // The budget is checked at loop boundaries (top of each `while`
        // iteration). Note this is *less responsive* than the old
        // `setTimeout`-based approach: a single pathological `runWorkflow`
        // call processing a huge event log can overshoot the budget by up
        // to one iteration before bailing. In practice the headroom built
        // into `MAX_REPLAY_TIMEOUT_MS` (and the platform `maxDuration`
        // SIGTERM as ultimate backstop) gives us slack — the previous
        // `setTimeout` approach also relied on the platform kill as the
        // hard backstop. Do *not* "fix" this by adding a `setInterval`;
        // it would risk the same bug we just removed (bounding step
        // bodies).
        //
        // Earlier versions (pre-#2009 fix) used a single `setTimeout`
        // that also bounded step bodies, which broke any workflow with a
        // single step longer than the budget.
        const replayBudget = new ReplayBudget();

        // In linked mode the run-origin context is NOT restored as the
        // active (parent) context — passing `undefined` makes
        // withTraceContext a passthrough, so the workflow.execute span below
        // stays a child of the local delivery (flow-route) context and the
        // run-origin travels as a span link instead.
        const parentTraceCarrier =
          traceMode === 'continuous' ? traceContext : undefined;
        // Queue-delivered invocation: CONSUMER kind, matching the
        // queue-delivered step.execute span.
        const spanKind = await getSpanKind('CONSUMER');
        return await withTraceContext(parentTraceCarrier, async () => {
          return await withWorkflowBaggage(
            { workflowRunId: runId, workflowName },
            async () => {
              const world = await trace('workflow.route.get_world', async () =>
                getWorld()
              );
              return trace(
                `workflow.execute ${workflowDisplayName(workflowName)}`,
                { kind: spanKind, links: spanLinks },
                async (span) => {
                  span?.setAttributes({
                    ...Attribute.WorkflowName(workflowName),
                    ...Attribute.WorkflowOperation('execute_v2'),
                    ...Attribute.MessagingSystem('vercel-queue'),
                    ...Attribute.MessagingDestinationName(metadata.queueName),
                    ...Attribute.MessagingMessageId(metadata.messageId),
                    ...Attribute.MessagingOperationType('process'),
                    ...getQueueOverhead({ requestedAt }),
                    ...Attribute.WorkflowRunId(runId),
                    ...Attribute.WorkflowTracePropagated(!!traceContext),
                    ...Attribute.WorkflowTraceMode(traceMode),
                  });

                  const invocationStartTime = Date.now();
                  let loopIteration = 0;

                  // Event cache: keep loaded events in memory across loop iterations.
                  // On the first iteration we do a full load; on subsequent iterations
                  // we fetch only events created after the last known cursor.
                  let cachedEvents: Event[] | null = null;
                  let eventsCursor: string | null = null;

                  // Per-run cache of hydrated step return values, shared across
                  // every replay iteration of THIS invocation. Each iteration
                  // builds a fresh workflow context, so the cache is owned here
                  // (outside that context) and threaded into runWorkflow. It
                  // turns the otherwise O(N²) re-decrypt + re-parse of completed
                  // step results across N replays into O(N). Scoped to this run
                  // only — never reused across runs. See step-hydration-cache.ts.
                  const stepHydrationCache: StepHydrationCache =
                    createStepHydrationCache();

                  // Inline-delta optimization: when an inline step's terminal
                  // write returns the event-log delta since the pre-write
                  // cursor (a supporting World only), we stash it here so the
                  // next loop iteration consumes it in place of the incremental
                  // events.list round-trip. Each value is consumed exactly once
                  // and then cleared. Null means "no delta pending — fetch
                  // normally". See the consume site at the top of the loop and
                  // the produce site after inline executeStep.
                  let pendingInlineDelta: {
                    events: Event[];
                    cursor: string | null;
                  } | null = null;

                  // Shared state: set by either the background step path
                  // or the run_started setup below.
                  let workflowRun: WorkflowRun | undefined;
                  let workflowStartedAt = -1;
                  let preloadedEvents: Event[] | undefined;
                  let preloadedEventsCursor: string | null | undefined;

                  // Latency telemetry (TTFS) state — see runtime/step-latency.ts.
                  // Whether this invocation's FIRST event snapshot contained
                  // nothing beyond run_created/run_started: anything else was
                  // written by an earlier invocation, whose contribution to
                  // time-to-first-step (including the queue hop back here)
                  // cannot be measured wall-clock, so TTFS is not reported.
                  // Set once, on the first iteration's loaded snapshot.
                  let invocationStartedClean: boolean | undefined;
                  // Wall-clock ms spent committing hook_created events before
                  // the first step ran, accumulated across suspension passes
                  // and subtracted from TTFS.
                  let preStepBlockingMs = 0;
                  // Snapshot of the accumulator as of the suspension that
                  // wrote the run's first attr_set (whose hook phase ran
                  // before its attr writes). When a pre-step setAttributes
                  // ends the TTFS measurement at the attr write, only hook
                  // time from BEFORE that point may be subtracted — later
                  // hook writes fall outside the measured window.
                  let preStepBlockingBeforeAttrMs: number | undefined;

                  // Turbo mode fast-paths the very first delivery of the very
                  // first invocation, where it is provably safe to: background
                  // `run_started`, skip the initial event-log load (nothing has
                  // been written yet), and force optimistic inline start (no
                  // concurrent peer handler exists to race the create-claim).
                  // `runInput` is only present on the start()-enqueued message,
                  // and `attempt === 1` (1-based) means this is the first
                  // delivery; `incomingStepId` would mark a background-step
                  // invocation and `replayDivergence` a recovery replay — both
                  // ineligible. The single-handler guarantee that makes forced
                  // optimistic start safe ends once a hook or wait is created
                  // (they introduce resume invocations), so turbo exits at that
                  // point (see `forceOptimisticStart`). Workflow attribute
                  // writes introduce no such invocation source — they resolve
                  // via an in-process replay and don't end turbo.
                  // NOTE: `metadata.attempt === 1` is also load-bearing for
                  // inline step ownership: owned-recovery steps (a step
                  // stamped by a PREVIOUS delivery of this message) can only
                  // exist on attempt ≥ 2, so turbo and owned recovery are
                  // mutually exclusive. The turbo `reinvoke()` paths (hook
                  // conflict, throttle backoff) ack this message and continue
                  // under a NEW message id — safe only because no
                  // non-terminal step can be inline-owned by the acked id
                  // when turbo is on. If turbo ever engages on redeliveries,
                  // those paths must first check for owned pending steps and
                  // fall back to `{ timeoutSeconds }` redelivery.
                  const turbo =
                    isTurboEnabled() &&
                    runInput !== undefined &&
                    metadata.attempt === 1 &&
                    incomingStepId === undefined &&
                    !replayDivergence;
                  span?.setAttributes(Attribute.WorkflowTurbo(turbo));

                  // Turbo mode only: resolves once the backgrounded
                  // `run_started` has landed (or rejects if it failed). Threaded
                  // into handleSuspension and executeStep so no step/hook/wait
                  // write races ahead of the run's creation. Undefined outside
                  // turbo, where `run_started` is awaited up front.
                  let runReadyBarrier: Promise<unknown> | undefined;

                  // Order a terminal run write (run_completed / run_failed) after
                  // the backgrounded run_started in turbo mode — a no-step
                  // workflow can otherwise reach run_completed before the run
                  // exists. Best-effort: a barrier rejection is swallowed for
                  // ordering only; if run_started truly failed the terminal write
                  // surfaces the real error (run not found / gone) and the message
                  // redelivers. No-op outside turbo.
                  const awaitRunReady = async (): Promise<void> => {
                    if (runReadyBarrier) {
                      try {
                        await runReadyBarrier;
                      } catch {
                        // intentional: ordering barrier only — see above.
                      }
                    }
                  };

                  // Re-invoke the orchestrator. Outside turbo this returns
                  // `{ timeoutSeconds }`, which makes the queue reschedule the
                  // CURRENT delivery's message. In turbo that is a trap: the
                  // current message carries `runInput`, and on async queues
                  // (e.g. graphile-worker) a reschedule comes back as delivery
                  // attempt 1 — so turbo re-engages, skips the event-log load
                  // again, replays against an empty log, never observes the
                  // hook event this invocation just wrote, and re-suspends
                  // forever (the run wedges). Under turbo we instead enqueue an
                  // explicit continuation that carries NO `runInput`, so the
                  // next delivery is a normal (non-turbo) load-and-replay that
                  // observes the committed events and makes progress; we then
                  // return `undefined` so the queue treats this delivery as done
                  // rather than also rescheduling it.
                  // Inline-ownership invariant guard: correlation IDs of
                  // steps whose bodies this invocation is executing under an
                  // ownership stamp (lazy inline + owned recovery), while the
                  // body is in flight. Crash recovery depends on the owning
                  // message NOT being acked while such a step is non-terminal
                  // (ack = handler return or reinvoke, which acks + enqueues
                  // under a NEW message id — the redelivery of the old id is
                  // what re-executes an orphaned owned step). All executeStep
                  // calls are awaited before any ack path runs, so this set
                  // is empty at every ack by construction; the check exists
                  // to catch future refactors that break that ordering.
                  const inFlightOwnedSteps = new Set<string>();
                  const assertNoInFlightOwnedSteps = (
                    ackPath: string
                  ): void => {
                    if (inFlightOwnedSteps.size > 0) {
                      runtimeLogger.error(
                        'Invariant violation: acking the workflow message while owned inline steps are still executing — crash recovery for these steps is broken',
                        {
                          workflowRunId: runId,
                          ackPath,
                          stepIds: [...inFlightOwnedSteps],
                        }
                      );
                    }
                  };

                  const reinvoke = async (
                    delaySeconds: number
                  ): Promise<{ timeoutSeconds: number } | undefined> => {
                    assertNoInFlightOwnedSteps('reinvoke');
                    if (!turbo) return { timeoutSeconds: delaySeconds };
                    await queueMessage(
                      world,
                      getWorkflowQueueName(workflowName, namespace),
                      {
                        runId,
                        traceCarrier: await nextTraceCarrier(),
                        requestedAt: new Date(),
                      },
                      delaySeconds > 0 ? { delaySeconds } : undefined
                    );
                    return undefined;
                  };

                  // If incoming message has a stepId, this is a background step
                  // execution. Execute the step, then check if all parallel steps
                  // from the batch are done. If so, replay inline (saving a queue
                  // roundtrip). If not, return — the last handler to complete
                  // will pick up the replay.
                  if (incomingStepId && incomingStepName) {
                    try {
                      const bgRun = await world.runs.get(runId);
                      if (bgRun.status !== 'running') {
                        runtimeLogger.debug(
                          'Run already finished, skipping background step',
                          { workflowRunId: runId, status: bgRun.status }
                        );
                        return;
                      }
                      const bgStartedAt = bgRun.startedAt
                        ? +bgRun.startedAt
                        : Date.now();
                      // Pause the replay budget while the step body runs —
                      // step duration is bounded by the platform's function
                      // maxDuration, not by the replay timeout. See the
                      // ReplayBudget docs for the contract.
                      replayBudget.pause();
                      let stepResult: Awaited<ReturnType<typeof executeStep>>;
                      try {
                        // Single-flight: a delayed backstop (or retry) message
                        // can arrive while another execution of this same step
                        // is mid-body in this process — most importantly on
                        // worlds with no invocation kill bound (world-local),
                        // where the ownership lease is not a death proof. The
                        // loser awaits the winner's settlement, then acks
                        // without executing. No ownerMessageId here: the bare
                        // step_started of a queue-driven execution
                        // intentionally clears inline ownership (the step is
                        // queue-owned from this point).
                        stepResult = await runStepSingleFlight(
                          runId,
                          incomingStepId,
                          () =>
                            executeStep({
                              world,
                              workflowRunId: runId,
                              workflowDeploymentId: bgRun.deploymentId,
                              workflowName,
                              workflowStartedAt: bgStartedAt,
                              rootRunId: rootRunIdFrom(bgRun.attributes, runId),
                              stepId: incomingStepId,
                              stepName: incomingStepName,
                              runSpecVersion: bgRun.specVersion,
                            })
                        );
                      } finally {
                        replayBudget.resume();
                      }
                      if (stepResult.type === 'retry') {
                        return { timeoutSeconds: stepResult.timeoutSeconds };
                      }
                      if (stepResult.type === 'throttled') {
                        return { timeoutSeconds: stepResult.timeoutSeconds };
                      }

                      // If step had pending ops (stream writes), break and let
                      // waitUntil flush them — can't continue inline.
                      if (
                        stepResult.type === 'completed' &&
                        stepResult.hasPendingOps
                      ) {
                        await queueMessage(
                          world,
                          getWorkflowQueueName(workflowName, namespace),
                          {
                            runId,
                            traceCarrier: await nextTraceCarrier(),
                            requestedAt: new Date(),
                          }
                        );
                        return;
                      }

                      if (
                        stepResult.type === 'completed' ||
                        stepResult.type === 'failed' ||
                        stepResult.type === 'skipped'
                      ) {
                        // Load events to check if all parallel steps are done.
                        // Use cursor-based loading so the main loop can continue
                        // incrementally from here.
                        const loaded = await loadWorkflowRunEvents(runId);
                        cachedEvents = loaded.events;
                        eventsCursor = loaded.cursor;

                        // Check for pending steps: any step_created without
                        // a matching step_completed or step_failed.
                        const stepCreatedIds = new Set<string | undefined>();
                        const stepTerminalIds = new Set<string | undefined>();
                        for (const e of cachedEvents) {
                          if (e.eventType === 'step_created') {
                            stepCreatedIds.add(e.correlationId);
                          } else if (
                            e.eventType === 'step_completed' ||
                            e.eventType === 'step_failed'
                          ) {
                            stepTerminalIds.add(e.correlationId);
                          }
                        }
                        const pendingStepIds = new Set<string | undefined>();
                        for (const id of stepCreatedIds) {
                          if (!stepTerminalIds.has(id)) {
                            pendingStepIds.add(id);
                          }
                        }

                        if (pendingStepIds.size > 0) {
                          // A pending step that THIS message inline-owns (a
                          // previous delivery of this message stamped its
                          // step_started and then crashed mid-body) must be
                          // recovered here: only the owning message may
                          // re-execute it before the ownership lease expires,
                          // and wake replays merely ensure a delayed
                          // backstop. Fall through to the main loop, whose
                          // dispatch table routes it to owned recovery.
                          if (
                            isInlineOwnershipEnabled() &&
                            hasPendingStepOwnedByMessage(
                              cachedEvents,
                              pendingStepIds,
                              metadata.messageId
                            )
                          ) {
                            runtimeLogger.debug(
                              'Background step done; falling through to recover an inline step owned by this message',
                              { workflowRunId: runId }
                            );
                          } else {
                            // Other steps still in progress. Return without
                            // queuing — the last handler to complete will see
                            // all steps done and replay inline.
                            runtimeLogger.debug(
                              'Background step done but other steps pending, returning',
                              { workflowRunId: runId }
                            );
                            return;
                          }
                        }

                        // All steps done — fall through to the main replay loop.
                        // Set up shared state so the loop can continue.
                        runtimeLogger.debug(
                          'All parallel steps done, replaying inline after background step',
                          { workflowRunId: runId }
                        );
                        workflowRun = bgRun;
                        workflowStartedAt = bgStartedAt;
                        // cachedEvents and eventsCursor already set from load above
                      } else {
                        return;
                      }
                    } catch (err) {
                      const errorCode = getWorkflowSetupErrorCode(err);
                      if (!errorCode) {
                        throw err;
                      }
                      await recordFatalRunError({
                        world,
                        workflowRun,
                        runId,
                        requestId,
                        err,
                        errorCode,
                        logMessage:
                          'Fatal error while preparing background workflow step',
                      });
                      return;
                    }
                  }

                  // --- Infrastructure: prepare the run state ---
                  // Skip if workflowRun was already set by the background
                  // step path (inline replay after all parallel steps done).
                  if (!workflowRun) {
                    // Always call run_started directly — this both transitions
                    // the run to 'running' AND returns the run entity, saving
                    // a separate runs.get round-trip.
                    // Contract: events.create('run_started') must be idempotent
                    // for runs already in 'running' status (return the run
                    // without error), not just for pending → running transitions.
                    const runStartedEvent = {
                      eventType: 'run_started' as const,
                      // Use the spec version from the original start() call
                      // when available, so the resilient start path creates
                      // the run with the correct version (not always current).
                      specVersion:
                        runInput?.specVersion ?? SPEC_VERSION_CURRENT,
                      // Pass run input from queue so the server can
                      // create the run if run_created was missed.
                      // Uint8Array values survive the queue natively
                      // (CBOR on world-vercel, JSON reviver on world-local).
                      ...(runInput
                        ? {
                            eventData: {
                              input: runInput.input,
                              deploymentId: runInput.deploymentId,
                              workflowName: runInput.workflowName,
                              executionContext: runInput.executionContext,
                              attributes: runInput.attributes,
                              allowReservedAttributes:
                                runInput.allowReservedAttributes,
                            },
                          }
                        : {}),
                    };
                    const recordRunStartedCreateStart = (
                      skipPreload: boolean
                    ) => {
                      span?.addEvent('workflow.run_started.create.start', {
                        'workflow.run_started.skip_preload': skipPreload,
                      });
                    };

                    if (turbo && runInput) {
                      // Turbo: background `run_started` and synthesize the run
                      // entity locally so replay can begin without waiting for
                      // the round-trip. Safe here because this is the first
                      // delivery of the first invocation — start() created the
                      // run moments ago and no events have been written yet. The
                      // barrier is consumed by every downstream write (suspension
                      // handler, optimistic step_started, terminal run writes) so
                      // nothing is written before the run exists.
                      recordRunStartedCreateStart(true);
                      const startedPromise = world.events.create(
                        runId,
                        runStartedEvent,
                        // We background this purely as a write barrier and
                        // never read its preloaded events (preloadedEvents is
                        // forced to [] below), so tell the World to skip the
                        // run_started event-log preload. That trims the
                        // run_started request the chained first step_started
                        // waits on — shortening time-to-second-step — and the
                        // wasted list+resolve it would otherwise compute.
                        { requestId, skipPreload: true }
                      );
                      runReadyBarrier = startedPromise;
                      // Attach a no-op rejection handler so an early failure
                      // never surfaces as an unhandledRejection before a consumer
                      // (await/then) is attached; consumers still observe it.
                      startedPromise.catch(() => {});
                      // Skip the initial events.list: nothing has been written to
                      // the log yet on a first delivery (run_started is still in
                      // flight). An empty preloaded set routes iteration 1 through
                      // the no-load preloaded branch; iteration 2 then takes the
                      // existing post-preloaded full reload to pick up a cursor
                      // (no spurious "cursor missing" warning). `[]` is
                      // intentionally truthy here — do not change the load
                      // branches' `if (preloadedEvents)` checks to test length.
                      preloadedEvents = [];
                      const now = new Date();
                      workflowRun = {
                        runId,
                        status: 'running',
                        deploymentId: runInput.deploymentId,
                        workflowName: runInput.workflowName,
                        specVersion: runInput.specVersion,
                        executionContext: runInput.executionContext,
                        input: runInput.input,
                        // Seed attributes from start() ride along in `runInput`
                        // (they live in `run_created`'s eventData, not separate
                        // `attr_set` events), so the synthesized snapshot carries
                        // them even though we skip the initial events.list. This
                        // is correct ONLY while attributes are write-only:
                        // there is no in-workflow read API today (see workflow.ts
                        // "structural until a read API is introduced"), so the
                        // empty preloaded log can't diverge on a read. If a read
                        // API is ever added it MUST read from this snapshot, not
                        // by replaying run_created/attr_set events — otherwise
                        // turbo's empty initial log would surface seed attributes
                        // as `{}` on the first delivery only.
                        attributes: runInput.attributes ?? {},
                        startedAt: now,
                        createdAt: now,
                        updatedAt: now,
                      };
                      workflowStartedAt = +now;
                      span?.setAttributes({
                        ...Attribute.WorkflowRunStatus('running'),
                        ...Attribute.WorkflowStartedAt(workflowStartedAt),
                      });
                    } else {
                      try {
                        recordRunStartedCreateStart(false);
                        const result = await world.events.create(
                          runId,
                          runStartedEvent,
                          { requestId }
                        );
                        if (!result.run) {
                          throw new WorkflowRuntimeError(
                            `Event creation for 'run_started' did not return the run entity for run "${runId}"`
                          );
                        }
                        workflowRun = result.run;

                        // If the response includes events, use them to skip
                        // the initial events.list call and reduce TTFB.
                        if (
                          result.events &&
                          result.events.length > 0 &&
                          result.hasMore !== true
                        ) {
                          preloadedEvents = result.events;
                          preloadedEventsCursor = result.cursor;
                        }

                        if (!workflowRun.startedAt) {
                          throw new WorkflowRuntimeError(
                            `Workflow run "${runId}" has no "startedAt" timestamp`
                          );
                        }
                      } catch (err) {
                        // Run was concurrently completed/failed/cancelled
                        if (
                          EntityConflictError.is(err) ||
                          RunExpiredError.is(err)
                        ) {
                          // EntityConflictError: run was concurrently
                          // completed/failed/cancelled during setup.
                          // RunExpiredError: run already in terminal state.
                          // In both cases, skip processing this message.
                          runtimeLogger.info(
                            'Run already finished during setup, skipping',
                            { workflowRunId: runId, message: err.message }
                          );
                          return;
                        } else {
                          const errorCode = getWorkflowSetupErrorCode(err);
                          if (!errorCode) {
                            throw err;
                          }
                          await recordFatalRunError({
                            world,
                            workflowRun,
                            runId,
                            requestId,
                            err,
                            errorCode,
                            logMessage:
                              'Fatal runtime error during workflow setup',
                          });
                          return;
                        }
                      }

                      workflowStartedAt = +workflowRun.startedAt;

                      span?.setAttributes({
                        ...Attribute.WorkflowRunStatus(workflowRun.status),
                        ...Attribute.WorkflowStartedAt(workflowStartedAt),
                      });

                      if (workflowRun.status !== 'running') {
                        // Workflow has already completed or failed, so we can skip it
                        runtimeLogger.info(
                          'Workflow already completed or failed, skipping',
                          {
                            workflowRunId: runId,
                            status: workflowRun.status,
                          }
                        );

                        // TODO: for `cancel`, we actually want to propagate a WorkflowCancelled event
                        // inside the workflow context so the user can gracefully exit. this is SIGTERM
                        // TODO: furthermore, there should be a timeout or a way to force cancel SIGKILL
                        // so that we actually exit here without replaying the workflow at all, in the case
                        // the replaying the workflow is itself failing.

                        return;
                      }
                    } // end else (non-turbo run_started)
                  } // end if (!workflowRun)

                  // Resolve the encryption key for this run's deployment.
                  // Used eagerly here since both runWorkflow (input
                  // hydration / hook payload decryption) and the run_failed
                  // dehydrate path below need it. Memoized accessor: first
                  // call triggers the actual fetch / HKDF derivation,
                  // subsequent calls await the cached promise.
                  const getEncryptionKey = memoizeEncryptionKey(
                    world,
                    workflowRun
                  );
                  const encryptionKey = await getEncryptionKey();

                  // Main replay loop
                  // biome-ignore lint/correctness/noConstantCondition: intentional loop
                  while (true) {
                    loopIteration++;

                    // Replay-budget check: bail out (retry or fail) if
                    // non-step time within this invocation has exceeded
                    // the configured budget. Step bodies are excluded
                    // because replayBudget.pause()/resume() bracket every
                    // `executeStep` call.
                    if (replayBudget.isExhausted()) {
                      await handleReplayBudgetExhausted({
                        runId,
                        workflowName,
                        requestId,
                        attempt: metadata.attempt,
                        limitMs: replayBudget.configuredLimitMs,
                      });
                      // On Vercel, handleReplayBudgetExhausted always
                      // exits the process. On local dev it returns; we
                      // fall through and the request ends normally
                      // (run_failed has been written best-effort).
                      return;
                    }

                    // Check timeout before replay
                    if (
                      Date.now() - invocationStartTime >=
                      NO_INLINE_REPLAY_AFTER_MS
                    ) {
                      runtimeLogger.info(
                        'V2 timeout reached, re-scheduling workflow',
                        {
                          workflowRunId: runId,
                          loopIteration,
                          elapsedMs: Date.now() - invocationStartTime,
                        }
                      );
                      await queueMessage(
                        world,
                        getWorkflowQueueName(workflowName, namespace),
                        {
                          runId,
                          traceCarrier: await nextTraceCarrier(),
                          requestedAt: new Date(),
                        }
                      );
                      return;
                    }

                    let replayStart = 0;
                    // Cursor of this iteration's event log before any inline
                    // writes advance it — declared at try scope so the
                    // suspension catch (which runs the inline step) can read it
                    // as the `sinceCursor` for the inline-delta optimization.
                    let preInlineWriteCursor: string | null = null;
                    try {
                      // Load events — use cached events with incremental fetch on subsequent iterations.
                      // The server always returns a cursor when there are events (even on the
                      // final page), so we can reliably use it for incremental loading.
                      let events: Event[];
                      if (pendingInlineDelta && cachedEvents) {
                        // Fast path: the previous iteration's inline step
                        // terminal write returned the authoritative event-log
                        // delta since the pre-write cursor, so we consume it
                        // here instead of issuing an incremental events.list.
                        // The delta is byte-for-byte what events.list(cursor)
                        // would have returned at write time — it includes this
                        // handler's own step events, any attr_set the step body
                        // wrote, and any in-band events (e.g. hook_received,
                        // wait_completed) another writer appended since the
                        // cursor — so skipping the fetch cannot drop events or
                        // skew the prefix from the server's log.
                        const delta = pendingInlineDelta;
                        pendingInlineDelta = null;
                        if (delta.events.length > 0) {
                          const existingIds = new Set(
                            cachedEvents.map((e) => e.eventId)
                          );
                          for (const e of delta.events) {
                            if (!existingIds.has(e.eventId)) {
                              existingIds.add(e.eventId);
                              cachedEvents.push(e);
                            }
                          }
                        }
                        eventsCursor = delta.cursor ?? eventsCursor;
                        events = cachedEvents;
                      } else if (cachedEvents === null) {
                        // First iteration: use preloaded events if available,
                        // otherwise do a full load with cursor.
                        if (preloadedEvents) {
                          events = preloadedEvents;
                          eventsCursor = preloadedEventsCursor ?? null;
                        } else {
                          const loaded = await loadWorkflowRunEvents(runId);
                          events = loaded.events;
                          eventsCursor = loaded.cursor;
                        }
                      } else if (eventsCursor) {
                        // Subsequent iteration: fetch only new events since last cursor
                        const loaded = await loadWorkflowRunEvents(
                          runId,
                          eventsCursor
                        );
                        // Dedupe by eventId: a previous iteration may have
                        // appended a refreshed wait-completion delta before
                        // the next loop observes the advanced cursor, so an
                        // incremental fetch can return events we already have
                        // locally.
                        if (loaded.events.length > 0) {
                          const existingIds = new Set(
                            cachedEvents.map((e) => e.eventId)
                          );
                          for (const e of loaded.events) {
                            if (!existingIds.has(e.eventId)) {
                              existingIds.add(e.eventId);
                              cachedEvents.push(e);
                            }
                          }
                        }
                        eventsCursor = loaded.cursor ?? eventsCursor;
                        events = cachedEvents;
                      } else if (preloadedEvents) {
                        // Iteration 2 after iteration 1 used preloaded events
                        // (which don't carry a cursor). Do a full load now to
                        // pick up any events written since the preloaded set
                        // and obtain a cursor for subsequent incremental
                        // loads. This is the expected path, not a bug.
                        runtimeLogger.debug(
                          'No cursor after preloaded-events first iteration; doing full reload to pick up cursor.',
                          { workflowRunId: runId }
                        );
                        const loaded = await loadWorkflowRunEvents(runId);
                        cachedEvents = loaded.events;
                        eventsCursor = loaded.cursor;
                        events = cachedEvents;
                      } else {
                        // No cursor available despite having cached events
                        // and no preloaded-events explanation. All World
                        // implementations are required to return a cursor
                        // when there are events, so this signals a bug in
                        // the World. Fall back to a full reload to avoid
                        // stale data.
                        runtimeLogger.warn(
                          'Event cursor missing after initial load — falling back to full reload. ' +
                            'This indicates a bug in the World implementation.',
                          { workflowRunId: runId }
                        );
                        const loaded = await loadWorkflowRunEvents(runId);
                        cachedEvents = loaded.events;
                        eventsCursor = loaded.cursor;
                        events = cachedEvents;
                      }

                      // Detect concurrent completion via the event log: if
                      // any other handler wrote a terminal run event, exit
                      // before doing replay work. The run entity's status is
                      // derived from these events, so checking the log here
                      // gives us the same signal as a runs.get() round-trip
                      // without the extra request per loop iteration.
                      if (hasRecordedTerminalRunEvent(events, runId)) {
                        return;
                      }

                      // Complete elapsed waits
                      const now = Date.now();
                      const completedWaitIds = new Set(
                        events
                          .filter((e) => e.eventType === 'wait_completed')
                          .map((e) => e.correlationId)
                      );
                      const waitsToComplete = events
                        .filter(
                          (
                            e
                          ): e is Extract<
                            Event,
                            { eventType: 'wait_created' }
                          > & { correlationId: string } =>
                            e.eventType === 'wait_created' &&
                            e.correlationId !== undefined &&
                            !completedWaitIds.has(e.correlationId) &&
                            now >= (e.eventData.resumeAt as Date).getTime()
                        )
                        .map((e) => ({
                          eventType: 'wait_completed' as const,
                          specVersion: SPEC_VERSION_CURRENT,
                          correlationId: e.correlationId,
                          eventData: {
                            resumeAt: e.eventData.resumeAt,
                          },
                        }));

                      for (const waitEvent of waitsToComplete) {
                        const waitLog: MutableEventLog = {
                          events,
                          cursor: eventsCursor,
                        };
                        try {
                          await withPreconditionRetry(
                            runId,
                            waitLog,
                            (stateUpdatedAt) =>
                              world.events.create(runId, waitEvent, {
                                requestId,
                                stateUpdatedAt,
                              })
                          );
                        } catch (err) {
                          if (EntityConflictError.is(err)) {
                            runtimeLogger.info(
                              'Wait already completed, skipping',
                              {
                                workflowRunId: runId,
                                correlationId: waitEvent.correlationId,
                              }
                            );
                            continue;
                          }
                          throw err;
                        } finally {
                          // Reloads inside the guard may have advanced the cursor.
                          eventsCursor = waitLog.cursor;
                        }
                      }

                      if (waitsToComplete.length > 0) {
                        // The event list above may be stale by the time an
                        // elapsed wait is committed. Load only events after
                        // the original snapshot cursor so concurrent durable
                        // events, such as hook_received, keep their ordering
                        // relative to wait_completed. Fall back to a full
                        // reload for older worlds that cannot give us a stable
                        // cursor, or if the cursor delta does not include the
                        // wait completion this handler just attempted.
                        if (eventsCursor) {
                          const loaded = await loadWorkflowRunEvents(
                            runId,
                            eventsCursor
                          );
                          const completedWaitIdsAfterCursor = new Set(
                            loaded.events
                              .filter((e) => e.eventType === 'wait_completed')
                              .map((e) => e.correlationId)
                          );
                          const sawAllWaitCompletions = waitsToComplete.every(
                            (waitEvent) =>
                              completedWaitIdsAfterCursor.has(
                                waitEvent.correlationId
                              )
                          );

                          if (sawAllWaitCompletions) {
                            const existingIds = new Set(
                              events.map((e) => e.eventId)
                            );
                            for (const event of loaded.events) {
                              if (!existingIds.has(event.eventId)) {
                                existingIds.add(event.eventId);
                                events.push(event);
                              }
                            }
                            eventsCursor = loaded.cursor ?? eventsCursor;
                          } else {
                            const loaded = await loadWorkflowRunEvents(runId);
                            events = loaded.events;
                            eventsCursor = loaded.cursor;
                          }
                        } else {
                          const loaded = await loadWorkflowRunEvents(runId);
                          events = loaded.events;
                          eventsCursor = loaded.cursor;
                        }
                      }

                      // Completing elapsed waits refreshes the event snapshot.
                      // A concurrent handler may have written the terminal run
                      // event after the initial snapshot but before this
                      // replay. Once the event log records that outcome, this
                      // delivery is done.
                      if (hasRecordedTerminalRunEvent(events, runId)) {
                        return;
                      }

                      // Update cache reference (may have been set for first time)
                      cachedEvents = events;

                      // Latency telemetry: judge TTFS eligibility against the
                      // invocation's first snapshot. Waits completed above
                      // would already disqualify via the event-type check, so
                      // evaluating after the wait pass is equivalent.
                      // attr_set is permitted: a redelivery can land after a
                      // committed pre-step attr_set, and the detour it marks
                      // is subtracted via preStepAttrStartMs regardless of
                      // which invocation wrote it (see runtime/step-latency.ts).
                      invocationStartedClean ??= events.every(
                        (e) =>
                          e.eventType === 'run_created' ||
                          e.eventType === 'run_started' ||
                          e.eventType === 'attr_set'
                      );

                      // Snapshot the cursor as it stands for this iteration's
                      // event log, before any inline writes (step_created via
                      // handleSuspension, step_started/step_completed via
                      // executeStep) advance it. This is the `sinceCursor`
                      // handed to a supporting World on the inline step's
                      // terminal write so it can return the event-log delta —
                      // letting the next iteration skip the incremental
                      // events.list. Captured here because nothing between this
                      // point and the inline executeStep mutates eventsCursor.
                      preInlineWriteCursor = eventsCursor;

                      // Replay workflow
                      runtimeLogger.debug('Starting workflow replay', {
                        workflowRunId: runId,
                        loopIteration,
                        eventCount: events.length,
                      });
                      replayStart = Date.now();
                      const result = await runWorkflow(
                        workflowCode,
                        workflowRun,
                        events,
                        encryptionKey,
                        stepHydrationCache,
                        // Turbo: the end-of-run drain inside runWorkflow commits
                        // fire-and-forget `*_created` events before the terminal
                        // `awaitRunReady()` below, so gate those writes on the
                        // backgrounded run_started too. Undefined outside turbo.
                        runReadyBarrier
                      );
                      runtimeLogger.debug('Workflow replay completed', {
                        workflowRunId: runId,
                        loopIteration,
                        replayMs: Date.now() - replayStart,
                      });

                      // Workflow completed. Send the snapshot but do NOT
                      // reload-and-retry the create in place: `result` was
                      // computed by this replay, so a stale (412) rejection must
                      // force a *fresh replay* (which may observe the new event
                      // and produce a different result), not re-commit the stale
                      // result. The catch below lets PreconditionFailedError
                      // propagate to the queue for re-invocation.
                      try {
                        // Turbo: a workflow that finishes with no steps reaches
                        // here before the backgrounded run_started; order the
                        // terminal write after it so the run exists.
                        await awaitRunReady();
                        await world.events.create(
                          runId,
                          {
                            eventType: 'run_completed',
                            specVersion: SPEC_VERSION_CURRENT,
                            eventData: { output: result },
                          },
                          {
                            requestId,
                            stateUpdatedAt: stateUpdatedAtForCreate(events),
                          }
                        );
                      } catch (err) {
                        if (
                          EntityConflictError.is(err) ||
                          RunExpiredError.is(err)
                        ) {
                          runtimeLogger.info(
                            'Tried completing workflow run, but run has already finished.',
                            { workflowRunId: runId, message: err.message }
                          );
                          return;
                        }
                        throw err;
                      }

                      span?.setAttributes({
                        ...Attribute.WorkflowRunStatus('completed'),
                      });
                      return;
                    } catch (err) {
                      if (WorkflowSuspension.is(err)) {
                        runtimeLogger.debug('Workflow suspended', {
                          workflowRunId: runId,
                          loopIteration,
                          replayMs: Date.now() - replayStart,
                          steps: err.stepCount,
                          hooks: err.hookCount,
                          waits: err.waitCount,
                        });
                        const suspensionMessage =
                          buildWorkflowSuspensionMessage(
                            err.stepCount,
                            err.hookCount,
                            err.waitCount
                          );
                        if (suspensionMessage) {
                          runtimeLogger.debug(suspensionMessage);
                        }

                        // V2: handle suspension without queuing steps.
                        // Each event creation inside handleSuspension carries the
                        // loaded snapshot's stateUpdatedAt and self-reloads on a
                        // stale (412) rejection via the shared event log. We
                        // guard per-create (rather than wrapping the whole call)
                        // so a retry never re-issues an already-created event.
                        const suspensionStart = Date.now();
                        // The snapshot refresh above always sets cachedEvents
                        // before the replay can suspend. Re-narrow it for this
                        // catch scope instead of defaulting to an empty array:
                        // that fallback would silently disarm the precondition
                        // guard (no snapshot sent) and let a mid-suspension
                        // reload merge into a throwaway array.
                        if (!cachedEvents) {
                          throw new Error(
                            'Invariant violation: workflow suspended before its event log was loaded'
                          );
                        }
                        const suspensionLog: MutableEventLog = {
                          events: cachedEvents,
                          cursor: eventsCursor,
                        };
                        let suspensionResult: Awaited<
                          ReturnType<typeof handleSuspension>
                        >;
                        try {
                          suspensionResult = await handleSuspension({
                            suspension: err,
                            world,
                            run: workflowRun,
                            span,
                            requestId,
                            eventLog: suspensionLog,
                            runReadyBarrier,
                          });
                        } catch (suspensionError) {
                          // A suspension create whose stale (412) rejection
                          // survived the in-guard reload retries: schedule an
                          // explicit immediate re-invocation (a rethrow relies
                          // on redelivery of a message the turbo path already
                          // acked — the run would stall for the queue's ~300s
                          // default visibility timeout).
                          if (PreconditionFailedError.is(suspensionError)) {
                            runtimeLogger.warn(
                              'Suspension event creation rejected as stale after reload retries; re-invoking run for a fresh replay',
                              { workflowRunId: runId, loopIteration }
                            );
                            return await reinvoke(0);
                          }
                          if (!FatalError.is(suspensionError)) {
                            // Transient failures propagate to the queue
                            // handler so the message is redelivered.
                            throw suspensionError;
                          }
                          // Non-retryable failure while committing the
                          // suspension's events — e.g. an attribute write
                          // the World rejected as invalid (the cumulative
                          // per-run cap can only be checked World-side).
                          // Redelivery would replay the workflow into the
                          // same write and the same rejection, so fail the
                          // run with the error instead of wedging the
                          // message in redelivery.
                          const errorCode = classifyRunError(suspensionError);
                          runtimeLogger.error(
                            'Non-retryable error while committing workflow suspension; failing run',
                            {
                              workflowRunId: runId,
                              errorCode,
                              errorName: suspensionError.name,
                              errorMessage: suspensionError.message,
                            }
                          );
                          try {
                            // Turbo: order the terminal write after the
                            // backgrounded run_started so the run exists.
                            await awaitRunReady();
                            await world.events.create(
                              runId,
                              {
                                eventType: 'run_failed',
                                specVersion: SPEC_VERSION_CURRENT,
                                eventData: {
                                  error: await dehydrateRunError(
                                    suspensionError,
                                    runId,
                                    encryptionKey,
                                    globalThis,
                                    (workflowRun?.specVersion ?? 0) >=
                                      SPEC_VERSION_SUPPORTS_COMPRESSION
                                  ),
                                  errorCode,
                                },
                              },
                              { requestId }
                            );
                          } catch (failErr) {
                            if (
                              EntityConflictError.is(failErr) ||
                              RunExpiredError.is(failErr)
                            ) {
                              runtimeLogger.info(
                                'Tried failing workflow run, but run has already finished.',
                                {
                                  workflowRunId: runId,
                                  message: failErr.message,
                                }
                              );
                              return;
                            }
                            throw failErr;
                          }
                          span?.setAttributes({
                            ...Attribute.WorkflowRunStatus('failed'),
                            ...Attribute.WorkflowErrorCode(errorCode),
                            ...Attribute.WorkflowErrorName(
                              suspensionError.name
                            ),
                            ...Attribute.WorkflowErrorMessage(
                              suspensionError.message
                            ),
                            ...Attribute.ErrorType(suspensionError.name),
                          });
                          return;
                        }
                        eventsCursor = suspensionLog.cursor;
                        preStepBlockingMs += suspensionResult.hookCreationMs;
                        if (
                          suspensionResult.hasAttributeEvents &&
                          preStepBlockingBeforeAttrMs === undefined
                        ) {
                          preStepBlockingBeforeAttrMs = preStepBlockingMs;
                        }
                        runtimeLogger.debug('Suspension handled', {
                          workflowRunId: runId,
                          suspensionMs: Date.now() - suspensionStart,
                          pendingSteps: suspensionResult.pendingSteps.length,
                          timeoutSeconds: suspensionResult.waitTimeout?.seconds,
                          hasHookConflict: suspensionResult.hasHookConflict,
                          hasAwaitedHookCreation:
                            suspensionResult.hasAwaitedHookCreation,
                          hasAttributeEvents:
                            suspensionResult.hasAttributeEvents,
                        });

                        // Hook conflict: break loop, re-invoke via queue
                        if (suspensionResult.hasHookConflict) {
                          return await reinvoke(0);
                        }

                        // Native workflow attribute events are resolved
                        // through replay: the next loop iteration reloads the
                        // log (now holding the just-committed attr_set) and
                        // replays, resolving the setAttributes promise. Skip
                        // step processing for this pass so that replay decides
                        // races first — in Promise.race([setAttributes(),
                        // step()]), the durable attribute event must be able
                        // to win without executing the losing step. The replay
                        // happens in-process rather than via a queue
                        // re-invocation: unlike hooks and waits, an attr_set
                        // introduces no out-of-band invocation source that the
                        // handler would need to yield the message for, so
                        // paying a delivery round-trip here would only add
                        // latency before the workflow's next step.
                        if (suspensionResult.hasAttributeEvents) {
                          continue;
                        }

                        const pendingSteps = suspensionResult.pendingSteps;

                        // Inline execution is gated on ownership. The
                        // suspension handler deferred the step_created write for
                        // up to `getMaxInlineSteps()` steps (`lazyInlineSteps`)
                        // so we can run them inline — in parallel — via lazy
                        // `step_started` events that create each step on the fly,
                        // saving one world round-trip per inline step. Ownership
                        // is still atomic and exactly-one per step: the world's
                        // create-claim inside each step_started returns
                        // `EntityConflictError` (→ executeStep `skipped`) to any
                        // concurrent loser, so only one handler ever runs a given
                        // body. Every other pending step keeps its eager
                        // step_created (in `createdStepCorrelationIds`) and is
                        // queued below.
                        //
                        // The suspension handler only designates
                        // `lazyInlineSteps` when no `hook.getConflict()` awaiter
                        // is present. That awaiter case must execute nothing
                        // inline: an inline `await executeStep(...)` blocks this
                        // handler for the full step duration, so the awaiter's
                        // continuation (which only advances on the next replay)
                        // would be serialized behind the step — defeating work
                        // the workflow expressed as parallel (e.g.
                        // `hook.getConflict().then(() => stepB())` racing `await
                        // stepA()`). In that case `lazyInlineSteps` is empty and
                        // every step is queued for re-invocation, which replays
                        // over the just-committed hook_created and resolves the
                        // awaiter while queued steps run in parallel invocations.
                        const lazyInlineSteps =
                          suspensionResult.lazyInlineSteps;
                        const inlineCorrelationIds = new Set(
                          lazyInlineSteps.map((s) => s.correlationId)
                        );

                        // Unified queue dispatch for everything we are NOT
                        // inline-executing. Steps are queued with stepId so
                        // the receiver runs them; the wait timer is queued
                        // as a generic continuation that fires after the
                        // wait elapses and lets the next replay observe the
                        // elapsed wait via the "complete elapsed waits"
                        // pass.
                        //
                        // Step dispatch decision table (per pending step not
                        // designated lazy-inline):
                        //
                        //   - Inline-owned, owner === this message  →
                        //     execute in THIS invocation (owned recovery: a
                        //     redelivery of the owning message re-executes
                        //     the step it crashed on, via a re-stamped bare
                        //     step_started).
                        //   - Inline-owned, owner !== this message  →
                        //     ensure a DELAYED backstop wake exists
                        //     (delaySeconds = ownership lease remaining)
                        //     instead of enqueueing the step. The owning
                        //     invocation is (likely) still running the body;
                        //     an immediate step message would bare-start the
                        //     running step and execute it a second time
                        //     (workflow#2780). The backstop is a plain run
                        //     continuation, NOT a step message: when it
                        //     fires, this same decision table handles
                        //     whatever state the step is in by then
                        //     (terminal → nothing pending; queue-owned after
                        //     step_retrying → normal keyed dispatch; owner
                        //     dead with lease expired → immediate dispatch,
                        //     preserving step-level failure semantics for
                        //     poison steps; lease refreshed by owner
                        //     recovery → re-arm). The backstop's
                        //     idempotencyKey is scoped to the ownership
                        //     EPOCH (latest step_started timestamp), NOT
                        //     just the correlation ID, and must never be
                        //     the step message's own key — see
                        //     backstopIdempotencyKey for both invariants
                        //     (fixed keys either absorb the retry handoff
                        //     or dedupe the refreshed-lease re-arm against
                        //     the in-flight backstop itself).
                        //   - Not owned (never stamped / eager / ownership
                        //     lapsed at step_retrying / lease expired /
                        //     kill-switched) → immediate enqueue, exactly as
                        //     before. This covers crash recovery: if a prior
                        //     handler wrote step_created but crashed before
                        //     queueing, a later handler queues it;
                        //     idempotencyKey on correlationId dedupes
                        //     redundant queues across concurrent handlers.
                        //
                        // The wait continuation is what makes
                        // `Promise.race(step, sleep)` behave correctly with
                        // inline step execution: even if the inline step
                        // blocks this handler for the full step duration,
                        // the wait timer fires in a separate function
                        // invocation. If the sleep wins, that parallel
                        // invocation completes the run; if the step wins,
                        // the wait continuation fires later and no-ops on
                        // the terminal run.
                        //
                        // The continuation's delay is clamped to the
                        // maximum queue delay (long waits chain across
                        // multiple hops) and its idempotency key dedupes
                        // re-observations of the same pending wait across
                        // suspension passes — see
                        // runtime/wait-continuation.ts for the full
                        // delay/key selection rationale.
                        const traceCarrier = await nextTraceCarrier();
                        const dispatches: Promise<unknown>[] = [];
                        const inlineOwnership = isInlineOwnershipEnabled();
                        const dispatchNowMs = Date.now();
                        const ownedRecoverySteps: StepInvocationQueueItem[] =
                          [];
                        let backstopWakesArmed = 0;
                        for (const step of pendingSteps) {
                          if (inlineCorrelationIds.has(step.correlationId)) {
                            continue;
                          }
                          const ownershipActive =
                            inlineOwnership && isStepOwnershipActive(step);
                          if (
                            ownershipActive &&
                            step.ownerMessageId === metadata.messageId
                          ) {
                            // Owned recovery: this delivery IS the owning
                            // message; re-execute the step in this
                            // invocation instead of queueing it.
                            ownedRecoverySteps.push(step);
                            continue;
                          }
                          // Delayed backstop wake while another invocation's
                          // ownership lease is live; immediate step enqueue
                          // otherwise (lease expired ⇒ remaining 0 ⇒ same as
                          // today, which is also the degraded mode for
                          // worlds with unstable message IDs — the owner
                          // check above never matches there).
                          const backstopDelaySeconds = ownershipActive
                            ? stepLeaseRemainingSeconds(step, dispatchNowMs)
                            : 0;
                          if (backstopDelaySeconds > 0) {
                            backstopWakesArmed++;
                            runtimeLogger.debug(
                              'Pending step is inline-owned by a live invocation; ensuring delayed backstop wake instead of immediate requeue',
                              {
                                workflowRunId: runId,
                                stepId: step.correlationId,
                                ownerMessageId: step.ownerMessageId,
                                backstopDelaySeconds,
                              }
                            );
                            dispatches.push(
                              queueMessage(
                                world,
                                getWorkflowQueueName(workflowName, namespace),
                                {
                                  runId,
                                  traceCarrier,
                                  requestedAt: new Date(),
                                },
                                {
                                  delaySeconds: backstopDelaySeconds,
                                  idempotencyKey: backstopIdempotencyKey(step),
                                }
                              )
                            );
                            continue;
                          }
                          dispatches.push(
                            queueMessage(
                              world,
                              getWorkflowQueueName(workflowName, namespace),
                              {
                                runId,
                                stepId: step.correlationId,
                                stepName: step.stepName,
                                traceCarrier,
                                requestedAt: new Date(),
                              },
                              {
                                idempotencyKey: step.correlationId,
                              }
                            )
                          );
                        }
                        if (suspensionResult.waitTimeout) {
                          dispatches.push(
                            queueMessage(
                              world,
                              getWorkflowQueueName(workflowName, namespace),
                              {
                                runId,
                                traceCarrier,
                                requestedAt: new Date(),
                              },
                              getWaitContinuationDispatch(
                                suspensionResult.waitTimeout.seconds,
                                suspensionResult.waitTimeout.correlationId
                              )
                            )
                          );
                        }
                        await Promise.all(dispatches);

                        // The set of steps THIS invocation executes: the
                        // deferred lazy-inline batch plus any owned-recovery
                        // steps (this message's redelivery re-executing a
                        // step it crashed on — no lazyStepInput; the input
                        // hydrates from the step entity like the background
                        // path, and the bare step_started re-stamps
                        // ownership).
                        const inlineExecutions: Array<{
                          correlationId: string;
                          stepName: string;
                          lazyStepInput?: (typeof lazyInlineSteps)[number]['dehydratedInput'];
                        }> = [
                          ...lazyInlineSteps.map((s) => ({
                            correlationId: s.correlationId,
                            stepName: s.stepName,
                            lazyStepInput: s.dehydratedInput,
                          })),
                          ...ownedRecoverySteps.map((s) => ({
                            correlationId: s.correlationId,
                            stepName: s.stepName,
                          })),
                        ];
                        // Ownership telemetry (design doc Phase 7): span
                        // attributes so production traces show when crash
                        // recovery ran or a wake was converted into a
                        // backstop, and a warn (always printed, unlike
                        // debug/info) for owned recovery — it means a prior
                        // delivery of this message died mid-step-body.
                        if (
                          backstopWakesArmed > 0 ||
                          ownedRecoverySteps.length > 0
                        ) {
                          span?.setAttributes({
                            ...(ownedRecoverySteps.length > 0
                              ? Attribute.WorkflowOwnedRecoverySteps(
                                  ownedRecoverySteps.length
                                )
                              : {}),
                            ...(backstopWakesArmed > 0
                              ? Attribute.WorkflowBackstopWakesArmed(
                                  backstopWakesArmed
                                )
                              : {}),
                          });
                        }
                        if (ownedRecoverySteps.length > 0) {
                          runtimeLogger.warn(
                            'Re-executing inline steps owned by this queue message — a previous delivery crashed mid-body and this redelivery is recovering them',
                            {
                              workflowRunId: runId,
                              stepIds: ownedRecoverySteps.map(
                                (s) => s.correlationId
                              ),
                            }
                          );
                        }

                        // Nothing to execute inline — everything has been
                        // queued (or no work needs scheduling). Exit and let
                        // the queue drive subsequent replays.
                        if (inlineExecutions.length === 0) {
                          // A `hook.getConflict()` awaiter needs an immediate
                          // re-invocation: the replay consumes the
                          // just-committed hook_created and resolves the
                          // awaiter. Without it (no inline step, all work
                          // queued or none pending) the run would sit idle
                          // until some unrelated message woke it.
                          if (suspensionResult.hasAwaitedHookCreation) {
                            return await reinvoke(0);
                          }
                          return;
                        }

                        // Execute inline step. Pause the replay budget
                        // for the duration of the step body — step
                        // duration is bounded by the platform's function
                        // maxDuration, not by the replay timeout. Without
                        // this the replay-budget check at the top of the
                        // next loop iteration would (incorrectly) charge
                        // the step body against the budget.
                        // Inline-delta fast path gate. We request the delta —
                        // and on the next iteration consume it in place of the
                        // events.list — only when ALL hold:
                        //
                        //  - We have a real prior cursor to diff against
                        //    (`preInlineWriteCursor`; a World may return none on
                        //    the initial load).
                        //  - This is the clean single-step sequential case:
                        //    this suspension produced exactly one step and no
                        //    hooks or waits (`err.{step,hook,wait}Count`), that
                        //    one step is the lone pending step
                        //    (`pendingSteps.length === 1`) and the lone inline
                        //    step (`lazyInlineSteps.length === 1` — no parallel
                        //    siblings queued to background handlers, and no other
                        //    inline step writing its own events out of band).
                        //  - No pending wait timer from THIS suspension.
                        //  - The run has NO pre-existing open hook or wait. This
                        //    plus the per-suspension counts above is the
                        //    load-bearing safety check: the delta snapshots the
                        //    log at the step_completed write but is consumed on
                        //    the next replay, so an out-of-band hook_received /
                        //    wait_completed landing in that window would be in a
                        //    real fetch yet absent from the stale delta —
                        //    risking a divergent replay. With no hook/wait open
                        //    (neither carried over nor created this suspension),
                        //    the only out-of-band writer is cancellation, which
                        //    is safe to observe one iteration late. See
                        //    hasOpenHookOrWait.
                        //
                        // When more than one step runs inline, each writes its
                        // own events and the per-write delta would be partial, so
                        // the delta is not requested (the gate below is false for
                        // multi-step) and the next iteration does a normal fetch.
                        const requestInlineDelta =
                          typeof preInlineWriteCursor === 'string' &&
                          err.stepCount === 1 &&
                          err.hookCount === 0 &&
                          err.waitCount === 0 &&
                          pendingSteps.length === 1 &&
                          lazyInlineSteps.length === 1 &&
                          ownedRecoverySteps.length === 0 &&
                          !suspensionResult.waitTimeout &&
                          !hasOpenHookOrWait(cachedEvents ?? []);

                        // Turbo mode forces optimistic inline start for this
                        // batch — but only while the run is still "clean" (a pure
                        // step suspension). The moment a hook or wait is
                        // created, later resume/parallel invocations become
                        // possible, so the single-handler guarantee that makes
                        // forced optimistic start safe no longer holds — turbo
                        // exits and the steps take the normal (env-gated)
                        // await-then-run path. The hook-conflict case already
                        // returned early above, the attr case continued into a
                        // fresh replay (so a batch-scheduling suspension never
                        // carries attr events), and the awaited-hook case
                        // emptied lazyInlineSteps; the checks below are
                        // defensive.
                        //
                        // The `suspensionResult.*` flags only reflect what THIS
                        // batch created, so they do not catch a hook/wait opened
                        // in an earlier iteration of the same delivery (e.g. a
                        // fire-and-forget `createHook(...)` that doesn't block the
                        // workflow, letting the replay loop continue to later pure
                        // step suspensions). Once any hook or wait is open in the
                        // cumulative log, resume/parallel invocations are possible
                        // for the rest of the run, so turbo must latch off
                        // permanently — checked here via `hasOpenHookOrWait` over
                        // the cumulative `cachedEvents`.
                        const forceOptimisticStart =
                          turbo &&
                          !suspensionResult.waitTimeout &&
                          !suspensionResult.hasHookEvents &&
                          !suspensionResult.hasAttributeEvents &&
                          !suspensionResult.hasAwaitedHookCreation &&
                          !hasOpenHookOrWait(cachedEvents ?? []);

                        // Execute the inline steps in parallel. The replay
                        // budget is paused for the whole batch — step duration is
                        // bounded by the platform's function maxDuration, not the
                        // replay timeout — so the budget check at the top of the
                        // next loop iteration doesn't charge the step bodies.
                        // Latency telemetry: decide whether this batch's first
                        // step qualifies for TTFS/STSO measurement. Only the
                        // batch's first step carries the tracking so a
                        // parallel batch emits one sample per scheduling gap,
                        // not one per sibling. Turbo's synthesized run
                        // snapshot has a local-clock createdAt, so under
                        // turbo only the run-id ULID timestamp is trusted.
                        const latencyTracking = computeStepLatencyTracking({
                          events: cachedEvents ?? [],
                          invocationStartedClean:
                            invocationStartedClean === true,
                          runCreatedAtMs:
                            runIdCreatedAt(runId) ??
                            (turbo ? undefined : +workflowRun.createdAt),
                          preStepBlockingMs,
                          preStepBlockingBeforeAttrMs,
                          // This suspension's own hook/wait writes are not in
                          // cachedEvents yet, so report them explicitly.
                          suspensionHasWaits:
                            err.waitCount > 0 ||
                            suspensionResult.waitTimeout !== undefined,
                          suspensionCreatedHooks:
                            err.hookCount > 0 || suspensionResult.hasHookEvents,
                          turbo,
                        });

                        replayBudget.pause();
                        let stepResults: Awaited<
                          ReturnType<typeof executeStep>
                        >[];
                        try {
                          stepResults = await Promise.all(
                            inlineExecutions.map((s, stepIndex) => {
                              const run = () =>
                                executeStep({
                                  world,
                                  workflowRunId: runId,
                                  workflowDeploymentId:
                                    workflowRun.deploymentId,
                                  workflowName,
                                  workflowStartedAt,
                                  rootRunId: rootRunIdFrom(
                                    workflowRun.attributes,
                                    runId
                                  ),
                                  stepId: s.correlationId,
                                  stepName: s.stepName,
                                  runSpecVersion: workflowRun.specVersion,
                                  // Lazy inline start: send the deferred step's
                                  // input on step_started so the world creates
                                  // the step on the fly. Absent for
                                  // owned-recovery steps, whose input hydrates
                                  // from the existing step entity.
                                  lazyStepInput: s.lazyStepInput,
                                  // Inline ownership: stamp (or re-stamp) this
                                  // invocation's queue message ID on the
                                  // step_started, so wake replays see the body
                                  // as in flight here and suppress the
                                  // immediate requeue (workflow#2780).
                                  ownerMessageId: metadata.messageId,
                                  // Turbo: force optimistic start and hold the
                                  // lazy step_started until the backgrounded
                                  // run_started lands (the body still runs
                                  // immediately). Both are undefined/false
                                  // outside turbo.
                                  forceOptimisticStart,
                                  runReadyBarrier,
                                  ...(stepIndex === 0 &&
                                  s.lazyStepInput !== undefined &&
                                  latencyTracking
                                    ? { latencyTracking }
                                    : {}),
                                  ...(requestInlineDelta && preInlineWriteCursor
                                    ? {
                                        inlineDeltaSinceCursor:
                                          preInlineWriteCursor,
                                      }
                                    : {}),
                                });
                              // Invariant bookkeeping: this invocation owns
                              // these bodies until they settle — see
                              // assertNoInFlightOwnedSteps.
                              inFlightOwnedSteps.add(s.correlationId);
                              // Lazy steps are brand-new (their create-claim
                              // is the exactly-once gate), but an
                              // owned-recovery step already exists and its
                              // delayed backstop message may fire mid-body
                              // in this same process — route those through
                              // the in-process single-flight.
                              const executed =
                                s.lazyStepInput === undefined
                                  ? runStepSingleFlight(
                                      runId,
                                      s.correlationId,
                                      run
                                    )
                                  : run();
                              return executed.finally(() =>
                                inFlightOwnedSteps.delete(s.correlationId)
                              );
                            })
                          );
                        } finally {
                          replayBudget.resume();
                        }

                        // Aggregate the batch results. `retry` steps (which
                        // already exist — their `step_started` succeeded) are
                        // re-queued per-step as background steps with their own
                        // delay; `throttled` steps (rejected on the create-claim,
                        // so never created) instead defer redelivery of this
                        // orchestrator message so they re-run inline with input
                        // on replay; completed/failed steps already wrote their
                        // terminal events. We only loop back to replay when every
                        // inline step reached a terminal state — otherwise the
                        // still-pending steps will be re-run by their queued retry
                        // messages and the background-step handler replays once
                        // all steps are done.
                        const toRetry: {
                          step: (typeof inlineExecutions)[number];
                          delaySeconds: number;
                        }[] = [];
                        let anyPendingOps = false;
                        // A throttled inline step delays redelivery of THIS
                        // orchestrator message rather than being re-queued as a
                        // background step. Crucially, a `throttled` result means
                        // the lazy `step_started` was rejected on the atomic
                        // create-claim — so the step was NEVER created (no
                        // `step_created`, no step entity). Re-queuing it as a
                        // background step would send a bare `step_started` (no
                        // input), which the world rejects with `Step "<id>" not
                        // found` because it cannot lazily create the step without
                        // its input; that error isn't translatable, so the
                        // message redelivers until MAX_QUEUE_DELIVERIES and the
                        // step (and run) fail. Deferring redelivery of the
                        // orchestrator instead re-attempts the throttled step
                        // inline WITH its input on replay. We track the longest
                        // backoff so a batch with multiple throttles waits the
                        // max. Note: `retry` results are safe to re-queue as
                        // background steps because a retry implies `step_started`
                        // already succeeded and the step exists.
                        let throttleTimeout: number | undefined;
                        for (let i = 0; i < inlineExecutions.length; i++) {
                          const r = stepResults[i];
                          const s = inlineExecutions[i];
                          if (r.type === 'retry') {
                            toRetry.push({
                              step: s,
                              delaySeconds: r.timeoutSeconds,
                            });
                          } else if (r.type === 'throttled') {
                            throttleTimeout = Math.max(
                              throttleTimeout ?? 0,
                              r.timeoutSeconds
                            );
                          } else if (
                            r.type === 'completed' &&
                            r.hasPendingOps
                          ) {
                            anyPendingOps = true;
                          }
                        }

                        if (throttleTimeout !== undefined) {
                          // Defer redelivery of the orchestrator after the
                          // throttle backoff. On replay every non-terminal step
                          // is re-dispatched by the suspension handler: the
                          // still-throttled steps run inline again WITH their
                          // input (their `step_created` is deferred anew), and
                          // any `retry` steps in this batch are queued as
                          // background steps with their own retryAfter honored.
                          // Terminal steps (completed/failed/skipped/gone) are
                          // observed from their events and not re-run. Because
                          // the replay drives all remaining work, we must NOT
                          // also re-queue `toRetry` here — that would
                          // double-dispatch those steps.
                          //
                          // This returns BEFORE the `anyPendingOps` branch
                          // below, so a batch that mixes a throttle with a
                          // completed step that left unflushed ops does not
                          // queue the explicit flush continuation. That is safe
                          // because the throttle backoff (>= 1s) always exceeds
                          // the in-invocation flush window (<= 500ms + waitUntil),
                          // so ops settle before the post-backoff redelivery
                          // replays and reads them.
                          return await reinvoke(throttleTimeout);
                        }

                        if (toRetry.length > 0) {
                          const retryTraceCarrier = await nextTraceCarrier();
                          await Promise.all(
                            toRetry.map(({ step, delaySeconds }) =>
                              queueMessage(
                                world,
                                getWorkflowQueueName(workflowName, namespace),
                                {
                                  runId,
                                  stepId: step.correlationId,
                                  stepName: step.stepName,
                                  traceCarrier: retryTraceCarrier,
                                  requestedAt: new Date(),
                                },
                                {
                                  delaySeconds,
                                  // Key the delayed retry on the step's
                                  // correlationId so it dedupes against the
                                  // keyed re-dispatch the suspension handler
                                  // performs on replay (it also uses
                                  // `idempotencyKey: step.correlationId`).
                                  //
                                  // Without this, a mixed batch where one step
                                  // `completed` with unflushed background ops
                                  // (`anyPendingOps`) and another step is
                                  // retrying would double-dispatch the retry:
                                  // the `anyPendingOps` branch below queues an
                                  // immediate plain continuation, whose replay
                                  // sees the still-`retrying` step as pending
                                  // and re-dispatches it *immediately* and
                                  // *with* a key. Since this delayed retry had
                                  // no key, the two messages wouldn't dedupe —
                                  // the step would run twice, the configured
                                  // retry backoff would be ignored (plain
                                  // `Error` retries persist no `retryAfter`, so
                                  // the world has no `TooEarly` guard), and the
                                  // retry body could run early/concurrently.
                                  // Sharing the key lets the earlier delayed
                                  // message win, honoring the backoff.
                                  idempotencyKey: step.correlationId,
                                }
                              )
                            )
                          );
                        }

                        // If any inline step had pending background ops (e.g.,
                        // stream writes to S3), break the loop and queue a plain
                        // continuation so waitUntil can flush them before the
                        // next replay reads them. This matches V1 behavior where
                        // each step ran in a separate function invocation.
                        if (anyPendingOps) {
                          runtimeLogger.debug(
                            'Breaking loop: inline step has pending ops',
                            { workflowRunId: runId, loopIteration }
                          );
                          await queueMessage(
                            world,
                            getWorkflowQueueName(workflowName, namespace),
                            {
                              runId,
                              traceCarrier: await nextTraceCarrier(),
                              requestedAt: new Date(),
                            }
                          );
                          return;
                        }

                        if (toRetry.length > 0) {
                          // Some inline steps will be re-run via their queued
                          // retry messages; the background-step handler replays
                          // once all steps are terminal. Don't loop here — the
                          // retrying steps have no terminal event to observe yet.
                          return;
                        }

                        // All inline steps reached a terminal state
                        // (completed/failed/skipped/gone) — loop back to replay
                        // (the workflow observes the terminal events on replay).
                        //
                        // If the single inline step's terminal write returned an
                        // inline delta (supporting World + the single-step gate
                        // above), stash it so the next iteration's load consumes
                        // it instead of issuing an incremental events.list. Only
                        // the completed path carries a delta; multi-step batches
                        // never request one.
                        if (inlineExecutions.length === 1) {
                          const only = stepResults[0];
                          if (
                            only.type === 'completed' &&
                            only.inlineDelta &&
                            !only.inlineDelta.hasMore
                          ) {
                            pendingInlineDelta = {
                              events: only.inlineDelta.events,
                              cursor: only.inlineDelta.cursor,
                            };
                          }
                        }
                      } else {
                        // Stale-snapshot rejection of a result-bearing create
                        // (run_completed sends the snapshot but is intentionally
                        // NOT retried in place), or one that survived the
                        // in-guard reload retries. Don't fail the run — schedule
                        // an explicit immediate re-invocation so a fresh replay
                        // observes the new event. Rethrowing instead would rely
                        // on redelivery of the CURRENT message, which the turbo
                        // path has already acked — empirically the run then
                        // stalls for the queue's ~300s default visibility
                        // timeout before completing.
                        if (PreconditionFailedError.is(err)) {
                          runtimeLogger.warn(
                            'Event creation rejected as stale; re-invoking run for a fresh replay',
                            { workflowRunId: runId, loopIteration }
                          );
                          return await reinvoke(0);
                        }

                        // Transient infrastructure failures talking to the
                        // world (workflow-server) — an exhausted RetryAgent
                        // (UND_ERR_REQ_RETRY from a sustained 429/503 storm),
                        // a dropped socket, a connect/DNS failure, or a client
                        // timeout — must NOT fail the run. Rethrow so the queue
                        // redelivers and a fresh invocation retries the replay
                        // once the backend recovers. The @vercel/queue handler
                        // applies a fast (1s→60s) backoff by delivery count,
                        // avoiding the ~5min default visibility-timeout redrive
                        // (and never killing the process via run_failed).
                        if (isRetryableWorldError(err)) {
                          runLogger.warn(
                            'Transient world error during replay; redelivering via queue instead of failing the run',
                            {
                              errorName:
                                err instanceof Error
                                  ? err.name
                                  : 'UnknownError',
                              errorMessage:
                                err instanceof Error
                                  ? err.message
                                  : String(err),
                              deliveryAttempt: metadata.attempt,
                            }
                          );
                          throw err;
                        }

                        let terminalError = err;
                        if (ReplayDivergenceError.is(err)) {
                          const divergenceCount =
                            (replayDivergence?.count ?? 0) + 1;
                          const maxRecoveryReplays =
                            getReplayDivergenceMaxRetries();

                          if (divergenceCount <= maxRecoveryReplays) {
                            runLogger.warn(
                              'Workflow replay diverged; queueing a recovery replay before declaring the event log corrupted',
                              {
                                errorCode: RUN_ERROR_CODES.REPLAY_DIVERGENCE,
                                divergenceEventId: err.eventId,
                                priorDivergenceEventId:
                                  replayDivergence?.eventId,
                                divergenceCount,
                                deliveryAttempt: metadata.attempt,
                                maxRecoveryReplays,
                                errorMessage: err.message,
                              }
                            );
                            await queueMessage(
                              world,
                              getWorkflowQueueName(workflowName, namespace),
                              {
                                runId,
                                traceCarrier: await nextTraceCarrier(),
                                requestedAt: new Date(),
                                replayDivergence: {
                                  eventId: err.eventId,
                                  count: divergenceCount,
                                },
                              }
                            );
                            return;
                          }

                          terminalError = new CorruptedEventLogError(
                            `Workflow replay diverged ${divergenceCount} times after ${maxRecoveryReplays} recovery replays; latest divergent event was ${err.eventId}. Last divergence: ${err.message}`,
                            { cause: err }
                          );
                        }

                        // User code errors and terminal runtime errors fail the run.
                        if (terminalError instanceof Error) {
                          span?.recordException?.(terminalError);
                        }

                        const normalizedError =
                          await normalizeUnknownError(terminalError);
                        const errorName =
                          normalizedError.name || getErrorName(terminalError);
                        const errorMessage = normalizedError.message;
                        let errorStack =
                          normalizedError.stack || getErrorStack(terminalError);

                        if (errorStack) {
                          const parsedName = parseWorkflowName(workflowName);
                          const filename =
                            parsedName?.moduleSpecifier || workflowName;
                          errorStack = remapErrorStack(
                            errorStack,
                            filename,
                            workflowCode
                          );
                        }

                        // Classify the error: WorkflowRuntimeError indicates
                        // an SDK/runtime issue, and selected subclasses use
                        // more specific codes for backend tracking.
                        const errorCode = classifyRunError(terminalError);

                        runtimeLogger.error('Error while running workflow', {
                          workflowRunId: runId,
                          errorCode,
                          errorName,
                          errorStack,
                        });

                        // Apply the source-map-remapped stack to the thrown
                        // value so that the serialized error preserves it
                        // for consumers. `types.isNativeError()` is used
                        // instead of `err instanceof Error` because the
                        // workflow runs in a separate VM realm — its Error
                        // class is distinct from the host's, so `instanceof
                        // Error` is `false` for VM-thrown errors. The V8
                        // type tag works across realms.
                        if (types.isNativeError(terminalError) && errorStack) {
                          (terminalError as Error).stack = errorStack;
                        }

                        // Fail the workflow run via event (event-sourced).
                        // Serialize the original thrown value so its full
                        // type identity and custom properties round-trip
                        // through the event log.
                        try {
                          // Turbo: order the terminal write after the
                          // backgrounded run_started so the run exists.
                          await awaitRunReady();
                          await world.events.create(
                            runId,
                            {
                              eventType: 'run_failed',
                              specVersion: SPEC_VERSION_CURRENT,
                              eventData: {
                                error: await dehydrateRunError(
                                  terminalError,
                                  runId,
                                  encryptionKey,
                                  globalThis,
                                  (workflowRun?.specVersion ?? 0) >=
                                    SPEC_VERSION_SUPPORTS_COMPRESSION
                                ),
                                errorCode,
                              },
                            },
                            { requestId }
                          );
                        } catch (failErr) {
                          if (
                            EntityConflictError.is(failErr) ||
                            RunExpiredError.is(failErr)
                          ) {
                            runtimeLogger.info(
                              'Tried failing workflow run, but run has already finished.',
                              {
                                workflowRunId: runId,
                                message: failErr.message,
                              }
                            );
                            return;
                          }
                          if (isWorldContractError(failErr)) {
                            runtimeLogger.error(
                              'Fatal world contract error while recording workflow failure',
                              {
                                workflowRunId: runId,
                                errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
                                error:
                                  failErr instanceof Error
                                    ? failErr.message
                                    : String(failErr),
                              }
                            );
                            return;
                          }
                          throw failErr;
                        }

                        span?.setAttributes({
                          ...Attribute.WorkflowRunStatus('failed'),
                          ...Attribute.WorkflowErrorCode(errorCode),
                          ...Attribute.WorkflowErrorName(errorName),
                          ...Attribute.WorkflowErrorMessage(errorMessage),
                          ...Attribute.ErrorType(errorName),
                        });
                        return;
                      }
                    }
                  } // End while loop
                }
              ); // End trace
            }
          ); // End withWorkflowBaggage
        }); // End withTraceContext
      }
    );

  let cachedHandler: ((req: Request) => Promise<Response>) | undefined;
  let invocationCount = 0;
  const entrypointCreatedAt = Date.now();
  const routeModuleBodyInitMs =
    typeof options?.routeModuleBodyStartedAt === 'number'
      ? entrypointCreatedAt - options.routeModuleBodyStartedAt
      : undefined;

  return withHealthCheck(async (req) => {
    invocationCount += 1;
    const handlerCached = cachedHandler !== undefined;
    const spanKind = await getSpanKind('SERVER');

    return trace(
      'workflow.route.flow',
      {
        kind: spanKind,
        attributes: {
          ...Attribute.WorkflowRouteType('flow'),
          ...Attribute.WorkflowRouteHandlerCached(handlerCached),
          ...Attribute.WorkflowRouteInvocationCount(invocationCount),
          ...Attribute.WorkflowRouteEntrypointAgeMs(
            Date.now() - entrypointCreatedAt
          ),
          ...(routeModuleBodyInitMs === undefined
            ? {}
            : Attribute.WorkflowRouteModuleBodyInitMs(routeModuleBodyInitMs)),
          ...Attribute.HttpRequestMethod(req.method),
          ...Attribute.HttpRoute('/.well-known/workflow/v1/flow'),
        },
      },
      async (span) => {
        if (!cachedHandler) {
          cachedHandler = await trace('workflow.route.init', async () => {
            const worldHandlers = await trace(
              'workflow.route.get_world_handlers',
              async () => getWorldHandlers()
            );
            return handler(worldHandlers);
          });
        }

        const response = await cachedHandler(req);
        if (response instanceof Response) {
          span?.setAttributes(
            Attribute.HttpResponseStatusCode(response.status)
          );
        }
        return response;
      }
    );
  });
}
