import {
  CorruptedEventLogError,
  EntityConflictError,
  MaxEventsExceededError,
  PreconditionFailedError,
  ReplayDivergenceError,
  RUN_ERROR_CODES,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { setWorkflowBasePath } from '@workflow/utils';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  getQueueTopicPrefix,
  resolveQueueNamespace,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
} from '@workflow/world';
import {
  classifyRunError,
  isRetryableWorldError,
  isWorldContractError,
} from './classify-error.js';
import { importKey } from './encryption.js';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import {
  getMaxEventsOverride,
  MAX_QUEUE_DELIVERIES,
  REPLAY_DIVERGENCE_MAX_RETRIES,
  REPLAY_TIMEOUT_MAX_RETRIES,
  REPLAY_TIMEOUT_MS,
} from './runtime/constants.js';
import {
  getQueueOverhead,
  getWorkflowQueueName,
  getWorkflowRunEvents,
  handleHealthCheckMessage,
  type MutableEventLog,
  parseHealthCheckPayload,
  queueMessage,
  stateUpdatedAtForCreate,
  withHealthCheck,
  withPreconditionRetry,
} from './runtime/helpers.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { getWorld, getWorldHandlers } from './runtime/world.js';
import { remapErrorStack } from './source-map.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import {
  linkToCurrentContext,
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
export { stepEntrypoint } from './runtime/step-handler.js';
export {
  createWorld,
  getWorld,
  getWorldHandlers,
  setWorld,
} from './runtime/world.js';

/**
 * Apply the optional client-side event-limit override.
 * `WORKFLOW_MAX_EVENTS_OVERRIDE`, when set to a positive integer, clamps the
 * server-supplied per-run event ceiling to a smaller value so enforcement can
 * be exercised without a server-side change. Clamp-down only: it never raises
 * the server's limit, and it takes effect even when the server returns none.
 * Unset ⇒ server value passes through unchanged.
 */
function clampMaxEvents(serverValue: number | undefined): number | undefined {
  const override = getMaxEventsOverride();
  if (override === undefined) return serverValue;
  return serverValue === undefined ? override : Math.min(serverValue, override);
}

function hasRecordedTerminalRunEvent(events: Event[], runId: string): boolean {
  const terminalEvent = events.find(
    (event) =>
      event.runId === runId &&
      (event.eventType === 'run_completed' ||
        event.eventType === 'run_failed' ||
        event.eventType === 'run_cancelled')
  );

  if (!terminalEvent) {
    return false;
  }

  runtimeLogger.info(
    'Workflow event log already contains a terminal run event, skipping replay',
    {
      workflowRunId: runId,
      eventType: terminalEvent.eventType,
      eventId: terminalEvent.eventId,
    }
  );
  return true;
}

/**
 * Function that creates a single route which handles any workflow execution
 * request and routes to the appropriate workflow function.
 *
 * @param workflowCode - The workflow bundle code containing all the workflow
 * functions at the top level.
 * @returns A function that can be used as a Vercel API route.
 */
