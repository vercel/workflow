import { WorkflowAPIError, WorkflowRuntimeError } from '@workflow/errors';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
} from '@workflow/world';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import {
  getAllWorkflowRunEvents,
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  parseHealthCheckPayload,
  queueMessage,
  withHealthCheck,
  withThrottleRetry,
} from './runtime/helpers.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { getWorld, getWorldHandlers } from './runtime/world.js';
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
export { type StartOptions, start } from './runtime/start.js';
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
        serverErrorRetryCount,
      } = WorkflowInvokePayloadSchema.parse(message_);
      // Extract the workflow name from the topic name
      const workflowName = metadata.queueName.slice('__wkf_workflow_'.length);
      const spanLinks = await linkToCurrentContext();

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

                return await withThrottleRetry(async () => {
                  let workflowStartedAt = -1;
                  try {
                    let workflowRun = await world.runs.get(runId);

                    if (workflowRun.status === 'pending') {
                      // Transition run to 'running' via event (event-sourced architecture)
                      const result = await world.events.create(runId, {
                        eventType: 'run_started',
                        specVersion: SPEC_VERSION_CURRENT,
                      });
                      // Use the run entity from the event response (no extra get call needed)
                      if (!result.run) {
                        throw new WorkflowRuntimeError(
                          `Event creation for 'run_started' did not return the run entity for run "${runId}"`
                        );
                      }
                      workflowRun = result.run;
                    }

                    // At this point, the workflow is "running" and `startedAt` should
                    // definitely be set.
                    if (!workflowRun.startedAt) {
                      throw new WorkflowRuntimeError(
                        `Workflow run "${runId}" has no "startedAt" timestamp`
                      );
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

                    // Load all events into memory before running
                    const events = await getAllWorkflowRunEvents(
                      workflowRun.runId
                    );

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
                        const result = await world.events.create(
                          runId,
                          waitEvent
                        );
                        // Add the event to the events array so the workflow can see it
                        events.push(result.event!);
                      } catch (err) {
                        if (WorkflowAPIError.is(err) && err.status === 409) {
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

                    const result = await trace(
                      'workflow.replay',
                      {},
                      async (replaySpan) => {
                        replaySpan?.setAttributes({
                          ...Attribute.WorkflowEventsCount(events.length),
                        });
                        // Resolve the encryption key for this run's deployment
                        const encryptionKey =
                          await world.getEncryptionKeyForRun?.(runId);
                        return await runWorkflow(
                          workflowCode,
                          workflowRun,
                          events,
                          encryptionKey
                        );
                      }
                    );

                    // Complete the workflow run via event (event-sourced architecture)
                    try {
                      await world.events.create(runId, {
                        eventType: 'run_completed',
                        specVersion: SPEC_VERSION_CURRENT,
                        eventData: {
                          output: result,
                        },
                      });
                    } catch (err) {
                      if (WorkflowAPIError.is(err) && err.status === 409) {
                        runtimeLogger.warn(
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
                  } catch (err) {
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
                        runId,
                        workflowName,
                        workflowStartedAt,
                        span,
                      });

                      if (result.timeoutSeconds !== undefined) {
                        return { timeoutSeconds: result.timeoutSeconds };
                      }
                    } else {
                      // Retry server errors (5xx) with exponential backoff before failing the run
                      if (
                        WorkflowAPIError.is(err) &&
                        err.status !== undefined &&
                        err.status >= 500
                      ) {
                        const retryCount = serverErrorRetryCount ?? 0;
                        const delaySecondSteps = [5, 30, 120]; // 5s, 30s, 120s
                        if (retryCount < delaySecondSteps.length) {
                          runtimeLogger.warn(
                            'Server error (5xx), re-enqueueing workflow with backoff',
                            {
                              workflowRunId: runId,
                              retryCount,
                              delaySeconds: delaySecondSteps[retryCount],
                              error: err.message,
                            }
                          );
                          await queueMessage(
                            world,
                            getWorkflowQueueName(workflowName),
                            {
                              runId,
                              serverErrorRetryCount: retryCount + 1,
                              traceCarrier: await serializeTraceCarrier(),
                              requestedAt: new Date(),
                            },
                            { delaySeconds: delaySecondSteps[retryCount] }
                          );
                          return; // Don't fail the run, retry later
                        }
                        // Fall through to run_failed after exhausting retries
                      } else if (
                        WorkflowAPIError.is(err) &&
                        err.status === 429
                      ) {
                        // Throw to let withThrottleRetry handle it
                        throw err;
                      }

                      // NOTE: this error could be an error thrown in user code, or could also be a WorkflowRuntimeError
                      // (for instance when the event log is corrupted, this is thrown by the event consumer). We could
                      // specially handle these if needed.

                      // Record exception for OTEL error tracking
                      if (err instanceof Error) {
                        span?.recordException?.(err);
                      }

                      const normalizedError = await normalizeUnknownError(err);
                      const errorName =
                        normalizedError.name || getErrorName(err);
                      const errorMessage = normalizedError.message;
                      let errorStack =
                        normalizedError.stack || getErrorStack(err);

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

                      runtimeLogger.error('Error while running workflow', {
                        workflowRunId: runId,
                        errorName,
                        errorStack,
                      });

                      // Fail the workflow run via event (event-sourced architecture)
                      try {
                        await world.events.create(runId, {
                          eventType: 'run_failed',
                          specVersion: SPEC_VERSION_CURRENT,
                          eventData: {
                            error: {
                              message: errorMessage,
                              stack: errorStack,
                            },
                            // TODO: include error codes when we define them
                          },
                        });
                      } catch (err) {
                        if (WorkflowAPIError.is(err) && err.status === 409) {
                          runtimeLogger.warn(
                            'Tried failing workflow run, but run has already finished.',
                            {
                              workflowRunId: runId,
                              message: err.message,
                            }
                          );
                          span?.setAttributes({
                            ...Attribute.WorkflowErrorName(errorName),
                            ...Attribute.WorkflowErrorMessage(errorMessage),
                            ...Attribute.ErrorType(errorName),
                          });
                          return;
                        } else {
                          throw err;
                        }
                      }

                      span?.setAttributes({
                        ...Attribute.WorkflowRunStatus('failed'),
                        ...Attribute.WorkflowErrorName(errorName),
                        ...Attribute.WorkflowErrorMessage(errorMessage),
                        ...Attribute.ErrorType(errorName),
                      });
                    }
                  }
                }); // End withThrottleRetry
              }
            ); // End trace
          }
        ); // End withWorkflowBaggage
      }); // End withTraceContext
    }
  );

  return withHealthCheck(handler);
}

// this is a no-op placeholder as the client is
// expecting this to be present but we aren't actually using it
export function runStep() {}
