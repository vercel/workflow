import { waitUntil } from '@vercel/functions';
import {
  WorkflowAPIError,
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from '@workflow/errors';
import type {
  Event,
  WorkflowRun,
  WorkflowRunStatus,
  World,
} from '@workflow/world';
import { WorkflowSuspension } from './global.js';
import { getWorld, getWorldHandlers } from './runtime/world.js';
import {
  type Serializable,
  type StepInvokePayload,
  WorkflowInvokePayloadSchema,
} from './schemas.js';
import {
  dehydrateStepArguments,
  getExternalRevivers,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import { serializeTraceCarrier, trace, withTraceContext } from './telemetry.js';
import { getErrorName, getErrorStack } from './types.js';
import {
  buildWorkflowSuspensionMessage,
  getWorkflowRunStreamId,
} from './util.js';
import { runWorkflow } from './workflow.js';

export type { Event, WorkflowRun };
export { WorkflowAPIError } from '@workflow/errors';
export { WorkflowSuspension } from './global.js';
export {
  getHookByToken,
  resumeHook,
  resumeWebhook,
} from './runtime/resume-hook.js';
export { type StartOptions, start } from './runtime/start.js';
export { runStep, stepEntrypoint } from './runtime/step-entrypoint.js';

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
    await this.world.runs.cancel(this.runId);
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
    return getExternalRevivers(global, ops).ReadableStream({
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
          return hydrateWorkflowReturnValue(run.output, [], globalThis);
        }

        if (run.status === 'cancelled') {
          throw new WorkflowRunCancelledError(this.runId);
        }

        if (run.status === 'failed') {
          throw new WorkflowRunFailedError(
            this.runId,
            run.error ?? 'Unknown error'
          );
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
 * Loads all workflow run events by iterating through all pages of paginated results.
 * This ensures that *all* events are loaded into memory before running the workflow.
 * Events must be in chronological order (ascending) for proper workflow replay.
 */
async function getAllWorkflowRunEvents(runId: string): Promise<Event[]> {
  const allEvents: Event[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  const world = getWorld();
  while (hasMore) {
    const response = await world.events.list({
      runId,
      pagination: {
        sortOrder: 'asc', // Required: events must be in chronological order for replay
        cursor: cursor ?? undefined,
      },
    });

    allEvents.push(...response.data);
    hasMore = response.hasMore;
    cursor = response.cursor;
  }

  return allEvents;
}

/**
 * Function that creates a single route which handles any workflow execution
 * request and routes to the appropriate workflow function.
 *
 * @param workflowCode - The workflow bundle code containing all the workflow
 * functions at the top level.
 * @returns A function that can be used as a Vercel API route.
 */
export function workflowEntrypoint(workflowCode: string) {
  return getWorldHandlers().createQueueHandler(
    '__wkf_workflow_',
    async (message_, metadata) => {
      const { runId, traceCarrier: traceContext } =
        WorkflowInvokePayloadSchema.parse(message_);
      // Extract the workflow name from the topic name
      const workflowName = metadata.queueName.slice('__wkf_workflow_'.length);

      // Invoke user workflow within the propagated trace context
      return await withTraceContext(traceContext, async () => {
        const world = getWorld();
        return trace(`WORKFLOW ${workflowName}`, async (span) => {
          span?.setAttributes({
            ...Attribute.WorkflowName(workflowName),
            ...Attribute.WorkflowOperation('execute'),
            ...Attribute.QueueName(metadata.queueName),
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
              workflowRun = await world.runs.update(runId, {
                // This sets the `startedAt` timestamp at the database level
                status: 'running',
              });
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

            // Check for any elapsed waits and create wait_completed events
            const now = Date.now();
            for (const event of events) {
              if (event.eventType === 'wait_created') {
                const resumeAt = event.eventData.resumeAt as Date;
                const hasCompleted = events.some(
                  (e) =>
                    e.eventType === 'wait_completed' &&
                    e.correlationId === event.correlationId
                );

                // If wait has elapsed and hasn't been completed yet
                if (!hasCompleted && now >= resumeAt.getTime()) {
                  const completedEvent = await world.events.create(runId, {
                    eventType: 'wait_completed',
                    correlationId: event.correlationId,
                  });
                  // Add the event to the events array so the workflow can see it
                  events.push(completedEvent);
                }
              }
            }

            const result = await runWorkflow(workflowCode, workflowRun, events);

            // Update the workflow run with the result
            await world.runs.update(runId, {
              status: 'completed',
              output: result as Serializable,
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
                // Note: suspensionMessage logged only in debug mode to avoid production noise
                // console.debug(suspensionMessage);
              }
              // Process each operation in the queue (steps and hooks)
              let minTimeoutSeconds: number | null = null;
              for (const queueItem of err.steps) {
                if (queueItem.type === 'step') {
                  // Handle step operations
                  const ops: Promise<void>[] = [];
                  const dehydratedArgs = dehydrateStepArguments(
                    queueItem.args,
                    err.globalThis
                  );

                  try {
                    const step = await world.steps.create(runId, {
                      stepId: queueItem.correlationId,
                      stepName: queueItem.stepName,
                      input: dehydratedArgs as Serializable[],
                    });

                    waitUntil(Promise.all(ops));

                    await world.queue(
                      `__wkf_step_${queueItem.stepName}`,
                      {
                        workflowName,
                        workflowRunId: runId,
                        workflowStartedAt,
                        stepId: step.stepId,
                        traceCarrier: await serializeTraceCarrier(),
                      } satisfies StepInvokePayload,
                      {
                        idempotencyKey: queueItem.correlationId,
                      }
                    );
                  } catch (err) {
                    if (WorkflowAPIError.is(err) && err.status === 409) {
                      // Step already exists, so we can skip it
                      console.warn(
                        `Step "${queueItem.stepName}" with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`
                      );
                      continue;
                    }
                    throw err;
                  }
                } else if (queueItem.type === 'hook') {
                  // Handle hook operations
                  try {
                    // Create hook in database
                    const hookMetadata =
                      typeof queueItem.metadata === 'undefined'
                        ? undefined
                        : dehydrateStepArguments(
                            queueItem.metadata,
                            err.globalThis
                          );
                    await world.hooks.create(runId, {
                      hookId: queueItem.correlationId,
                      token: queueItem.token,
                      metadata: hookMetadata,
                    });

                    // Create hook_created event in event log
                    await world.events.create(runId, {
                      eventType: 'hook_created',
                      correlationId: queueItem.correlationId,
                    });
                  } catch (err) {
                    if (WorkflowAPIError.is(err)) {
                      if (err.status === 409) {
                        // Hook already exists (duplicate hook_id constraint), so we can skip it
                        console.warn(
                          `Hook with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`
                        );
                        continue;
                      } else if (err.status === 410) {
                        // Workflow has already completed, so no-op
                        console.warn(
                          `Workflow run "${runId}" has already completed, skipping hook "${queueItem.correlationId}": ${err.message}`
                        );
                        continue;
                      }
                    }
                    throw err;
                  }
                } else if (queueItem.type === 'wait') {
                  // Handle wait operations
                  try {
                    // Only create wait_created event if it hasn't been created yet
                    if (!queueItem.hasCreatedEvent) {
                      await world.events.create(runId, {
                        eventType: 'wait_created',
                        correlationId: queueItem.correlationId,
                        eventData: {
                          resumeAt: queueItem.resumeAt,
                        },
                      });
                    }

                    // Calculate how long to wait before resuming
                    const now = Date.now();
                    const resumeAtMs = queueItem.resumeAt.getTime();
                    const delayMs = Math.max(1000, resumeAtMs - now);
                    const timeoutSeconds = Math.ceil(delayMs / 1000);

                    // Track the minimum timeout across all waits
                    if (
                      minTimeoutSeconds === null ||
                      timeoutSeconds < minTimeoutSeconds
                    ) {
                      minTimeoutSeconds = timeoutSeconds;
                    }
                  } catch (err) {
                    if (WorkflowAPIError.is(err) && err.status === 409) {
                      // Wait already exists, so we can skip it
                      console.warn(
                        `Wait with correlation ID "${queueItem.correlationId}" already exists, skipping: ${err.message}`
                      );
                      continue;
                    }
                    throw err;
                  }
                }
              }

              span?.setAttributes({
                ...Attribute.WorkflowRunStatus('pending_steps'),
                ...Attribute.WorkflowStepsCreated(err.steps.length),
              });

              // If we encountered any waits, return the minimum timeout
              if (minTimeoutSeconds !== null) {
                return { timeoutSeconds: minTimeoutSeconds };
              }
            } else {
              const errorName = getErrorName(err);
              const errorStack = getErrorStack(err);
              console.error(
                `${errorName} while running "${runId}" workflow:\n\n${errorStack}`
              );
              await world.runs.update(runId, {
                status: 'failed',
                error: String(err),
                // TODO: include error codes when we define them
                // TODO: serialize/include the error name and stack?
              });
              span?.setAttributes({
                ...Attribute.WorkflowRunStatus('failed'),
                ...Attribute.WorkflowErrorName(errorName),
                ...Attribute.WorkflowErrorMessage(String(err)),
              });
            }
          }
        }); // End withTraceContext
      });
    }
  );
}