export function workflowEntrypoint(
  workflowCode: string,
  options?: { namespace?: string; basePath?: string }
): (req: Request) => Promise<Response> {
  setWorkflowBasePath(options?.basePath);

  const namespace = resolveQueueNamespace(options?.namespace);
  const workflowPrefix = getQueueTopicPrefix('workflow', namespace);

  const { createQueueHandler, specVersion: worldSpecVersion } =
    getWorldHandlers();
  const handler = createQueueHandler(
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
          worldSpecVersion
        );
        return;
      }

      const {
        runId,
        traceCarrier: traceContext,
        requestedAt,
        replayDivergence,
        runInput,
      } = WorkflowInvokePayloadSchema.parse(message_);
      const { requestId } = metadata;
      // Extract the workflow name from the topic name
      const workflowName = metadata.queueName.slice(workflowPrefix.length);

      // --- Max delivery check ---
      // Enforce max delivery limit before any infrastructure calls.
      // This prevents runaway workflows from consuming infinite queue deliveries.
      // At this point, we want to do the minimal amount of work (no fetching
      // of the workflow events, etc. We simply attempt to mark the run as failed
      // and if that fails, the message is still consumed but with adequate logging
      // that an error occurred preventing us from failing the run.
      if (metadata.attempt > MAX_QUEUE_DELIVERIES) {
        runtimeLogger.error(
          `Workflow handler exceeded max deliveries (${metadata.attempt}/${MAX_QUEUE_DELIVERIES})`,
          { workflowRunId: runId, workflowName, attempt: metadata.attempt }
        );
        try {
          const world = getWorld();
          await world.events.create(
            runId,
            {
              eventType: 'run_failed',
              specVersion: SPEC_VERSION_CURRENT,
              eventData: {
                error: {
                  message: `Workflow exceeded maximum queue deliveries (${metadata.attempt}/${MAX_QUEUE_DELIVERIES})`,
                },
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
          runtimeLogger.error(
            `Failed to mark run as failed after ${metadata.attempt} delivery attempts. ` +
              `A persistent error is preventing the run from being terminated. ` +
              `The run will remain in its current state until manually resolved. ` +
              `This is most likely due to a persistent outage of the workflow backend ` +
              `or a bug in the workflow runtime and should be reported to the Workflow team.`,
            {
              workflowRunId: runId,
              error: err instanceof Error ? err.message : String(err),
              attempt: metadata.attempt,
            }
          );
        }
        return;
      }

      const spanLinks = await linkToCurrentContext();

      // --- Replay timeout guard ---
      // If the replay takes longer than the timeout, fail the run and exit.
      // This must be lower than the function's maxDuration to ensure
      // the failure is recorded before the platform kills the function.
      let replayTimeout: NodeJS.Timeout | undefined;
      if (process.env.VERCEL_URL !== undefined) {
        replayTimeout = setTimeout(async () => {
          runtimeLogger.error('Workflow replay exceeded timeout', {
            workflowRunId: runId,
            timeoutMs: REPLAY_TIMEOUT_MS,
            attempt: metadata.attempt,
            maxRetries: REPLAY_TIMEOUT_MAX_RETRIES,
          });

          // Allow a few retries before permanently failing the run.
          // On early attempts, just exit so the queue retries the message.
          if (metadata.attempt <= REPLAY_TIMEOUT_MAX_RETRIES) {
            process.exit(1);
          }

          try {
            const world = await getWorld();
            await world.events.create(
              runId,
              {
                eventType: 'run_failed',
                specVersion: SPEC_VERSION_CURRENT,
                eventData: {
                  error: {
                    message: `Workflow replay exceeded maximum duration (${REPLAY_TIMEOUT_MS / 1000}s) after ${metadata.attempt} attempts`,
                  },
                  errorCode: RUN_ERROR_CODES.REPLAY_TIMEOUT,
                },
              },
              { requestId }
            );
          } catch {
            // Best effort — process exits regardless
          }
          // Note that this also prevents the runtime from acking the queue message,
          // so the queue will call back once, after which a 410 will get it to exit early.
          process.exit(1);
        }, REPLAY_TIMEOUT_MS);
        replayTimeout.unref();
      }

      // Invoke user workflow within the propagated trace context and baggage
      return await withTraceContext(traceContext, async () => {
        // Set workflow context as baggage for automatic propagation
        return await withWorkflowBaggage(
          { workflowRunId: runId, workflowName },
          async () => {
            const world = getWorld();
            return trace(
              `WORKFLOW ${workflowName}`,
              { links: spanLinks },
              async (span) => {
                span?.setAttributes({
                  ...Attribute.WorkflowName(workflowName),
                  ...Attribute.WorkflowOperation('execute'),
                  // Standard OTEL messaging conventions
                  ...Attribute.MessagingSystem('vercel-queue'),
                  ...Attribute.MessagingDestinationName(metadata.queueName),
                  ...Attribute.MessagingMessageId(metadata.messageId),
                  ...Attribute.MessagingOperationType('process'),
                  ...getQueueOverhead({ requestedAt }),
                });

                // TODO: validate `workflowName` exists before consuming message?

                span?.setAttributes({
                  ...Attribute.WorkflowRunId(runId),
                  ...Attribute.WorkflowTracePropagated(!!traceContext),
                });

                let workflowStartedAt = -1;
                let workflowRun: WorkflowRun | undefined;
                // Server-supplied per-run event ceiling from the run_started
                // response. Undefined ⇒ no enforcement (older servers).
                let maxEventsLimit: number | undefined;
                // Pre-loaded events from the run_started response.
                // When present, we skip the events.list call.
                let preloadedEvents: Event[] | undefined;
                let preloadedEventsCursor: string | null | undefined;

                // --- Infrastructure: prepare the run state ---
                // Always call run_started directly — this both transitions
                // the run to 'running' AND returns the run entity, saving
                // a separate runs.get round-trip.
                // Contract: events.create('run_started') must be idempotent
                // for runs already in 'running' status (return the run
                // without error), not just for pending → running transitions.
                // Network/server errors propagate to the queue handler for retry.
                // WorkflowRuntimeError (data integrity issues) are fatal and
                // produce run_failed since retrying won't fix them.
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
                  maxEventsLimit = clampMaxEvents(result.maxEvents);

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
                  if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
                    // EntityConflictError: run was concurrently
                    // completed/failed/cancelled during setup.
                    // RunExpiredError: run already in terminal state.
                    // In both cases, skip processing this message.
                    runtimeLogger.info(
                      'Run already finished during setup, skipping',
                      { workflowRunId: runId, message: err.message }
                    );
                    return;
                  } else if (err instanceof WorkflowRuntimeError) {
                    runtimeLogger.error(
                      'Fatal runtime error during workflow setup',
                      { workflowRunId: runId, error: err.message }
                    );
                    try {
                      await world.events.create(
                        runId,
                        {
                          eventType: 'run_failed',
                          specVersion: SPEC_VERSION_CURRENT,
                          eventData: {
                            error: {
                              message: err.message,
                              stack: err.stack,
                            },
                            errorCode: RUN_ERROR_CODES.RUNTIME_ERROR,
                          },
                        },
                        { requestId }
                      );
                    } catch (failErr) {
                      if (
                        EntityConflictError.is(failErr) ||
                        RunExpiredError.is(failErr)
                      ) {
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
                    return;
                  } else if (isWorldContractError(err)) {
                    runtimeLogger.error(
                      'Fatal world contract error during workflow setup',
                      {
                        workflowRunId: runId,
                        errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
                        error: err.message,
                      }
                    );
                    try {
                      await world.events.create(
                        runId,
                        {
                          eventType: 'run_failed',
                          specVersion: SPEC_VERSION_CURRENT,
                          eventData: {
                            error: {
                              message: err.message,
                              stack: err.stack,
                            },
                            errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
                          },
                        },
                        { requestId }
                      );
                    } catch (failErr) {
                      if (
                        EntityConflictError.is(failErr) ||
                        RunExpiredError.is(failErr)
                      ) {
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
                    return;
                  } else {
                    throw err;
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

                // Load all events into memory before running.
                // If we got pre-loaded events from the run_started response,
                // skip the events.list round-trip to reduce TTFB.
                let events: Event[];
                let eventsCursor: string | null | undefined;
                try {
                  if (preloadedEvents) {
                    events = preloadedEvents;
                    eventsCursor = preloadedEventsCursor;
                  } else {
                    const loadedEvents = await getWorkflowRunEvents(
                      workflowRun.runId
                    );
                    events = loadedEvents.events;
                    eventsCursor = loadedEvents.cursor;
                  }
                } catch (err) {
                  if (isWorldContractError(err)) {
                    runtimeLogger.error(
                      'Fatal world contract error while loading workflow events',
                      {
                        workflowRunId: runId,
                        errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
                        error: err.message,
                      }
                    );
                    try {
                      await world.events.create(
                        runId,
                        {
                          eventType: 'run_failed',
                          specVersion: SPEC_VERSION_CURRENT,
                          eventData: {
                            error: {
                              message: err.message,
                              stack: err.stack,
                            },
                            errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
                          },
                        },
                        { requestId }
                      );
                    } catch (failErr) {
                      if (
                        EntityConflictError.is(failErr) ||
                        RunExpiredError.is(failErr)
                      ) {
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
                    return;
                  }
                  throw err;
                }

                // The materialized run returned by run_started can race a
                // terminal event in the loaded snapshot. Do not replay a run
                // whose event log already establishes its terminal outcome.
                if (hasRecordedTerminalRunEvent(events, runId)) {
                  return;
                }

                // Check for any elapsed waits and create wait_completed events
                const now = Date.now();

                // Pre-compute completed correlation IDs for O(n) lookup instead of O(n²)
                const completedWaitIds = new Set(
                  events
                    .filter((e) => e.eventType === 'wait_completed')
                    .map((e) => e.correlationId)
                );

                // Collect all waits that need completion
                const waitsToComplete = events
                  .filter(
                    (
                      e
                    ): e is Extract<Event, { eventType: 'wait_created' }> & {
                      correlationId: string;
                    } =>
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

                // Create all wait_completed events
                for (const waitEvent of waitsToComplete) {
                  const waitLog: MutableEventLog = {
                    events,
                    cursor: eventsCursor ?? null,
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
                      runtimeLogger.info('Wait already completed, skipping', {
                        workflowRunId: runId,
                        correlationId: waitEvent.correlationId,
                      });
                      continue;
                    }
                    throw err;
                  } finally {
                    // Reloads inside the guard may have advanced the cursor.
                    eventsCursor = waitLog.cursor;
                  }
                }

                if (waitsToComplete.length > 0) {
                  // The event list above may be stale by the time an elapsed
                  // wait is committed. Load only events after the original
                  // snapshot cursor so concurrent durable events, such as
                  // hook_received, keep their ordering relative to
                  // wait_completed. Fall back to a full reload for older worlds
                  // that cannot give us a stable cursor.
                  if (eventsCursor) {
                    const newEvents = await getWorkflowRunEvents(
                      workflowRun.runId,
                      eventsCursor
                    );
                    const completedWaitIdsAfterCursor = new Set(
                      newEvents.events
                        .filter((e) => e.eventType === 'wait_completed')
                        .map((e) => e.correlationId)
                    );
                    const sawAllWaitCompletions = waitsToComplete.every(
                      (waitEvent) =>
                        completedWaitIdsAfterCursor.has(waitEvent.correlationId)
                    );

                    if (sawAllWaitCompletions) {
                      const existingIds = new Set(
                        events.map((event) => event.eventId)
                      );
                      for (const event of newEvents.events) {
                        if (!existingIds.has(event.eventId)) {
                          existingIds.add(event.eventId);
                          events.push(event);
                        }
                      }
                    } else {
                      const loadedEvents = await getWorkflowRunEvents(
                        workflowRun.runId
                      );
                      events = loadedEvents.events;
                    }
                  } else {
                    const loadedEvents = await getWorkflowRunEvents(
                      workflowRun.runId
                    );
                    events = loadedEvents.events;
                  }

                  // A concurrent terminal write may have landed while
                  // committing an elapsed wait and refreshing the snapshot.
                  if (hasRecordedTerminalRunEvent(events, runId)) {
                    return;
                  }
                }

                // Resolve the encryption key for this run's deployment
                const rawKey =
                  await world.getEncryptionKeyForRun?.(workflowRun);
                const encryptionKey = rawKey
                  ? await importKey(rawKey)
                  : undefined;

                // --- User code execution ---
                // Only errors from runWorkflow() (user workflow code) should
                // produce run_failed. Infrastructure errors (network, server)
                // must propagate to the queue handler for automatic retry.
                let workflowResult: unknown;
                try {
                  // Event-limit guard: fail a runaway run once its log
                  // reaches the server-supplied ceiling (undefined ⇒ no
                  // enforcement). The throw is caught below and written as
                  // run_failed / MAX_EVENTS_EXCEEDED.
                  if (
                    maxEventsLimit !== undefined &&
                    events.length >= maxEventsLimit
                  ) {
                    throw new MaxEventsExceededError(
                      events.length,
                      maxEventsLimit
                    );
                  }

                  workflowResult = await trace(
                    'workflow.replay',
                    {},
                    async (replaySpan) => {
                      replaySpan?.setAttributes({
                        ...Attribute.WorkflowEventsCount(events.length),
                      });
                      return await runWorkflow(
                        workflowCode,
                        workflowRun,
                        events,
                        encryptionKey
                      );
                    }
                  );
                } catch (err) {
                  // WorkflowSuspension is normal control flow — not an error
                  if (WorkflowSuspension.is(err)) {
                    const suspensionMessage = buildWorkflowSuspensionMessage(
                      runId,
                      err.stepCount,
                      err.hookCount,
                      err.waitCount
                    );
                    if (suspensionMessage) {
                      runtimeLogger.debug(suspensionMessage);
                    }

                    // Each event creation inside handleSuspension carries the
                    // loaded snapshot's `stateUpdatedAt`; on a stale (412)
                    // rejection the guard reloads this log in place and retries.
                    const suspensionLog: MutableEventLog = {
                      events,
                      cursor: eventsCursor ?? null,
                    };
                    let result: Awaited<ReturnType<typeof handleSuspension>>;
                    try {
                      result = await handleSuspension({
                        suspension: err,
                        world,
                        run: workflowRun,
                        span,
                        requestId,
                        eventLog: suspensionLog,
                      });
                    } catch (suspensionError) {
                      // The guard exhausted its reloads on a stale event
                      // creation. Schedule an explicit immediate re-invocation
                      // (a rethrow relies on queue redelivery) so a fresh
                      // replay observes the newer event.
                      if (PreconditionFailedError.is(suspensionError)) {
                        runtimeLogger.info(
                          'Suspension event creation exhausted precondition retries; re-invoking with a fresh replay',
                          { workflowRunId: runId }
                        );
                        return { timeoutSeconds: 0 };
                      }
                      throw suspensionError;
                    }

                    if (result.timeoutSeconds !== undefined) {
                      return { timeoutSeconds: result.timeoutSeconds };
                    }

                    // Suspension handled, no further work needed
                    return;
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
                    runtimeLogger.warn(
                      'Transient world error during replay; redelivering via queue instead of failing the run',
                      {
                        errorName:
                          err instanceof Error ? err.name : 'UnknownError',
                        errorMessage:
                          err instanceof Error ? err.message : String(err),
                        deliveryAttempt: metadata.attempt,
                      }
                    );
                    throw err;
                  }

                  let terminalError = err;
                  if (ReplayDivergenceError.is(err)) {
                    const divergenceCount = (replayDivergence?.count ?? 0) + 1;

                    if (divergenceCount <= REPLAY_DIVERGENCE_MAX_RETRIES) {
                      runtimeLogger.warn(
                        'Workflow replay diverged; queueing a recovery replay before declaring the event log corrupted',
                        {
                          workflowRunId: runId,
                          errorCode: RUN_ERROR_CODES.REPLAY_DIVERGENCE,
                          divergenceEventId: err.eventId,
                          priorDivergenceEventId: replayDivergence?.eventId,
                          divergenceCount,
                          deliveryAttempt: metadata.attempt,
                          maxRecoveryReplays: REPLAY_DIVERGENCE_MAX_RETRIES,
                          errorMessage: err.message,
                        }
                      );
                      await queueMessage(
                        world,
                        getWorkflowQueueName(workflowName, namespace),
                        {
                          runId,
                          traceCarrier: traceContext,
                          requestedAt: new Date(),
                          replayDivergence: {
                            eventId: err.eventId,
                            count: divergenceCount,
                          },
                        },
                        {
                          deploymentId: workflowRun.deploymentId,
                          specVersion:
                            workflowRun.specVersion ?? SPEC_VERSION_LEGACY,
                        }
                      );
                      return;
                    }

                    terminalError = new CorruptedEventLogError(
                      `Workflow replay diverged ${divergenceCount} times after ${REPLAY_DIVERGENCE_MAX_RETRIES} recovery replays; latest divergent event was ${err.eventId}. Last divergence: ${err.message}`,
                      { cause: err }
                    );
                  }

                  // This is a user code error or a terminal
                  // WorkflowRuntimeError. Fail the workflow run.

                  // Record exception for OTEL error tracking
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

                  // Remap error stack using source maps to show original source locations
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

                  // Fail the workflow run via event (event-sourced architecture)
                  try {
                    await world.events.create(
                      runId,
                      {
                        eventType: 'run_failed',
                        specVersion: SPEC_VERSION_CURRENT,
                        eventData: {
                          error: {
                            message: errorMessage,
                            stack: errorStack,
                          },
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
                      span?.setAttributes({
                        ...Attribute.WorkflowErrorCode(errorCode),
                        ...Attribute.WorkflowErrorName(errorName),
                        ...Attribute.WorkflowErrorMessage(errorMessage),
                        ...Attribute.ErrorType(errorName),
                      });
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

                // --- Infrastructure: complete the run ---
                // This is outside the user-code try/catch so that failures
                // here (e.g., network errors) propagate to the queue handler.
                // run_completed carries the loaded snapshot's `stateUpdatedAt`,
                // but is intentionally NOT retried in place (no
                // withPreconditionRetry) on a stale (412) rejection: `result`
                // was computed by this replay, so a newer out-of-band event
                // landing after the snapshot must force a *fresh replay*
                // (which may observe it and produce a different result), not
                // re-commit the stale result. On 412 the catch below schedules
                // an explicit immediate re-invocation instead.
                // (run_failed is deliberately left unguarded and fails open:
                // a spurious re-run is safe, a spurious completion is not, and
                // the loaded event log is not in scope on that catch path.)
                try {
                  await world.events.create(
                    runId,
                    {
                      eventType: 'run_completed',
                      specVersion: SPEC_VERSION_CURRENT,
                      eventData: {
                        output: workflowResult,
                      },
                    },
                    {
                      requestId,
                      stateUpdatedAt: stateUpdatedAtForCreate(events),
                    }
                  );
                } catch (err) {
                  if (PreconditionFailedError.is(err)) {
                    runtimeLogger.info(
                      'run_completed rejected as stale; re-invoking with a fresh replay',
                      { workflowRunId: runId }
                    );
                    return { timeoutSeconds: 0 };
                  }
                  if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
                    runtimeLogger.info(
                      'Tried completing workflow run, but run has already finished.',
                      {
                        workflowRunId: runId,
                        message: err.message,
                      }
                    );
                    return;
                  } else {
                    throw err;
                  }
                }

                span?.setAttributes({
                  ...Attribute.WorkflowRunStatus('completed'),
                  ...Attribute.WorkflowEventsCount(events.length),
                });
              }
            ); // End trace
          }
        ); // End withWorkflowBaggage
      }).finally(() => {
        if (replayTimeout) {
          clearTimeout(replayTimeout);
        }
      }); // End withTraceContext
    }
  );

  return withHealthCheck(handler, worldSpecVersion);
}

// this is a no-op placeholder as the client is
// expecting this to be present but we aren't actually using it
export function runStep() {}
