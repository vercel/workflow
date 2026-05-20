import { types } from 'node:util';
import {
  EntityConflictError,
  FatalError,
  RUN_ERROR_CODES,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
} from '@workflow/world';
import { classifyRunError } from './classify-error.js';
import { describeError } from './describe-error.js';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import {
  MAX_QUEUE_DELIVERIES,
  REPLAY_TIMEOUT_MAX_RETRIES,
  REPLAY_TIMEOUT_MS,
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
import { executeStep } from './runtime/step-executor.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import {
  getWorld,
  getWorldHandlers,
  type WorldHandlers,
} from './runtime/world.js';
import { dehydrateRunError } from './serialization.js';
import { remapErrorStack } from './source-map.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import {
  linkToCurrentContext,
  serializeTraceCarrier,
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
  workflowCode: string
): (req: Request) => Promise<Response> {
  const NO_INLINE_REPLAY_AFTER_MS =
    Number(process.env.WORKFLOW_V2_TIMEOUT_MS) || 120_000;

  const handler = (worldHandlers: WorldHandlers) =>
    worldHandlers.createQueueHandler(
      '__wkf_workflow_',
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
          traceCarrier: traceContext,
          requestedAt,
          stepId: incomingStepId,
          stepName: incomingStepName,
          runInput,
        } = WorkflowInvokePayloadSchema.parse(message_);
        const { requestId } = metadata;
        const workflowName = metadata.queueName.slice('__wkf_workflow_'.length);

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

        const spanLinks = await linkToCurrentContext();

        // --- Replay timeout guard ---
        // If the replay takes longer than the timeout, fail the run and exit.
        // This must be lower than the function's maxDuration to ensure
        // the failure is recorded before the platform kills the function.
        let replayTimeout: NodeJS.Timeout | undefined;
        if (process.env.VERCEL_URL !== undefined) {
          replayTimeout = setTimeout(async () => {
            // Allow a few retries before permanently failing the run.
            // On early attempts, just exit so the queue retries the message.
            if (metadata.attempt <= REPLAY_TIMEOUT_MAX_RETRIES) {
              runLogger.warn(
                'Workflow replay exceeded timeout but will be re-attempted (attempt < maxRetries)',
                {
                  timeoutMs: REPLAY_TIMEOUT_MS,
                  attempt: metadata.attempt,
                  maxRetries: REPLAY_TIMEOUT_MAX_RETRIES,
                }
              );
              process.exit(1);
            }

            const replayTimeoutDescription = describeError(
              undefined,
              RUN_ERROR_CODES.REPLAY_TIMEOUT
            );
            runLogger.error(
              'Workflow replay exceeded timeout and max retries exceeded. Failing the run',
              {
                timeoutMs: REPLAY_TIMEOUT_MS,
                attempt: metadata.attempt,
                maxRetries: REPLAY_TIMEOUT_MAX_RETRIES,
                errorCode: replayTimeoutDescription.errorCode,
                errorAttribution: replayTimeoutDescription.attribution,
              }
            );

            try {
              const world = await getWorld();
              const getEncryptionKey = memoizeEncryptionKey(world, runId);
              const timeoutErr = new FatalError(
                `Workflow replay exceeded maximum duration (${REPLAY_TIMEOUT_MS / 1000}s) after ${metadata.attempt} attempts`
              );
              await world.events.create(
                runId,
                {
                  eventType: 'run_failed',
                  specVersion: SPEC_VERSION_CURRENT,
                  eventData: {
                    error: await dehydrateRunError(
                      timeoutErr,
                      runId,
                      await getEncryptionKey()
                    ),
                    errorCode: RUN_ERROR_CODES.REPLAY_TIMEOUT,
                  },
                },
                { requestId }
              );
            } catch (err) {
              // Best effort — process exits regardless. Surface why so
              // operators can diagnose repeat timeouts against the backend.
              runLogger.warn(
                'Unable to mark run as failed. The queue will continue to retry',
                {
                  attempt: metadata.attempt,
                  errorName: err instanceof Error ? err.name : 'UnknownError',
                  errorMessage:
                    err instanceof Error ? err.message : String(err),
                  errorStack: err instanceof Error ? err.stack : undefined,
                }
              );
            }
            // Note that this also prevents the runtime from acking the queue message,
            // so the queue will call back once, after which a 410 will get it to exit early.
            process.exit(1);
          }, REPLAY_TIMEOUT_MS);
          replayTimeout.unref();
        }

        return await withTraceContext(traceContext, async () => {
          return await withWorkflowBaggage(
            { workflowRunId: runId, workflowName },
            async () => {
              const world = await getWorld();
              return trace(
                `WORKFLOW_V2 ${workflowName}`,
                { links: spanLinks },
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
                  });

                  const invocationStartTime = Date.now();
                  let loopIteration = 0;

                  // Event cache: keep loaded events in memory across loop iterations.
                  // On the first iteration we do a full load; on subsequent iterations
                  // we fetch only events created after the last known cursor.
                  let cachedEvents: Event[] | null = null;
                  let eventsCursor: string | null = null;

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
                    const stepResult = await executeStep({
                      world,
                      workflowRunId: runId,
                      workflowName,
                      workflowStartedAt: bgStartedAt,
                      stepId: incomingStepId,
                      stepName: incomingStepName,
                    });
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
                        getWorkflowQueueName(workflowName),
                        {
                          runId,
                          traceCarrier: await serializeTraceCarrier(),
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
                      } else if (err instanceof WorkflowRuntimeError) {
                        runtimeLogger.error(
                          'Fatal runtime error during workflow setup',
                          { workflowRunId: runId, error: err.message }
                        );
                        try {
                          const getEncryptionKey = memoizeEncryptionKey(
                            world,
                            runId
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
                        getWorkflowQueueName(workflowName),
                        {
                          runId,
                          traceCarrier: await serializeTraceCarrier(),
                          requestedAt: new Date(),
                        }
                      );
                      return;
                    }

                    let replayStart = 0;
                    try {
                      // Load events — use cached events with incremental fetch on subsequent iterations.
                      // The server always returns a cursor when there are events (even on the
                      // final page), so we can reliably use it for incremental loading.
                      let events: Event[];
                      if (cachedEvents === null) {
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
                      // Terminal run events are always last by construction
                      // (no event creation succeeds against a terminal run),
                      // but scan the full array for defense-in-depth: a
                      // World/backend ordering bug shouldn't make us miss
                      // an actual termination signal.
                      const terminalRunEvent = events.find(
                        (e) =>
                          e.eventType === 'run_completed' ||
                          e.eventType === 'run_failed' ||
                          e.eventType === 'run_cancelled'
                      );
                      if (terminalRunEvent) {
                        runtimeLogger.debug(
                          'Run completed by concurrent handler, exiting',
                          {
                            workflowRunId: runId,
                            eventType: terminalRunEvent.eventType,
                          }
                        );
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

                      // Update cache reference (may have been set for first time)
                      cachedEvents = events;

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
                        const suspensionResult = await handleSuspension({
                          suspension: err,
                          world,
                          run: workflowRun,
                          span,
                          requestId,
                        });
                        runtimeLogger.debug('Suspension handled', {
                          workflowRunId: runId,
                          suspensionMs: Date.now() - suspensionStart,
                          pendingSteps: suspensionResult.pendingSteps.length,
                          timeoutSeconds: suspensionResult.timeoutSeconds,
                          hasHookConflict: suspensionResult.hasHookConflict,
                        });

                        // Hook conflict: break loop, re-invoke via queue
                        if (suspensionResult.hasHookConflict) {
                          return { timeoutSeconds: 0 };
                        }

                        const pendingSteps = suspensionResult.pendingSteps;

                        if (pendingSteps.length === 0) {
                          // No steps — only waits/hooks
                          if (suspensionResult.timeoutSeconds !== undefined) {
                            return {
                              timeoutSeconds: suspensionResult.timeoutSeconds,
                            };
                          }
                          return;
                        }

                        // Inline execution is gated on ownership: only the
                        // handler that actually wrote the step_created event
                        // may run the step body inline. The world-level
                        // step_created is atomic per-correlationId, so
                        // exactly one handler owns each step — concurrent
                        // handlers can't race on step execution.
                        const ownedPendingSteps = pendingSteps.filter((s) =>
                          suspensionResult.createdStepCorrelationIds.has(
                            s.correlationId
                          )
                        );

                        // Pick one owned step to execute inline (if any).
                        // The rest of the pending steps are queued below.
                        //
                        // Skip inline execution entirely when the suspension
                        // also has a pending wait (sleep): an inline `await
                        // executeStep(...)` blocks the handler for the full
                        // step duration, so the wait timer never has a chance
                        // to fire on time. That defeats `Promise.race(step,
                        // sleep)` semantics — if the sleep is shorter than
                        // the step, replay still picks the step because
                        // wait_completed is only created on the *next* loop
                        // iteration, which doesn't run until the step
                        // finishes. Queueing every step in this case lets
                        // the wait timeout drive a continuation in parallel,
                        // matching V1's behavior where each step ran in a
                        // separate function invocation.
                        const inlineStep:
                          | (typeof pendingSteps)[number]
                          | undefined =
                          suspensionResult.timeoutSeconds === undefined
                            ? ownedPendingSteps[0]
                            : undefined;

                        // Queue every pending step except the one we're
                        // executing inline. This mirrors V1's unconditional
                        // enqueue-with-idempotency pattern and is what makes
                        // crash recovery work: if a prior handler wrote
                        // step_created events but crashed before enqueuing,
                        // a later handler (e.g., from flow-message
                        // redelivery or reenqueueActiveRuns) will enqueue
                        // the orphaned steps. In the happy path with a
                        // single owner, concurrent handlers' queue attempts
                        // dedupe on correlationId. Skipping the inline step
                        // avoids a queue handler racing against our own
                        // inline executor.
                        for (const step of pendingSteps) {
                          if (
                            inlineStep &&
                            step.correlationId === inlineStep.correlationId
                          ) {
                            continue;
                          }
                          const traceCarrier = await serializeTraceCarrier();
                          await queueMessage(
                            world,
                            getWorkflowQueueName(workflowName),
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
                          );
                        }

                        // Nothing to execute inline — we already queued all
                        // pending steps above, exit and let the queue drive.
                        if (!inlineStep) {
                          if (suspensionResult.timeoutSeconds !== undefined) {
                            return {
                              timeoutSeconds: suspensionResult.timeoutSeconds,
                            };
                          }
                          return;
                        }

                        // Execute inline step
                        const stepResult = await executeStep({
                          world,
                          workflowRunId: runId,
                          workflowName,
                          workflowStartedAt,
                          stepId: inlineStep.correlationId,
                          stepName: inlineStep.stepName,
                        });

                        if (stepResult.type === 'retry') {
                          // Step needs retry — queue self with stepId for retry
                          const traceCarrier = await serializeTraceCarrier();
                          await queueMessage(
                            world,
                            getWorkflowQueueName(workflowName),
                            {
                              runId,
                              stepId: inlineStep.correlationId,
                              stepName: inlineStep.stepName,
                              traceCarrier,
                              requestedAt: new Date(),
                            },
                            {
                              delaySeconds: stepResult.timeoutSeconds,
                            }
                          );
                          // If there are also waits, return their timeout
                          if (suspensionResult.timeoutSeconds !== undefined) {
                            return {
                              timeoutSeconds: suspensionResult.timeoutSeconds,
                            };
                          }
                          return;
                        }

                        if (stepResult.type === 'throttled') {
                          return {
                            timeoutSeconds: stepResult.timeoutSeconds,
                          };
                        }

                        // Step completed or failed — loop back to replay
                        // (gone/skipped also loop back since the workflow
                        // will see the completed/failed event on replay)

                        // If the step had pending background ops (e.g., stream
                        // writes to S3), break the loop and return so waitUntil
                        // can flush them. This matches V1 behavior where each
                        // step ran in a separate function invocation. Without
                        // this, the inline loop continues and the stream data
                        // may not reach S3 before the test tries to read it.
                        if (
                          stepResult.type === 'completed' &&
                          stepResult.hasPendingOps
                        ) {
                          runtimeLogger.debug(
                            'Breaking loop: step has pending ops',
                            {
                              workflowRunId: runId,
                              loopIteration,
                              stepName: inlineStep.stepName,
                            }
                          );
                          await queueMessage(
                            world,
                            getWorkflowQueueName(workflowName),
                            {
                              runId,
                              traceCarrier: await serializeTraceCarrier(),
                              requestedAt: new Date(),
                            }
                          );
                          return;
                        }

                        if (
                          suspensionResult.timeoutSeconds !== undefined &&
                          pendingSteps.length === 1
                        ) {
                          // Only 1 step and there's also waits/hooks,
                          // step is done, but we need the wait timeout
                          // Loop back to replay which will re-evaluate
                        }
                      } else {
                        // User code error from runWorkflow — create run_failed.
                        if (err instanceof Error) {
                          span?.recordException?.(err);
                        }

                        const normalizedError =
                          await normalizeUnknownError(err);
                        const errorName =
                          normalizedError.name || getErrorName(err);
                        const errorMessage = normalizedError.message;
                        let errorStack =
                          normalizedError.stack || getErrorStack(err);

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

                        // Classify the error: WorkflowRuntimeError indicates an
                        // internal issue (corrupted event log, missing data);
                        // everything else is a user code error.
                        const errorCode = classifyRunError(err);

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
                        if (types.isNativeError(err) && errorStack) {
                          (err as Error).stack = errorStack;
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
                                  err,
                                  runId,
                                  encryptionKey
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
        }).finally(() => {
          if (replayTimeout) {
            clearTimeout(replayTimeout);
          }
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
