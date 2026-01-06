import { waitUntil } from '@vercel/functions';
import {
  FatalError,
  RetryableError,
  WorkflowAPIError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { pluralize } from '@workflow/utils';
import { getPort } from '@workflow/utils/get-port';
import { StepInvokePayloadSchema } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
import type { Serializable } from '../schemas.js';
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
} from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import {
  getSpanKind,
  linkToCurrentContext,
  serializeTraceCarrier,
  trace,
  withTraceContext,
} from '../telemetry.js';
import { getErrorName, getErrorStack } from '../types.js';
import {
  getQueueOverhead,
  handleHealthCheckMessage,
  parseHealthCheckPayload,
  queueMessage,
  withHealthCheck,
} from './helpers.js';
import { getWorld, getWorldHandlers } from './world.js';

const DEFAULT_STEP_MAX_RETRIES = 3;

const stepHandler = getWorldHandlers().createQueueHandler(
  '__wkf_step_',
  async (message_, metadata) => {
    // Check if this is a health check message
    // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
    // They only write a simple status response to a stream and do not expose sensitive data.
    // The stream name includes a unique correlationId that must be known by the caller.
    const healthCheck = parseHealthCheckPayload(message_);
    if (healthCheck) {
      await handleHealthCheckMessage(healthCheck, 'step');
      return;
    }

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

          const maxRetries = stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;

          span?.setAttributes({
            ...Attribute.WorkflowName(workflowName),
            ...Attribute.WorkflowRunId(workflowRunId),
            ...Attribute.StepId(stepId),
            ...Attribute.StepMaxRetries(maxRetries),
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

          // Check max retries FIRST before any state changes.
          // step.attempt tracks how many times step_started has been called.
          // If step.attempt >= maxRetries, we've already tried maxRetries times.
          // This handles edge cases where the step handler is invoked after max retries have been exceeded
          // (e.g., when the step repeatedly times out or fails before reaching the catch handler).
          // Without this check, the step would retry forever.
          // Note: maxRetries is the number of RETRIES after the first attempt, so total attempts = maxRetries + 1
          // Use > here (not >=) because this guards against re-invocation AFTER all attempts are used.
          // The post-failure check uses >= to decide whether to retry after a failure.
          if (step.attempt > maxRetries + 1) {
            const retryCount = step.attempt - 1;
            const errorMessage = `Step "${stepName}" exceeded max retries (${retryCount} ${pluralize('retry', 'retries', retryCount)})`;
            console.error(`[Workflows] "${workflowRunId}" - ${errorMessage}`);
            // Fail the step via event (event-sourced architecture)
            await world.events.create(workflowRunId, {
              eventType: 'step_failed',
              correlationId: stepId,
              eventData: {
                error: errorMessage,
                stack: step.error?.stack,
              },
            });

            span?.setAttributes({
              ...Attribute.StepStatus('failed'),
              ...Attribute.StepRetryExhausted(true),
            });

            // Re-invoke the workflow to handle the failed step
            await queueMessage(world, `__wkf_workflow_${workflowName}`, {
              runId: workflowRunId,
              traceCarrier: await serializeTraceCarrier(),
              requestedAt: new Date(),
            });
            return;
          }

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
              // There's a chance that a step terminates correctly, but the underlying process
              // fails or gets killed before the stepEntrypoint has a chance to re-enqueue the run.
              // The queue lease expires and stepEntrypoint again, which leads us here, so
              // we optimistically re-enqueue the workflow if the step is in a terminal state,
              // under the assumption that this edge case happened.
              // Until we move to atomic entity/event updates (World V2), there _could_ be an edge case
              // where the we execute this code based on the `step` entity status, but the runtime
              // failed to create the `step_completed` event (due to failing between step and event update),
              // in which case, this might lead to an infinite loop.
              // https://vercel.slack.com/archives/C09125LC4AX/p1765313809066679
              const isTerminalStep = [
                'completed',
                'failed',
                'cancelled',
              ].includes(step.status);
              if (isTerminalStep) {
                await queueMessage(world, `__wkf_workflow_${workflowName}`, {
                  runId: workflowRunId,
                  traceCarrier: await serializeTraceCarrier(),
                  requestedAt: new Date(),
                });
              }
              return;
            }

            // Start the step via event (event-sourced architecture)
            // step_started increments the attempt counter in the World implementation
            const startResult = await world.events.create(workflowRunId, {
              eventType: 'step_started',
              correlationId: stepId,
            });

            // Use the step entity from the event response (no extra get call needed)
            if (!startResult.step) {
              throw new WorkflowRuntimeError(
                `step_started event for "${stepId}" did not return step entity`
              );
            }
            step = startResult.step;

            // step.attempt is now the current attempt number (after increment)
            const attempt = step.attempt;

            if (!step.startedAt) {
              throw new WorkflowRuntimeError(
                `Step "${stepId}" has no "startedAt" timestamp`
              );
            }
            // Hydrate the step input arguments, closure variables, and thisVal
            const ops: Promise<void>[] = [];
            const hydratedInput = hydrateStepArguments(
              step.input,
              ops,
              workflowRunId
            );

            const args = hydratedInput.args;
            const thisVal = hydratedInput.thisVal ?? null;

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
              () => stepFn.apply(thisVal, args)
            );

            // NOTE: None of the code from this point is guaranteed to run
            // Since the step might fail or cause a function timeout and the process might be SIGKILL'd
            // The workflow runtime must be resilient to the below code not executing on a failed step
            result = dehydrateStepReturnValue(result, ops, workflowRunId);

            waitUntil(
              Promise.all(ops).catch((err) => {
                // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
                const isAbortError =
                  err?.name === 'AbortError' || err?.name === 'ResponseAborted';
                if (!isAbortError) throw err;
              })
            );

            // Complete the step via event (event-sourced architecture)
            // The event creation atomically updates the step entity
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
              // Fail the step via event (event-sourced architecture)
              await world.events.create(workflowRunId, {
                eventType: 'step_failed',
                correlationId: stepId,
                eventData: {
                  error: String(err),
                  stack: errorStack,
                },
              });

              span?.setAttributes({
                ...Attribute.StepStatus('failed'),
                ...Attribute.StepFatalError(true),
              });
            } else {
              const maxRetries = stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
              // step.attempt was incremented by step_started, use it here
              const currentAttempt = step.attempt;

              span?.setAttributes({
                ...Attribute.StepAttempt(currentAttempt),
                ...Attribute.StepMaxRetries(maxRetries),
              });

              // Note: maxRetries is the number of RETRIES after the first attempt, so total attempts = maxRetries + 1
              if (currentAttempt >= maxRetries + 1) {
                // Max retries reached
                const errorStack = getErrorStack(err);
                const stackLines = errorStack.split('\n').slice(0, 4);
                const retryCount = step.attempt - 1;
                console.error(
                  `[Workflows] "${workflowRunId}" - Encountered \`Error\` while executing step "${stepName}" (attempt ${step.attempt}, ${retryCount} ${pluralize('retry', 'retries', retryCount)}):\n  > ${stackLines.join('\n    > ')}\n\n  Max retries reached\n  Bubbling error to parent workflow`
                );
                const errorMessage = `Step "${stepName}" failed after ${maxRetries} ${pluralize('retry', 'retries', maxRetries)}: ${String(err)}`;
                // Fail the step via event (event-sourced architecture)
                await world.events.create(workflowRunId, {
                  eventType: 'step_failed',
                  correlationId: stepId,
                  eventData: {
                    error: errorMessage,
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
                    `[Workflows] "${workflowRunId}" - Encountered \`RetryableError\` while executing step "${stepName}" (attempt ${currentAttempt}):\n  > ${String(err.message)}\n\n  This step has failed but will be retried`
                  );
                } else {
                  const stackLines = getErrorStack(err).split('\n').slice(0, 4);
                  console.error(
                    `[Workflows] "${workflowRunId}" - Encountered \`Error\` while executing step "${stepName}" (attempt ${currentAttempt}):\n  > ${stackLines.join('\n    > ')}\n\n  This step has failed but will be retried`
                  );
                }
                // Set step to pending for retry via event (event-sourced architecture)
                // step_retrying records the error and sets status to pending
                const errorStack = getErrorStack(err);
                await world.events.create(workflowRunId, {
                  eventType: 'step_retrying',
                  correlationId: stepId,
                  eventData: {
                    error: String(err),
                    stack: errorStack,
                    ...(RetryableError.is(err) && {
                      retryAfter: err.retryAfter,
                    }),
                  },
                });

                const timeoutSeconds = Math.max(
                  1,
                  RetryableError.is(err)
                    ? Math.ceil((+err.retryAfter.getTime() - Date.now()) / 1000)
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
 * A single route that handles any step execution request and routes to the
 * appropriate step function. We may eventually want to create different bundles
 * for each step, this is temporary.
 */
export const stepEntrypoint: (req: Request) => Promise<Response> =
  /* @__PURE__ */ withHealthCheck(stepHandler);
