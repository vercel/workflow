import { waitUntil } from '@vercel/functions';
import {
  FatalError,
  RetryableError,
  WorkflowAPIError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { pluralize } from '@workflow/utils';
import { getPort } from '@workflow/utils/get-port';
import { SPEC_VERSION_CURRENT, StepInvokePayloadSchema } from '@workflow/world';
import { runtimeLogger, stepLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
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
import {
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
} from '../types.js';
import {
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  parseHealthCheckPayload,
  queueMessage,
  withHealthCheck,
  withServerErrorRetry,
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

      // Resolve local async values concurrently before entering the trace span
      const [port, spanKind] = await Promise.all([
        getPort(),
        getSpanKind('CONSUMER'),
      ]);

      return trace(
        `STEP ${stepName}`,
        { kind: spanKind, links: spanLinks },
        async (span) => {
          span?.setAttributes({
            ...Attribute.StepName(stepName),
            ...Attribute.StepAttempt(metadata.attempt),
            // Standard OTEL messaging conventions
            ...Attribute.MessagingSystem('vercel-queue'),
            ...Attribute.MessagingDestinationName(metadata.queueName),
            ...Attribute.MessagingMessageId(metadata.messageId),
            ...Attribute.MessagingOperationType('process'),
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

          // step_started validates state and returns the step entity, so no separate
          // world.steps.get() call is needed. The server checks:
          // - Step not in terminal state (returns 409)
          // - retryAfter timestamp reached (returns 425 with Retry-After header)
          // - Workflow still active (returns 410 if completed)
          let step;
          try {
            const startResult = await withServerErrorRetry(() =>
              world.events.create(workflowRunId, {
                eventType: 'step_started',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: stepId,
              })
            );

            if (!startResult.step) {
              throw new WorkflowRuntimeError(
                `step_started event for "${stepId}" did not return step entity`
              );
            }
            step = startResult.step;
          } catch (err) {
            if (WorkflowAPIError.is(err)) {
              if (WorkflowAPIError.is(err) && err.status === 429) {
                const retryRetryAfter = Math.max(
                  1,
                  typeof err.retryAfter === 'number' ? err.retryAfter : 1
                );
                runtimeLogger.warn(
                  'Throttled again on retry, deferring to queue',
                  {
                    retryAfterSeconds: retryRetryAfter,
                  }
                );
                return { timeoutSeconds: retryRetryAfter };
              }
              // 410 Gone: Workflow has already completed
              if (err.status === 410) {
                console.warn(
                  `Workflow run "${workflowRunId}" has already completed, skipping step "${stepId}": ${err.message}`
                );
                return;
              }

              // 409 Conflict: Step in terminal state (completed/failed/cancelled)
              // Re-enqueue the workflow to continue processing
              if (err.status === 409) {
                runtimeLogger.debug(
                  'Step in terminal state, re-enqueuing workflow',
                  {
                    stepName,
                    stepId,
                    workflowRunId,
                    error: err.message,
                  }
                );
                span?.setAttributes({
                  ...Attribute.StepSkipped(true),
                  // Use 'completed' as a representative terminal state for the skip reason
                  ...Attribute.StepSkipReason('completed'),
                });
                // Add span event for step skip
                span?.addEvent?.('step.skipped', {
                  'skip.reason': 'terminal_state',
                  'step.name': stepName,
                  'step.id': stepId,
                });
                await queueMessage(world, getWorkflowQueueName(workflowName), {
                  runId: workflowRunId,
                  traceCarrier: await serializeTraceCarrier(),
                  requestedAt: new Date(),
                });
                return;
              }

              // 425 Too Early: retryAfter timestamp not reached yet
              // Return timeout to queue so it retries later
              if (err.status === 425) {
                // Parse retryAfter from error response meta
                const retryAfterStr = (err as any).meta?.retryAfter;
                const retryAfter = retryAfterStr
                  ? new Date(retryAfterStr)
                  : new Date(Date.now() + 1000);
                const timeoutSeconds = Math.max(
                  1,
                  Math.ceil((retryAfter.getTime() - Date.now()) / 1000)
                );
                span?.setAttributes({
                  ...Attribute.StepRetryTimeoutSeconds(timeoutSeconds),
                });
                // Add span event for delayed retry
                span?.addEvent?.('step.delayed', {
                  'delay.reason': 'retry_after_not_reached',
                  'delay.timeout_seconds': timeoutSeconds,
                  'delay.retry_after': retryAfter.toISOString(),
                });
                runtimeLogger.debug(
                  'Step retryAfter timestamp not yet reached',
                  {
                    stepName,
                    stepId,
                    retryAfter,
                    timeoutSeconds,
                  }
                );
                return { timeoutSeconds };
              }
            }
            // Re-throw other errors
            throw err;
          }

          runtimeLogger.debug('Step execution details', {
            stepName,
            stepId: step.stepId,
            status: step.status,
            attempt: step.attempt,
          });

          span?.setAttributes({
            ...Attribute.StepStatus(step.status),
          });

          let result: unknown;

          // Check max retries AFTER step_started (attempt was just incremented)
          // step.attempt tracks how many times step_started has been called.
          // Note: maxRetries is the number of RETRIES after the first attempt, so total attempts = maxRetries + 1
          // Use > here (not >=) because this guards against re-invocation AFTER all attempts are used.
          // The post-failure check uses >= to decide whether to retry after a failure.
          if (step.attempt > maxRetries + 1) {
            const retryCount = step.attempt - 1;
            const errorMessage = `Step "${stepName}" exceeded max retries (${retryCount} ${pluralize('retry', 'retries', retryCount)})`;
            stepLogger.error('Step exceeded max retries', {
              workflowRunId,
              stepName,
              retryCount,
            });
            // Fail the step via event (event-sourced architecture)
            await world.events.create(workflowRunId, {
              eventType: 'step_failed',
              specVersion: SPEC_VERSION_CURRENT,
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
            await queueMessage(world, getWorkflowQueueName(workflowName), {
              runId: workflowRunId,
              traceCarrier: await serializeTraceCarrier(),
              requestedAt: new Date(),
            });
            return;
          }

          try {
            // step_started already validated the step is in valid state (pending/running)
            // and returned the updated step entity with incremented attempt

            // step.attempt is now the current attempt number (after increment)
            const attempt = step.attempt;

            if (!step.startedAt) {
              throw new WorkflowRuntimeError(
                `Step "${stepId}" has no "startedAt" timestamp`
              );
            }
            // Capture startedAt for use in async callback (TypeScript narrowing doesn't persist)
            const stepStartedAt = step.startedAt;

            // Hydrate the step input arguments, closure variables, and thisVal
            // NOTE: This captures only the synchronous portion of hydration. Any async
            // operations (e.g., stream loading) are added to `ops` and executed later
            // via Promise.all(ops) - their timing is not included in this measurement.
            const ops: Promise<void>[] = [];
            const encryptionKey =
              await world.getEncryptionKeyForRun?.(workflowRunId);
            const hydratedInput = await trace(
              'step.hydrate',
              {},
              async (hydrateSpan) => {
                const startTime = Date.now();
                const result = await hydrateStepArguments(
                  step.input,
                  workflowRunId,
                  encryptionKey,
                  ops
                );
                const durationMs = Date.now() - startTime;
                hydrateSpan?.setAttributes({
                  ...Attribute.StepArgumentsCount(result.args.length),
                  ...Attribute.QueueDeserializeTimeMs(durationMs),
                });
                return result;
              }
            );

            const args = hydratedInput.args;
            const thisVal = hydratedInput.thisVal ?? null;

            // Execute the step function with tracing
            const executionStartTime = Date.now();
            result = await trace('step.execute', {}, async () => {
              return await contextStorage.run(
                {
                  stepMetadata: {
                    stepId,
                    stepStartedAt: new Date(+stepStartedAt),
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
            });
            const executionTimeMs = Date.now() - executionStartTime;

            span?.setAttributes({
              ...Attribute.QueueExecutionTimeMs(executionTimeMs),
            });

            // NOTE: None of the code from this point is guaranteed to run
            // Since the step might fail or cause a function timeout and the process might be SIGKILL'd
            // The workflow runtime must be resilient to the below code not executing on a failed step
            result = await trace(
              'step.dehydrate',
              {},
              async (dehydrateSpan) => {
                const startTime = Date.now();
                const dehydrated = await dehydrateStepReturnValue(
                  result,
                  workflowRunId,
                  encryptionKey,
                  ops
                );
                const durationMs = Date.now() - startTime;
                dehydrateSpan?.setAttributes({
                  ...Attribute.QueueSerializeTimeMs(durationMs),
                  ...Attribute.StepResultType(typeof dehydrated),
                });
                return dehydrated;
              }
            );

            waitUntil(
              Promise.all(ops).catch((err) => {
                // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
                const isAbortError =
                  err?.name === 'AbortError' || err?.name === 'ResponseAborted';
                if (!isAbortError) throw err;
              })
            );

            // Run step_completed and trace serialization concurrently;
            // the trace carrier is used in the final queueMessage call below
            const [, traceCarrier] = await Promise.all([
              withServerErrorRetry(() =>
                world.events.create(workflowRunId, {
                  eventType: 'step_completed',
                  specVersion: SPEC_VERSION_CURRENT,
                  correlationId: stepId,
                  eventData: {
                    result: result as Uint8Array,
                  },
                })
              ),
              serializeTraceCarrier(),
            ]);

            span?.setAttributes({
              ...Attribute.StepStatus('completed'),
              ...Attribute.StepResultType(typeof result),
            });

            // Queue the workflow continuation with the concurrently-resolved trace carrier
            await queueMessage(world, getWorkflowQueueName(workflowName), {
              runId: workflowRunId,
              traceCarrier,
              requestedAt: new Date(),
            });
            return;
          } catch (err: unknown) {
            const normalizedError = await normalizeUnknownError(err);
            const normalizedStack =
              normalizedError.stack || getErrorStack(err) || '';

            // Record exception for OTEL error tracking
            if (err instanceof Error) {
              span?.recordException?.(err);
            }

            // Determine error category and retryability
            const isFatal = FatalError.is(err);
            const isRetryable = RetryableError.is(err);
            const errorCategory = isFatal
              ? 'fatal'
              : isRetryable
                ? 'retryable'
                : 'transient';

            span?.setAttributes({
              ...Attribute.StepErrorName(getErrorName(err)),
              ...Attribute.StepErrorMessage(normalizedError.message),
              ...Attribute.ErrorType(getErrorName(err)),
              ...Attribute.ErrorCategory(errorCategory),
              ...Attribute.ErrorRetryable(!isFatal),
            });

            if (WorkflowAPIError.is(err)) {
              if (err.status === 410) {
                // Workflow has already completed, so no-op
                stepLogger.info(
                  'Workflow run already completed, skipping step',
                  {
                    workflowRunId,
                    stepId,
                    message: err.message,
                  }
                );
                return;
              }

              // Server errors (5xx) from workflow-server are treated as persistent
              // infrastructure issues. The withServerErrorRetry wrapper already
              // retried the call a few times; if we still have a 5xx here it's
              // likely persistent. Re-throw so the queue can retry the job and
              // re-invoke this handler. Note: by the time we reach this point,
              // step_started has already run and incremented step.attempt, and a
              // subsequent queue retry may increment attempts again depending on
              // storage semantics, so these retries are not guaranteed to be
              // "free" with respect to step attempts.
              if (err.status !== undefined && err.status >= 500) {
                runtimeLogger.warn(
                  'Persistent server error (5xx) during step, deferring to queue retry',
                  {
                    status: err.status,
                    workflowRunId,
                    stepId,
                    error: err.message,
                    url: err.url,
                  }
                );
                throw err;
              }
            }

            if (isFatal) {
              stepLogger.error(
                'Encountered FatalError while executing step, bubbling up to parent workflow',
                {
                  workflowRunId,
                  stepName,
                  errorStack: normalizedStack,
                }
              );
              // Fail the step via event (event-sourced architecture)
              await withServerErrorRetry(() =>
                world.events.create(workflowRunId, {
                  eventType: 'step_failed',
                  specVersion: SPEC_VERSION_CURRENT,
                  correlationId: stepId,
                  eventData: {
                    error: normalizedError.message,
                    stack: normalizedStack,
                  },
                })
              );

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
                const retryCount = step.attempt - 1;
                stepLogger.error(
                  'Max retries reached, bubbling error to parent workflow',
                  {
                    workflowRunId,
                    stepName,
                    attempt: step.attempt,
                    retryCount,
                    errorStack: normalizedStack,
                  }
                );
                const errorMessage = `Step "${stepName}" failed after ${maxRetries} ${pluralize('retry', 'retries', maxRetries)}: ${normalizedError.message}`;
                // Fail the step via event (event-sourced architecture)
                await withServerErrorRetry(() =>
                  world.events.create(workflowRunId, {
                    eventType: 'step_failed',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: stepId,
                    eventData: {
                      error: errorMessage,
                      stack: normalizedStack,
                    },
                  })
                );

                span?.setAttributes({
                  ...Attribute.StepStatus('failed'),
                  ...Attribute.StepRetryExhausted(true),
                });
              } else {
                // Not at max retries yet - log as a retryable error
                if (RetryableError.is(err)) {
                  stepLogger.warn(
                    'Encountered RetryableError, step will be retried',
                    {
                      workflowRunId,
                      stepName,
                      attempt: currentAttempt,
                      message: err.message,
                    }
                  );
                } else {
                  stepLogger.warn('Encountered Error, step will be retried', {
                    workflowRunId,
                    stepName,
                    attempt: currentAttempt,
                    errorStack: normalizedStack,
                  });
                }
                // Set step to pending for retry via event (event-sourced architecture)
                // step_retrying records the error and sets status to pending
                await withServerErrorRetry(() =>
                  world.events.create(workflowRunId, {
                    eventType: 'step_retrying',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: stepId,
                    eventData: {
                      error: normalizedError.message,
                      stack: normalizedStack,
                      ...(RetryableError.is(err) && {
                        retryAfter: err.retryAfter,
                      }),
                    },
                  })
                );

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

                // Add span event for retry scheduling
                span?.addEvent?.('retry.scheduled', {
                  'retry.timeout_seconds': timeoutSeconds,
                  'retry.attempt': currentAttempt,
                  'retry.max_retries': maxRetries,
                });

                // It's a retryable error - so have the queue keep the message visible
                // so that it gets retried.
                return { timeoutSeconds };
              }
            }
          }

          await queueMessage(world, getWorkflowQueueName(workflowName), {
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
