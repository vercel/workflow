import {
  EntityConflictError,
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
import { importKey } from './encryption.js';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import {
  MAX_QUEUE_DELIVERIES,
  REPLAY_TIMEOUT_MS,
} from './runtime/constants.js';
import {
  getAllWorkflowRunEvents,
  getQueueOverhead,
  handleHealthCheckMessage,
  parseHealthCheckPayload,
  withHealthCheck,
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
 * Function that creates a single route which handles any workflow execution
 * request and routes to the appropriate workflow function.
 *
 * @param workflowCode - The workflow bundle code containing all the workflow
 * functions at the top level.
 * @returns A function that can be used as a Vercel API route.
 */
export function workflowEntrypoint(
  workflowCode: string
): (req: Request) => Promise<Response> {
  const handler = getWorldHandlers().createQueueHandler(
    '__wkf_workflow_',
    async (message_, metadata) => {
      // Check if this is a health check message
      // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
      // They only write a simple status response to a stream and do not expose sensitive data.
      // The stream name includes a unique correlationId that must be known by the caller.
      const healthCheck = parseHealthCheckPayload(message_);
      if (healthCheck) {
        await handleHealthCheckMessage(healthCheck, 'workflow');
        return;
      }

      const {
        runId,
        traceCarrier: traceContext,
        requestedAt,
      } = WorkflowInvokePayloadSchema.parse(message_);
      const { requestId } = metadata;
      // Extract the workflow name from the topic name
      const workflowName = metadata.queueName.slice('__wkf_workflow_'.length);

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
          });
          try {
            const world = getWorld();
            await world.events.create(
              runId,
              {
                eventType: 'run_failed',
                specVersion: SPEC_VERSION_CURRENT,
                eventData: {
                  error: {
                    message: `Workflow replay exceeded maximum duration (${REPLAY_TIMEOUT_MS / 1000}s)`,
                  },
                  errorCode: RUN_ERROR_CODES.REPLAY_TIMEOUT,
                },
              },
              { requestId }
            );
          } catch {
            // Best effort — process exits regardless
          }
          // Note that this also prevents the runtime to acking the queue message,
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
                // Pre-loaded events from the run_started response.
                // When present, we skip the events.list call to reduce TTFB.
                let preloadedEvents: Event[] | undefined;

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
                      specVersion: SPEC_VERSION_CURRENT,
                    },
                    { requestId }
                  );
                  if (!result.run) {
                    throw new WorkflowRuntimeError(
                      `Event creation for 'run_started' did not return the run entity for run "${runId}"`
                    );
                  }
                  workflowRun = result.run;

                  // If the world returned events, use them to skip
                  // the initial events.list call and reduce TTFB.
                  if (result.events && result.events.length > 0) {
                    preloadedEvents = result.events;
                  }

                  if (!workflowRun.startedAt) {
                    throw new WorkflowRuntimeError(
                      `Workflow run "${runId}" has no "startedAt" timestamp`
                    );
                  }
                } catch (err) {
                  // Run was concurrently completed/failed/cancelled
                  if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
                    runtimeLogger.info(
                      'Run already finished during setup, skipping',
                      { workflowRunId: runId, message: err.message }
                    );
                    return;
                  }
                  if (err instanceof WorkflowRuntimeError) {
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
                      throw failErr;
                    }
                    return;
                  }
                  throw err;
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
                const events =
                  preloadedEvents ??
                  (await getAllWorkflowRunEvents(workflowRun.runId));

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
                    (e): e is typeof e & { correlationId: string } =>
                      e.eventType === 'wait_created' &&
                      e.correlationId !== undefined &&
                      !completedWaitIds.has(e.correlationId) &&
                      now >= (e.eventData.resumeAt as Date).getTime()
                  )
                  .map((e) => ({
                    eventType: 'wait_completed' as const,
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: e.correlationId,
                  }));

                // Create all wait_completed events
                for (const waitEvent of waitsToComplete) {
                  try {
                    const result = await world.events.create(runId, waitEvent, {
                      requestId,
                    });
                    // Add the event to the events array so the workflow can see it
                    events.push(result.event!);
                  } catch (err) {
                    if (EntityConflictError.is(err)) {
                      runtimeLogger.info('Wait already completed, skipping', {
                        workflowRunId: runId,
                        correlationId: waitEvent.correlationId,
                      });
                      continue;
                    }
                    throw err;
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

                    const result = await handleSuspension({
                      suspension: err,
                      world,
                      run: workflowRun,
                      span,
                      requestId,
                    });

                    if (result.timeoutSeconds !== undefined) {
                      return { timeoutSeconds: result.timeoutSeconds };
                    }

                    // Suspension handled, no further work needed
                    return;
                  }

                  // This is a user code error or a WorkflowRuntimeError
                  // (e.g., corrupted event log). Fail the workflow run.

                  // Record exception for OTEL error tracking
                  if (err instanceof Error) {
                    span?.recordException?.(err);
                  }

                  const normalizedError = await normalizeUnknownError(err);
                  const errorName = normalizedError.name || getErrorName(err);
                  const errorMessage = normalizedError.message;
                  let errorStack = normalizedError.stack || getErrorStack(err);

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
                    } else {
                      throw failErr;
                    }
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
                    { requestId }
                  );
                } catch (err) {
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

  return withHealthCheck(handler);
}

// this is a no-op placeholder as the client is
// expecting this to be present but we aren't actually using it
export function runStep() {}
