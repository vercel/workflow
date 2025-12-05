import { waitUntil } from '@vercel/functions';
import {
  FatalError,
  RetryableError,
  WorkflowAPIError,
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { getPort } from '@workflow/utils/get-port';
import {
  type Event,
  StepInvokePayloadSchema,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
  type WorkflowRunStatus,
  type World,
} from '@workflow/world';
import { WorkflowSuspension } from './global.js';
import { runtimeLogger } from './logger.js';
import { parseWorkflowName } from './parse-name.js';
import { getStepFunction } from './private.js';
import { getWorld, getWorldHandlers } from './runtime/world.js';
import type { Serializable } from './schemas.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  getExternalRevivers,
  hydrateStepArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { remapErrorStack } from './source-map.js';
// TODO: move step handler out to a separate file
import { contextStorage } from './step/context-storage.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import {
  getSpanKind,
  linkToCurrentContext,
  serializeTraceCarrier,
  trace,
  withTraceContext,
} from './telemetry.js';
import { getErrorName, getErrorStack } from './types.js';
import {
  buildWorkflowSuspensionMessage,
  getWorkflowRunStreamId,
} from './util.js';
import { runWorkflow } from './workflow.js';

export type { Event, WorkflowRun };
export { WorkflowSuspension } from './global.js';
export {
  getHookByToken,
  resumeHook,
  resumeWebhook,
} from './runtime/resume-hook.js';
export { type StartOptions, start } from './runtime/start.js';

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

              const result = await runWorkflow(
                workflowCode,
                workflowRun,
                events
              );

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
                    const dehydratedInput = dehydrateStepArguments(
                      {
                        args: queueItem.args,
                        closureVars: queueItem.closureVars,
                      },
                      err.globalThis
                    );

                    try {
                      const step = await world.steps.create(runId, {
                        stepId: queueItem.correlationId,
                        stepName: queueItem.stepName,
                        input: dehydratedInput as Serializable,
                      });

                      waitUntil(
                        Promise.all(ops).catch((err) => {
                          // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
                          const isAbortError =
                            err?.name === 'AbortError' ||
                            err?.name === 'ResponseAborted';
                          if (!isAbortError) throw err;
                        })
                      );

                      await queueMessage(
                        world,
                        `__wkf_step_${queueItem.stepName}`,
                        {
                          workflowName,
                          workflowRunId: runId,
                          workflowStartedAt,
                          stepId: step.stepId,
                          traceCarrier: await serializeTraceCarrier(),
                          requestedAt: new Date(),
                        },
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
                await world.runs.update(runId, {
                  status: 'failed',
                  error: {
                    message: errorMessage,
                    stack: errorStack,
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
}

/**
 * A single route that handles any step execution request and routes to the
 * appropriate step function. We may eventually want to create different bundles
 * for each step, this is temporary.
 */
export const stepEntrypoint =
  /* @__PURE__ */ getWorldHandlers().createQueueHandler(
    '__wkf_step_',
    async (message_, metadata) => {
      const {
        workflowName,
        workflowRunId,
        workflowStartedAt,
        stepId,
        traceCarrier: traceContext,
        requestedAt,
      } = StepInvokePayloadSchema.parse(message_);
      const spanLinks = await linkToCurrentContext();
      // Execute step within the propagated trace context
      return await withTraceContext(traceContext, async () => {
        // Extract the step name from the topic name
        const stepName = metadata.queueName.slice('__wkf_step_'.length);
        const world = getWorld();

        // Get the port early to avoid async operations during step execution
        const port = await getPort();

        return trace(
          `STEP ${stepName}`,
          { kind: await getSpanKind('CONSUMER'), links: spanLinks },
          async (span) => {
            span?.setAttributes({
              ...Attribute.StepName(stepName),
              ...Attribute.StepAttempt(metadata.attempt),
              ...Attribute.QueueName(metadata.queueName),
              ...Attribute.QueueMessageId(metadata.messageId),
              ...getQueueOverhead({ requestedAt }),
            });

            const stepFn = getStepFunction(stepName);
            if (!stepFn) {
              throw new Error(`Step "${stepName}" not found`);
            }
            if (typeof stepFn !== 'function') {
              throw new Error(
                `Step "${stepName}" is not a function (got ${typeof stepFn})`
              );
            }

            span?.setAttributes({
              ...Attribute.WorkflowName(workflowName),
              ...Attribute.WorkflowRunId(workflowRunId),
              ...Attribute.StepId(stepId),
              ...Attribute.StepMaxRetries(stepFn.maxRetries ?? 3),
              ...Attribute.StepTracePropagated(!!traceContext),
            });

            let step = await world.steps.get(workflowRunId, stepId);

            runtimeLogger.debug('Step execution details', {
              stepName,
              stepId: step.stepId,
              status: step.status,
              attempt: step.attempt,
            });

            span?.setAttributes({
              ...Attribute.StepStatus(step.status),
            });

            // Check if the step has a `retryAfter` timestamp that hasn't been reached yet
            const now = Date.now();
            if (step.retryAfter && step.retryAfter.getTime() > now) {
              const timeoutSeconds = Math.ceil(
                (step.retryAfter.getTime() - now) / 1000
              );
              span?.setAttributes({
                ...Attribute.StepRetryTimeoutSeconds(timeoutSeconds),
              });
              runtimeLogger.debug('Step retryAfter timestamp not yet reached', {
                stepName,
                stepId: step.stepId,
                retryAfter: step.retryAfter,
                timeoutSeconds,
              });
              return { timeoutSeconds };
            }

            let result: unknown;
            const attempt = step.attempt + 1;
            try {
              if (!['pending', 'running'].includes(step.status)) {
                // We should only be running the step if it's either
                // a) pending - initial state, or state set on re-try
                // b) running - if a step fails mid-execution, like a function timeout
                // otherwise, the step has been invoked erroneously
                console.error(
                  `[Workflows] "${workflowRunId}" - Step invoked erroneously, expected status "pending" or "running", got "${step.status}" instead, skipping execution`
                );
                span?.setAttributes({
                  ...Attribute.StepSkipped(true),
                  ...Attribute.StepSkipReason(step.status),
                });
                return;
              }

              await world.events.create(workflowRunId, {
                eventType: 'step_started', // TODO: Replace with 'step_retrying'
                correlationId: stepId,
              });

              step = await world.steps.update(workflowRunId, stepId, {
                attempt,
                status: 'running',
              });

              if (!step.startedAt) {
                throw new WorkflowRuntimeError(
                  `Step "${stepId}" has no "startedAt" timestamp`
                );
              }
              // Hydrate the step input arguments and closure variables
              const ops: Promise<void>[] = [];
              const hydratedInput = hydrateStepArguments(
                step.input,
                ops,
                workflowRunId
              );

              const args = hydratedInput.args;

              span?.setAttributes({
                ...Attribute.StepArgumentsCount(args.length),
              });

              result = await contextStorage.run(
                {
                  stepMetadata: {
                    stepId,
                    stepStartedAt: new Date(+step.startedAt),
                    attempt,
                  },
                  workflowMetadata: {
                    workflowRunId,
                    workflowStartedAt: new Date(+workflowStartedAt),
                    // TODO: there should be a getUrl method on the world interface itself. This
                    // solution only works for vercel + local worlds.
                    url: process.env.VERCEL_URL
                      ? `https://${process.env.VERCEL_URL}`
                      : `http://localhost:${port ?? 3000}`,
                  },
                  ops,
                  closureVars: hydratedInput.closureVars,
                },
                () => stepFn.apply(null, args)
              );

              // NOTE: None of the code from this point is guaranteed to run
              // Since the step might fail or cause a function timeout and the process might be SIGKILL'd
              // The workflow runtime must be resilient to the below code not executing on a failed step
              result = dehydrateStepReturnValue(result, ops, workflowRunId);

              waitUntil(
                Promise.all(ops).catch((err) => {
                  // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
                  const isAbortError =
                    err?.name === 'AbortError' ||
                    err?.name === 'ResponseAborted';
                  if (!isAbortError) throw err;
                })
              );

              // Mark the step as completed first. This order is important. If a concurrent
              // execution marked the step as complete, this request should throw, and
              // this prevent the step_completed event in the event log
              // TODO: this should really be atomic and handled by the world
              await world.steps.update(workflowRunId, stepId, {
                status: 'completed',
                output: result as Serializable,
              });

              // Then, append the event log with the step result
              await world.events.create(workflowRunId, {
                eventType: 'step_completed',
                correlationId: stepId,
                eventData: {
                  result: result as Serializable,
                },
              });

              span?.setAttributes({
                ...Attribute.StepStatus('completed'),
                ...Attribute.StepResultType(typeof result),
              });
            } catch (err: unknown) {
              span?.setAttributes({
                ...Attribute.StepErrorName(getErrorName(err)),
                ...Attribute.StepErrorMessage(String(err)),
              });

              if (WorkflowAPIError.is(err)) {
                if (err.status === 410) {
                  // Workflow has already completed, so no-op
                  console.warn(
                    `Workflow run "${workflowRunId}" has already completed, skipping step "${stepId}": ${err.message}`
                  );
                  return;
                }
              }

              if (FatalError.is(err)) {
                const errorStack = getErrorStack(err);
                const stackLines = errorStack.split('\n').slice(0, 4);
                console.error(
                  `[Workflows] "${workflowRunId}" - Encountered \`FatalError\` while executing step "${stepName}":\n  > ${stackLines.join('\n    > ')}\n\nBubbling up error to parent workflow`
                );
                // Fatal error - store the error in the event log and re-invoke the workflow
                await world.events.create(workflowRunId, {
                  eventType: 'step_failed',
                  correlationId: stepId,
                  eventData: {
                    error: String(err),
                    stack: errorStack,
                    fatal: true,
                  },
                });
                await world.steps.update(workflowRunId, stepId, {
                  status: 'failed',
                  error: {
                    message: err.message || String(err),
                    stack: errorStack,
                    // TODO: include error codes when we define them
                  },
                });

                span?.setAttributes({
                  ...Attribute.StepStatus('failed'),
                  ...Attribute.StepFatalError(true),
                });
              } else {
                const maxRetries = stepFn.maxRetries ?? 3;

                span?.setAttributes({
                  ...Attribute.StepAttempt(attempt),
                  ...Attribute.StepMaxRetries(maxRetries),
                });

                if (attempt >= maxRetries) {
                  // Max retries reached
                  const errorStack = getErrorStack(err);
                  const stackLines = errorStack.split('\n').slice(0, 4);
                  console.error(
                    `[Workflows] "${workflowRunId}" - Encountered \`Error\` while executing step "${stepName}" (attempt ${attempt}):\n  > ${stackLines.join('\n    > ')}\n\n  Max retries reached\n  Bubbling error to parent workflow`
                  );
                  const errorMessage = `Step "${stepName}" failed after max retries: ${String(err)}`;
                  await world.events.create(workflowRunId, {
                    eventType: 'step_failed',
                    correlationId: stepId,
                    eventData: {
                      error: errorMessage,
                      stack: errorStack,
                      fatal: true,
                    },
                  });
                  await world.steps.update(workflowRunId, stepId, {
                    status: 'failed',
                    error: {
                      message: errorMessage,
                      stack: errorStack,
                    },
                  });

                  span?.setAttributes({
                    ...Attribute.StepStatus('failed'),
                    ...Attribute.StepRetryExhausted(true),
                  });
                } else {
                  // Not at max retries yet - log as a retryable error
                  if (RetryableError.is(err)) {
                    console.warn(
                      `[Workflows] "${workflowRunId}" - Encountered \`RetryableError\` while executing step "${stepName}" (attempt ${attempt}):\n  > ${String(err.message)}\n\n  This step has failed but will be retried`
                    );
                  } else {
                    const stackLines = getErrorStack(err)
                      .split('\n')
                      .slice(0, 4);
                    console.error(
                      `[Workflows] "${workflowRunId}" - Encountered \`Error\` while executing step "${stepName}" (attempt ${attempt}):\n  > ${stackLines.join('\n    > ')}\n\n  This step has failed but will be retried`
                    );
                  }
                  await world.events.create(workflowRunId, {
                    eventType: 'step_failed',
                    correlationId: stepId,
                    eventData: {
                      error: String(err),
                      stack: getErrorStack(err),
                    },
                  });

                  await world.steps.update(workflowRunId, stepId, {
                    status: 'pending', // TODO: Should be "retrying" once we have that status
                    ...(RetryableError.is(err) && {
                      retryAfter: err.retryAfter,
                    }),
                  });

                  const timeoutSeconds = Math.max(
                    1,
                    RetryableError.is(err)
                      ? Math.ceil(
                          (+err.retryAfter.getTime() - Date.now()) / 1000
                        )
                      : 1
                  );

                  span?.setAttributes({
                    ...Attribute.StepRetryTimeoutSeconds(timeoutSeconds),
                    ...Attribute.StepRetryWillRetry(true),
                  });

                  // It's a retryable error - so have the queue keep the message visible
                  // so that it gets retried.
                  return { timeoutSeconds };
                }
              }
            }

            await queueMessage(world, `__wkf_workflow_${workflowName}`, {
              runId: workflowRunId,
              traceCarrier: await serializeTraceCarrier(),
              requestedAt: new Date(),
            });
          }
        );
      });
    }
  );

/**
 * Queues a message to the specified queue with tracing.
 */
async function queueMessage(
  world: World,
  ...args: Parameters<typeof world.queue>
) {
  const queueName = args[0];
  await trace(
    'queueMessage',
    {
      attributes: Attribute.QueueName(queueName),
      kind: await getSpanKind('PRODUCER'),
    },
    async (span) => {
      const { messageId } = await world.queue(...args);
      span?.setAttributes(Attribute.QueueMessageId(messageId));
    }
  );
}

/**
 * Calculates the queue overhead time in milliseconds for a given message.
 */
function getQueueOverhead(message: { requestedAt?: Date }) {
  if (!message.requestedAt) return;
  try {
    return Attribute.QueueOverheadMs(
      Date.now() - message.requestedAt.getTime()
    );
  } catch {
    return;
  }
}

// this is a no-op placeholder as the client is
// expecting this to be present but we aren't actually using it
export function runStep() {}
