import {
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from '@workflow/errors';
import {
  type Event,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
  type WorkflowRunStatus,
  type World,
} from '@workflow/world';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import { parseWorkflowName } from './parse-name.js';
import {
  getAllWorkflowRunEvents,
  getQueueOverhead,
  handleHealthCheckMessage,
  parseHealthCheckPayload,
  withHealthCheck,
} from './runtime/helpers.js';
import { handleSuspension } from './runtime/suspension-handler.js';
import { getWorld, getWorldHandlers } from './runtime/world.js';
import type { Serializable } from './schemas.js';
import {
  getExternalRevivers,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { remapErrorStack } from './source-map.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import { linkToCurrentContext, trace, withTraceContext } from './telemetry.js';
import { getErrorName, getErrorStack } from './types.js';
import {
  buildWorkflowSuspensionMessage,
  getWorkflowRunStreamId,
} from './util.js';
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
export { type StartOptions, start } from './runtime/start.js';
export { stepEntrypoint } from './runtime/step-handler.js';
export {
  createWorld,
  getWorld,
  getWorldHandlers,
  setWorld,
} from './runtime/world.js';

/**
 * Options for configuring a workflow's readable stream.
 */
export interface WorkflowReadableStreamOptions {
  /**
   * An optional namespace to distinguish between multiple streams associated
   * with the same workflow run.
   */
  namespace?: string;
  /**
   * The index number of the starting chunk to begin reading the stream from.
   */
  startIndex?: number;
  /**
   * Any asynchronous operations that need to be performed before the execution
   * environment is paused / terminated
   * (i.e. using [`waitUntil()`](https://developer.mozilla.org/docs/Web/API/ExtendableEvent/waitUntil) or similar).
   */
  ops?: Promise<any>[];
  /**
   * The global object to use for hydrating types from the global scope.
   *
   * Defaults to {@link [`globalThis`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/globalThis)}.
   */
  global?: Record<string, any>;
}

/**
 * A handler class for a workflow run.
 */
export class Run<TResult> {
  /**
   * The ID of the workflow run.
   */
  runId: string;

  /**
   * The world object.
   * @internal
   */
  private world: World;

  constructor(runId: string) {
    this.runId = runId;
    this.world = getWorld();
  }

  /**
   * Cancels the workflow run.
   */
  async cancel(): Promise<void> {
    await this.world.events.create(this.runId, {
      eventType: 'run_cancelled',
    });
  }

  /**
   * The status of the workflow run.
   */
  get status(): Promise<WorkflowRunStatus> {
    return this.world.runs.get(this.runId).then((run) => run.status);
  }

  /**
   * The return value of the workflow run.
   * Polls the workflow return value until it is completed.
   */
  get returnValue(): Promise<TResult> {
    return this.pollReturnValue();
  }

  /**
   * The name of the workflow.
   */
  get workflowName(): Promise<string> {
    return this.world.runs.get(this.runId).then((run) => run.workflowName);
  }

  /**
   * The timestamp when the workflow run was created.
   */
  get createdAt(): Promise<Date> {
    return this.world.runs.get(this.runId).then((run) => run.createdAt);
  }

  /**
   * The timestamp when the workflow run started execution.
   * Returns undefined if the workflow has not started yet.
   */
  get startedAt(): Promise<Date | undefined> {
    return this.world.runs.get(this.runId).then((run) => run.startedAt);
  }

  /**
   * The timestamp when the workflow run completed.
   * Returns undefined if the workflow has not completed yet.
   */
  get completedAt(): Promise<Date | undefined> {
    return this.world.runs.get(this.runId).then((run) => run.completedAt);
  }

  /**
   * The readable stream of the workflow run.
   */
  get readable(): ReadableStream {
    return this.getReadable();
  }

  /**
   * Retrieves the workflow run's default readable stream, which reads chunks
   * written to the corresponding writable stream {@link getWritable}.
   *
   * @param options - The options for the readable stream.
   * @returns The `ReadableStream` for the workflow run.
   */
  getReadable<R = any>(
    options: WorkflowReadableStreamOptions = {}
  ): ReadableStream<R> {
    const { ops = [], global = globalThis, startIndex, namespace } = options;
    const name = getWorkflowRunStreamId(this.runId, namespace);
    return getExternalRevivers(global, ops, this.runId).ReadableStream({
      name,
      startIndex,
    }) as ReadableStream<R>;
  }

  /**
   * Polls the workflow return value every 1 second until it is completed.
   * @internal
   * @returns The workflow return value.
   */
  private async pollReturnValue(): Promise<TResult> {
    while (true) {
      try {
        const run = await this.world.runs.get(this.runId);

        if (run.status === 'completed') {
          return hydrateWorkflowReturnValue(run.output, [], this.runId);
        }

        if (run.status === 'cancelled') {
          throw new WorkflowRunCancelledError(this.runId);
        }

        if (run.status === 'failed') {
          throw new WorkflowRunFailedError(this.runId, run.error);
        }

        throw new WorkflowRunNotCompletedError(this.runId, run.status);
      } catch (error) {
        if (WorkflowRunNotCompletedError.is(error)) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        throw error;
      }
    }
  }
}

/**
 * Retrieves a `Run` object for a given run ID.
 *
 * @param runId - The workflow run ID obtained from {@link start}.
 * @returns A `Run` object.
 * @throws WorkflowRunNotFoundError if the run ID is not found.
 */
export function getRun<TResult>(runId: string): Run<TResult> {
  return new Run(runId);
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
      // Extract the workflow name from the topic name
      const workflowName = metadata.queueName.slice('__wkf_workflow_'.length);
      const spanLinks = await linkToCurrentContext();

      // Invoke user workflow within the propagated trace context
      return await withTraceContext(traceContext, async () => {
        const world = getWorld();
        return trace(
          `WORKFLOW ${workflowName}`,
          { links: spanLinks },
          async (span) => {
            span?.setAttributes({
              ...Attribute.WorkflowName(workflowName),
              ...Attribute.WorkflowOperation('execute'),
              ...Attribute.QueueName(metadata.queueName),
              ...Attribute.QueueMessageId(metadata.messageId),
              ...getQueueOverhead({ requestedAt }),
            });

            // TODO: validate `workflowName` exists before consuming message?

            span?.setAttributes({
              ...Attribute.WorkflowRunId(runId),
              ...Attribute.WorkflowTracePropagated(!!traceContext),
            });

            let workflowStartedAt = -1;
            try {
              let workflowRun = await world.runs.get(runId);

              if (workflowRun.status === 'pending') {
                // Transition run to 'running' via event (event-sourced architecture)
                const result = await world.events.create(runId, {
                  eventType: 'run_started',
                });
                // Use the run entity from the event response (no extra get call needed)
                if (!result.run) {
                  throw new Error(
                    `Event creation for 'run_started' did not return the run entity for run \"${runId}\"`
                  );
                }
                workflowRun = result.run;
              }

              // At this point, the workflow is "running" and `startedAt` should
              // definitely be set.
              if (!workflowRun.startedAt) {
                throw new Error(
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
                console.warn(
                  `Workflow "${runId}" has status "${workflowRun.status}", skipping`
                );

                // TODO: for `cancel`, we actually want to propagate a WorkflowCancelled event
                // inside the workflow context so the user can gracefully exit. this is SIGTERM
                // TODO: furthermore, there should be a timeout or a way to force cancel SIGKILL
                // so that we actually exit here without replaying the workflow at all, in the case
                // the replaying the workflow is itself failing.

                return;
              }

              // Load all events into memory before running
              const events = await getAllWorkflowRunEvents(workflowRun.runId);

              // Check for any elapsed waits and batch create wait_completed events
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
                  correlationId: e.correlationId,
                }));

              // Create all wait_completed events
              for (const waitEvent of waitsToComplete) {
                const result = await world.events.create(runId, waitEvent);
                // Add the event to the events array so the workflow can see it
                events.push(result.event);
              }

              const result = await runWorkflow(
                workflowCode,
                workflowRun,
                events
              );

              // Complete the workflow run via event (event-sourced architecture)
              await world.events.create(runId, {
                eventType: 'run_completed',
                eventData: {
                  output: result as Serializable,
                },
              });

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
                // NOTE: this error could be an error thrown in user code, or could also be a WorkflowRuntimeError
                // (for instance when the event log is corrupted, this is thrown by the event consumer). We could
                // specially handle these if needed.

                const errorName = getErrorName(err);
                const errorMessage =
                  err instanceof Error ? err.message : String(err);
                let errorStack = getErrorStack(err);

                // Remap error stack using source maps to show original source locations
                if (errorStack) {
                  const parsedName = parseWorkflowName(workflowName);
                  const filename = parsedName?.path || workflowName;
                  errorStack = remapErrorStack(
                    errorStack,
                    filename,
                    workflowCode
                  );
                }

                console.error(
                  `${errorName} while running "${runId}" workflow:\n\n${errorStack}`
                );
                // Fail the workflow run via event (event-sourced architecture)
                await world.events.create(runId, {
                  eventType: 'run_failed',
                  eventData: {
                    error: {
                      message: errorMessage,
                      stack: errorStack,
                    },
                    // TODO: include error codes when we define them
                  },
                });

                span?.setAttributes({
                  ...Attribute.WorkflowRunStatus('failed'),
                  ...Attribute.WorkflowErrorName(errorName),
                  ...Attribute.WorkflowErrorMessage(String(err)),
                });
              }
            }
          }
        ); // End withTraceContext
      });
    }
  );

  return withHealthCheck(handler);
}

// this is a no-op placeholder as the client is
// expecting this to be present but we aren't actually using it
export function runStep() {}
