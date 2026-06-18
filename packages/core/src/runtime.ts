import { types } from 'node:util';
import {
  CorruptedEventLogError,
  EntityConflictError,
  FatalError,
  ReplayDivergenceError,
  RUN_ERROR_CODES,
  type RunErrorCode,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  parseWorkflowName,
  workflowDisplayName,
} from '@workflow/utils/parse-name';
import {
  type Event,
  getQueueTopicPrefix,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { classifyRunError, isWorldContractError } from './classify-error.js';
import { describeError } from './describe-error.js';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import {
  MAX_QUEUE_DELIVERIES,
  REPLAY_DIVERGENCE_MAX_RETRIES,
} from './runtime/constants.js';
import {
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  parseHealthCheckPayload,
  queueMessage,
  withHealthCheck,
} from './runtime/helpers.js';
import {
  handleReplayBudgetExhausted,
  ReplayBudget,
} from './runtime/replay-budget.js';
import { executeStep } from './runtime/step-executor.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { getWaitContinuationDispatch } from './runtime/wait-continuation.js';
import {
  getWorld,
  getWorldHandlers,
  type WorldHandlers,
} from './runtime/world.js';
import { dehydrateRunError } from './serialization.js';
import { remapErrorStack } from './source-map.js';
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
  cancelRun,
  listStreams,
  type ReadStreamOptions,
  type RecreateRunOptions,
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
  getWorld,
  getWorldHandlers,
  setWorld,
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
  options?: { namespace?: string }
): (req: Request) => Promise<Response> {
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

        if (metadata.attempt > MAX_QUEUE_DELIVERIES) {
          const maxDeliveriesDescription = describeError(
            undefined,
            RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED
          );
          runLogger.error(
            `Workflow handler exceeded max deliveries (${metadata.attempt}/${MAX_QUEUE_DELIVERIES})`,
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
              `Workflow exceeded maximum queue deliveries (${metadata.attempt}/${MAX_QUEUE_DELIVERIES})`
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
        // 'linked' (default): the WORKFLOW_V2 span below starts a NEW root
        // trace, with span links to (a) the incoming delivery context and
        // (b) the run-origin context from the message's trace carrier. This
        // bounds each trace to a single invocation instead of stitching an
        // entire (potentially hours-long) run into one giant trace.
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
        // withTraceContext a passthrough, and the WORKFLOW_V2 span below
        // becomes a new trace root carrying span links instead.
        const parentTraceCarrier =
          traceMode === 'continuous' ? traceContext : undefined;
        // Queue-delivered invocation: CONSUMER kind, matching the
        // queue-delivered step.execute span.
        const spanKind = await getSpanKind('CONSUMER');
        return await withTraceContext(parentTraceCarrier, async () => {
          return await withWorkflowBaggage(
            { workflowRunId: runId, workflowName },
            async () => {
              const world = await getWorld();
              return trace(
                `workflow.execute ${workflowDisplayName(workflowName)}`,
                traceMode === 'linked'
                  ? { kind: spanKind, links: spanLinks, root: true }
                  : { kind: spanKind, links: spanLinks },
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
                        stepResult = await executeStep({
                          world,
                          workflowRunId: runId,
                          workflowDeploymentId: bgRun.deploymentId,
                          workflowName,
                          workflowStartedAt: bgStartedAt,
                          stepId: incomingStepId,
                          stepName: incomingStepName,
                          runSpecVersion: bgRun.specVersion,
                        });
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
                        let hasPendingSteps = false;
                        for (const id of stepCreatedIds) {
                          if (!stepTerminalIds.has(id)) {
                            hasPendingSteps = true;
                            break;
                          }
                        }

                        if (hasPendingSteps) {
                          // Other steps still in progress. Return without
                          // queuing — the last handler to complete will see
                          // all steps done and replay inline.
                          runtimeLogger.debug(
                            'Background step done but other steps pending, returning',
                            { workflowRunId: runId }
                          );
                          return;
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
                    try {
                      const result = await world.events.create(
                        runId,
                        {
                          eventType: 'run_started',
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
                        },
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
                        try {
                          await world.events.create(runId, waitEvent, {
                            requestId,
                          });
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
                        encryptionKey
                      );
                      runtimeLogger.debug('Workflow replay completed', {
                        workflowRunId: runId,
                        loopIteration,
                        replayMs: Date.now() - replayStart,
                      });

                      // Workflow completed
                      try {
                        await world.events.create(
                          runId,
                          {
                            eventType: 'run_completed',
                            specVersion: SPEC_VERSION_CURRENT,
                            eventData: { output: result },
                          },
                          { requestId }
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

                        // V2: handle suspension without queuing steps
                        const suspensionStart = Date.now();
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
                          });
                        } catch (suspensionError) {
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
                          return { timeoutSeconds: 0 };
                        }

                        // Native workflow attribute events are resolved through
                        // replay. Re-invoke before processing pending steps:
                        // in Promise.race([setAttributes(), step()]), the
                        // durable attribute event can win without executing
                        // the losing step.
                        if (suspensionResult.hasAttributeEvents) {
                          return { timeoutSeconds: 0 };
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
                        // Step queueing is unconditional (covers crash
                        // recovery: if a prior handler wrote step_created
                        // but crashed before queueing, a later handler will
                        // queue them; idempotencyKey on correlationId
                        // dedupes redundant queues across concurrent
                        // handlers).
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
                        for (const step of pendingSteps) {
                          if (inlineCorrelationIds.has(step.correlationId)) {
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

                        // Nothing to execute inline — everything has been
                        // queued (or no work needs scheduling). Exit and let
                        // the queue drive subsequent replays.
                        if (lazyInlineSteps.length === 0) {
                          // A `hook.getConflict()` awaiter needs an immediate
                          // re-invocation: the replay consumes the
                          // just-committed hook_created and resolves the
                          // awaiter. Without it (no inline step, all work
                          // queued or none pending) the run would sit idle
                          // until some unrelated message woke it.
                          if (suspensionResult.hasAwaitedHookCreation) {
                            return { timeoutSeconds: 0 };
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
                          !suspensionResult.waitTimeout &&
                          !hasOpenHookOrWait(cachedEvents ?? []);

                        // Execute the inline steps in parallel. The replay
                        // budget is paused for the whole batch — step duration is
                        // bounded by the platform's function maxDuration, not the
                        // replay timeout — so the budget check at the top of the
                        // next loop iteration doesn't charge the step bodies.
                        replayBudget.pause();
                        let stepResults: Awaited<
                          ReturnType<typeof executeStep>
                        >[];
                        try {
                          stepResults = await Promise.all(
                            lazyInlineSteps.map((s) =>
                              executeStep({
                                world,
                                workflowRunId: runId,
                                workflowDeploymentId: workflowRun.deploymentId,
                                workflowName,
                                workflowStartedAt,
                                stepId: s.correlationId,
                                stepName: s.stepName,
                                runSpecVersion: workflowRun.specVersion,
                                // Lazy inline start: send the deferred step's
                                // input on step_started so the world creates the
                                // step on the fly.
                                lazyStepInput: s.dehydratedInput,
                                ...(requestInlineDelta && preInlineWriteCursor
                                  ? {
                                      inlineDeltaSinceCursor:
                                        preInlineWriteCursor,
                                    }
                                  : {}),
                              })
                            )
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
                          step: (typeof lazyInlineSteps)[number];
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
                        for (let i = 0; i < lazyInlineSteps.length; i++) {
                          const r = stepResults[i];
                          const s = lazyInlineSteps[i];
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
                          return { timeoutSeconds: throttleTimeout };
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
                        if (lazyInlineSteps.length === 1) {
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
                        let terminalError = err;
                        if (ReplayDivergenceError.is(err)) {
                          const divergenceCount =
                            (replayDivergence?.count ?? 0) + 1;

                          if (
                            divergenceCount <= REPLAY_DIVERGENCE_MAX_RETRIES
                          ) {
                            runLogger.warn(
                              'Workflow replay diverged; queueing a recovery replay before declaring the event log corrupted',
                              {
                                errorCode: RUN_ERROR_CODES.REPLAY_DIVERGENCE,
                                divergenceEventId: err.eventId,
                                priorDivergenceEventId:
                                  replayDivergence?.eventId,
                                divergenceCount,
                                deliveryAttempt: metadata.attempt,
                                maxRecoveryReplays:
                                  REPLAY_DIVERGENCE_MAX_RETRIES,
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
                            `Workflow replay diverged ${divergenceCount} times after ${REPLAY_DIVERGENCE_MAX_RETRIES} recovery replays; latest divergent event was ${err.eventId}. Last divergence: ${err.message}`,
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
  return withHealthCheck(async (req) => {
    if (!cachedHandler) {
      cachedHandler = handler(await getWorldHandlers());
    }
    return cachedHandler(req);
  });
}
