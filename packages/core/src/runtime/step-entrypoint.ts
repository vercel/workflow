import { waitUntil } from '@vercel/functions';
import {
  FatalError,
  RetryableError,
  WorkflowAPIError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { runtimeLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
import {
  type Serializable,
  StepInvokePayloadSchema,
  type WorkflowInvokePayload,
} from '../schemas.js';
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
} from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import {
  serializeTraceCarrier,
  trace,
  withTraceContext,
} from '../telemetry.js';
import { getErrorName, getErrorStack } from '../types.js';
import { getWorld, getWorldHandlers } from './world.js';

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
      } = StepInvokePayloadSchema.parse(message_);
      // Execute step within the propagated trace context
      return await withTraceContext(traceContext, async () => {
        // Extract the step name from the topic name
        const stepName = metadata.queueName.slice('__wkf_step_'.length);
        const world = getWorld();

        return trace(`STEP ${stepName}`, async (span) => {
          span?.setAttributes({
            ...Attribute.StepName(stepName),
            ...Attribute.StepAttempt(metadata.attempt),
            ...Attribute.QueueName(metadata.queueName),
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
            if (step.status !== 'pending') {
              // We should only be running the step if it's pending
              // (initial state, or state set on re-try), so the step has been
              // invoked erroneously.
              console.error(
                `[Workflows] "${workflowRunId}" - Step invoked erroneously, expected status "pending", got "${step.status}" instead, skipping execution`
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
            // Hydrate the step input arguments
            const ops: Promise<void>[] = [];
            const args = hydrateStepArguments(step.input, ops);

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
                  // solution only works for vercel + embedded worlds.
                  url: process.env.VERCEL_URL
                    ? `https://${process.env.VERCEL_URL}`
                    : `http://localhost:${process.env.PORT || 3000}`,
                },
                ops,
              },
              () => stepFn(...args)
            );

            result = dehydrateStepReturnValue(result, ops);

            waitUntil(Promise.all(ops));

            // Update the event log with the step result
            await world.events.create(workflowRunId, {
              eventType: 'step_completed',
              correlationId: stepId,
              eventData: {
                result: result as Serializable,
              },
            });

            await world.steps.update(workflowRunId, stepId, {
              status: 'completed',
              output: result as Serializable,
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
              const stackLines = getErrorStack(err).split('\n').slice(0, 4);
              console.error(
                `[Workflows] "${workflowRunId}" - Encountered \`FatalError\` while executing step "${stepName}":\n  > ${stackLines.join('\n    > ')}\n\nBubbling up error to parent workflow`
              );
              // Fatal error - store the error in the event log and re-invoke the workflow
              await world.events.create(workflowRunId, {
                eventType: 'step_failed',
                correlationId: stepId,
                eventData: {
                  error: String(err),
                  stack: err.stack,
                  fatal: true,
                },
              });
              await world.steps.update(workflowRunId, stepId, {
                status: 'failed',
                error: String(err),
                // TODO: include error codes when we define them
                // TODO: serialize/include the error name and stack?
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
                const stackLines = getErrorStack(err).split('\n').slice(0, 4);
                console.error(
                  `[Workflows] "${workflowRunId}" - Encountered \`Error\` while executing step "${stepName}" (attempt ${attempt}):\n  > ${stackLines.join('\n    > ')}\n\n  Max retries reached\n  Bubbling error to parent workflow`
                );
                const errorMessage = `Step "${stepName}" failed after max retries: ${String(err)}`;
                await world.events.create(workflowRunId, {
                  eventType: 'step_failed',
                  correlationId: stepId,
                  eventData: {
                    error: errorMessage,
                    stack: getErrorStack(err),
                    fatal: true,
                  },
                });
                await world.steps.update(workflowRunId, stepId, {
                  status: 'failed',
                  error: errorMessage,
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
                  const stackLines = getErrorStack(err).split('\n').slice(0, 4);
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

          await world.queue(`__wkf_workflow_${workflowName}`, {
            runId: workflowRunId,
            traceCarrier: await serializeTraceCarrier(),
          } satisfies WorkflowInvokePayload);
        });
      });
    }
  );

// this is a no-op placeholder as the client is
// expecting this to be present but we aren't actually using it
export function runStep() {}
