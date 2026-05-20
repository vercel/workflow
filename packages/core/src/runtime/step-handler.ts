import { waitUntil } from '@vercel/functions';
import {
  EntityConflictError,
  FatalError,
  RetryableError,
  RunExpiredError,
  StepNotRegisteredError,
  ThrottleError,
  TooEarlyError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { formatStepName, pluralize } from '@workflow/utils';
import { getPort } from '@workflow/utils/get-port';
import { SPEC_VERSION_CURRENT, StepInvokePayloadSchema } from '@workflow/world';
import { describeError } from '../describe-error.js';
import { runtimeLogger, stepLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
import {
  cancelAbortReaders,
  dehydrateStepError,
  dehydrateStepReturnValue,
  hydrateStepArguments,
  hydrateStepError,
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
import { MAX_QUEUE_DELIVERIES } from './constants.js';
import {
  getQueueOverhead,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  memoizeEncryptionKey,
  parseHealthCheckPayload,
  queueMessage,
  withHealthCheck,
} from './helpers.js';
import { getWorld, getWorldHandlers, type WorldHandlers } from './world.js';

const DEFAULT_STEP_MAX_RETRIES = 3;

const stepHandler = (worldHandlers: WorldHandlers) =>
  worldHandlers.createQueueHandler(
    '__wkf_step_',
    async (message_, metadata) => {
      // Check if this is a health check message
      // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
      // They only write a simple status response to a stream and do not expose sensitive data.
      // The stream name includes a unique correlationId that must be known by the caller.
      const healthCheck = parseHealthCheckPayload(message_);
      if (healthCheck) {
        await handleHealthCheckMessage(
          healthCheck,
          'step',
          worldHandlers.specVersion
        );
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
      const { requestId } = metadata;

      // --- Max delivery check ---
      // Enforce max delivery limit before any infrastructure calls.
      // This prevents runaway steps from consuming infinite queue deliveries.
      // At this point, we want to do the minimal amount of work (no fetching
      // of the step details, etc. We simply attempt to mark the step as failed
      // and enqueue the workflow once, and if either of those fails, the message
      // is still consumed but with adequate logging that an error occurred.
      // Scoped logger for this step invocation — attaches run/step context to
      // every log line below so callers don't repeat it.
      const stepNameFromQueue = metadata.queueName.slice('__wkf_step_'.length);
      const stepRuntimeLogger = runtimeLogger.forRun(
        workflowRunId,
        workflowName,
        { stepId, stepName: stepNameFromQueue }
      );

      if (metadata.attempt > MAX_QUEUE_DELIVERIES) {
        stepRuntimeLogger.error(
          `Step handler exceeded max deliveries (${metadata.attempt}/${MAX_QUEUE_DELIVERIES})`,
          {
            attempt: metadata.attempt,
          }
        );
        try {
          const world = await getWorld();
          const getEncryptionKey = memoizeEncryptionKey(world, workflowRunId);
          const err = new FatalError(
            `Step exceeded maximum queue deliveries (${metadata.attempt}/${MAX_QUEUE_DELIVERIES})`
          );
          await world.events.create(
            workflowRunId,
            {
              eventType: 'step_failed',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: stepId,
              eventData: {
                stepName: stepNameFromQueue,
                error: await dehydrateStepError(
                  err,
                  workflowRunId,
                  await getEncryptionKey()
                ),
              },
            },
            { requestId }
          );
          // Re-queue the workflow to handle the failed step
          await queueMessage(world, getWorkflowQueueName(workflowName), {
            runId: workflowRunId,
            traceCarrier: await serializeTraceCarrier(),
            requestedAt: new Date(),
          });
        } catch (err) {
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            return;
          }
          // Can't even mark the step as failed. Consume the message to stop
          // further retries. The run will remain in its current state.
          stepRuntimeLogger.error(
            `Failed to mark step as failed after ${metadata.attempt} delivery attempts. ` +
              `A persistent error is preventing the step from being terminated. ` +
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
      // Execute step within the propagated trace context
      return await withTraceContext(traceContext, async () => {
        // Extract the step name from the topic name
        const stepName = metadata.queueName.slice('__wkf_step_'.length);
        const world = await getWorld();
        const isVercel = process.env.VERCEL_URL !== undefined;

        // Memoized accessor for the per-run AES-256 encryption key. The first
        // caller (typically `hydrateStepArguments` for input deserialization,
        // or one of the early-return dehydrateStepError paths if step_started
        // fails) triggers the actual fetch / HKDF derivation; subsequent
        // callers await the cached promise. Steps that fail before any
        // encryption-aware work happens (e.g. an immediate step_started
        // conflict) skip the fetch entirely.
        const getEncryptionKey = memoizeEncryptionKey(world, workflowRunId);

        // Resolve local async values concurrently before entering the trace span
        const [port, spanKind] = await Promise.all([
          isVercel ? undefined : getPort(),
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

            // Note: Step function validation happens after step_started so we can
            // properly fail the step (not the run) if the function is not registered.
            // This allows the workflow to handle the step failure gracefully.
            const stepFn = getStepFunction(stepName);

            span?.setAttributes({
              ...Attribute.WorkflowName(workflowName),
              ...Attribute.WorkflowRunId(workflowRunId),
              ...Attribute.StepId(stepId),
              ...Attribute.StepTracePropagated(!!traceContext),
            });

            // step_started validates state and returns the step entity, so no separate
            // world.steps.get() call is needed. The server checks:
            // - Step not in terminal state (returns 409)
            // - retryAfter timestamp reached (returns 425 with Retry-After header)
            // - Workflow still active (returns 410 if completed)
            let step;
            try {
              const startResult = await world.events.create(
                workflowRunId,
                {
                  eventType: 'step_started',
                  specVersion: SPEC_VERSION_CURRENT,
                  correlationId: stepId,
                  eventData: { stepName },
                },
                { requestId }
              );

              if (!startResult.step) {
                throw new WorkflowRuntimeError(
                  `step_started event for "${stepId}" did not return step entity`
                );
              }
              step = startResult.step;
            } catch (err) {
              if (ThrottleError.is(err)) {
                const retryRetryAfter = Math.max(
                  1,
                  typeof err.retryAfter === 'number' ? err.retryAfter : 1
                );
                stepRuntimeLogger.info(
                  'Throttled again on retry, deferring to queue',
                  {
                    retryAfterSeconds: retryRetryAfter,
                  }
                );
                return { timeoutSeconds: retryRetryAfter };
              }
              if (RunExpiredError.is(err)) {
                // Expected when a run is cancelled while a step is in-flight.
                stepRuntimeLogger.info(
                  'Workflow run has already completed, skipping step',
                  { errorName: err.name, errorMessage: err.message }
                );
                return;
              }
              if (EntityConflictError.is(err)) {
                // Step already in a terminal state — another worker finished
                // it or it was retried to completion. Re-enqueue the parent
                // workflow so it can observe the outcome.
                stepRuntimeLogger.debug(
                  'Step in terminal state, re-enqueuing workflow',
                  {
                    errorName: err.name,
                    errorMessage: err.message,
                  }
                );
                span?.setAttributes({
                  ...Attribute.StepSkipped(true),
                  ...Attribute.StepSkipReason('completed'),
                });
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

              // Too early: retryAfter timestamp not reached yet
              // Return timeout to queue so it retries later
              if (TooEarlyError.is(err)) {
                const timeoutSeconds = Math.max(1, err.retryAfter ?? 1);
                span?.setAttributes({
                  ...Attribute.StepRetryTimeoutSeconds(timeoutSeconds),
                });
                // Add span event for delayed retry
                span?.addEvent?.('step.delayed', {
                  'delay.reason': 'retry_after_not_reached',
                  'delay.timeout_seconds': timeoutSeconds,
                });
                stepRuntimeLogger.debug(
                  'Step retryAfter timestamp not yet reached',
                  {
                    retryAfterSeconds: err.retryAfter,
                    timeoutSeconds,
                  }
                );
                return { timeoutSeconds };
              }
              // Re-throw other errors
              throw err;
            }

            stepRuntimeLogger.debug('Step execution details', {
              status: step.status,
              attempt: step.attempt,
            });

            span?.setAttributes({
              ...Attribute.StepStatus(step.status),
            });

            // Validate step function exists AFTER step_started so we can
            // properly fail the step (not the run) if the function is missing.
            // This allows the workflow to handle the step failure gracefully,
            // similar to how FatalError is handled.
            if (!stepFn || typeof stepFn !== 'function') {
              const err = new StepNotRegisteredError(stepName);

              stepRuntimeLogger.error(
                'Step function not registered, failing step (not run)',
                {
                  errorName: err.name,
                  errorMessage: err.message,
                  errorStack: err.stack,
                }
              );

              // Fail the step via event (event-sourced architecture)
              // This matches the FatalError pattern - fail the step and re-queue workflow
              try {
                await world.events.create(
                  workflowRunId,
                  {
                    eventType: 'step_failed',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: stepId,
                    eventData: {
                      stepName,
                      error: await dehydrateStepError(
                        err,
                        workflowRunId,
                        await getEncryptionKey()
                      ),
                    },
                  },
                  { requestId }
                );
              } catch (stepFailErr) {
                if (EntityConflictError.is(stepFailErr)) {
                  // Step already transitioned to a terminal state — duplicate
                  // delivery or concurrent cancellation. Drop silently.
                  stepRuntimeLogger.info(
                    'Tried failing step for missing function, but step has already finished.',
                    {
                      errorName: stepFailErr.name,
                      errorMessage: stepFailErr.message,
                    }
                  );
                  return;
                }
                throw stepFailErr;
              }

              span?.setAttributes({
                ...Attribute.StepStatus('failed'),
                ...Attribute.StepFatalError(true),
              });

              // Re-invoke the workflow to handle the failed step
              await queueMessage(world, getWorkflowQueueName(workflowName), {
                runId: workflowRunId,
                traceCarrier: await serializeTraceCarrier(),
                requestedAt: new Date(),
              });
              return;
            }

            const maxRetries = stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;

            span?.setAttributes({
              ...Attribute.StepMaxRetries(maxRetries),
            });

            let result: unknown;

            // Check max retries AFTER step_started (attempt was just incremented)
            // step.attempt tracks how many times step_started has been called.
            // Note: maxRetries is the number of RETRIES after the first attempt, so total attempts = maxRetries + 1
            // Use > here (not >=) because this guards against re-invocation AFTER all attempts are used.
            // The post-failure check uses >= to decide whether to retry after a failure.
            if (step.attempt > maxRetries + 1) {
              const retryCount = step.attempt - 1;
              // Persisted message — kept short, no machine `stepName`,
              // since observability already attributes the event to a
              // specific step.
              const errorMessage = `Step exceeded max retries (${retryCount} ${pluralize('retry', 'retries', retryCount)})`;
              stepLogger.error(
                `Step ${formatStepName(stepName)} exceeded max retries (${retryCount} ${pluralize('retry', 'retries', retryCount)})`,
                {
                  workflowRunId,
                  workflowName,
                  stepId,
                  stepName,
                  retryCount,
                }
              );
              // Fail the step via event (event-sourced architecture).
              // Preserve the prior attempt's serialized error as the cause so
              // the underlying failure is recoverable from `step.error.cause`
              // after hydration, without forcing consumers to walk the
              // step_retrying event history. Mirrors the post-failure path
              // below that wraps the live `err` as cause.
              const wrappedError = new FatalError(errorMessage);
              if (step.error != null) {
                try {
                  (wrappedError as Error).cause = await hydrateStepError(
                    step.error,
                    workflowRunId,
                    await getEncryptionKey()
                  );
                } catch {
                  // Ignore: best-effort cause attachment, the wrapping
                  // FatalError stack/message still surface the failure.
                }
              }
              try {
                await world.events.create(
                  workflowRunId,
                  {
                    eventType: 'step_failed',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: stepId,
                    eventData: {
                      stepName,
                      error: await dehydrateStepError(
                        wrappedError,
                        workflowRunId,
                        await getEncryptionKey()
                      ),
                    },
                  },
                  { requestId }
                );
              } catch (err) {
                if (EntityConflictError.is(err)) {
                  // Step already transitioned to a terminal state — duplicate
                  // delivery or concurrent completion. Drop silently.
                  stepRuntimeLogger.info(
                    'Tried failing step, but step has already finished.',
                    {
                      errorName: err.name,
                      errorMessage: err.message,
                    }
                  );
                  return;
                }
                throw err;
              }

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

            // --- Infrastructure: prepare step input ---
            // Network/server errors propagate to the queue handler for retry.
            // WorkflowRuntimeError (data integrity issues) are fatal — retrying
            // won't fix them, so we re-queue the workflow to surface the error.
            // step_started already validated the step is in valid state (pending/running)
            // and returned the updated step entity with incremented attempt

            // step.attempt is now the current attempt number (after increment)
            const attempt = step.attempt;

            if (!step.startedAt) {
              const errorMessage = `Step "${stepId}" has no "startedAt" timestamp`;
              stepRuntimeLogger.error('Fatal runtime error during step setup', {
                errorMessage,
              });
              try {
                await world.events.create(
                  workflowRunId,
                  {
                    eventType: 'step_failed',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: stepId,
                    eventData: {
                      stepName,
                      error: await dehydrateStepError(
                        new FatalError(errorMessage),
                        workflowRunId,
                        await getEncryptionKey()
                      ),
                    },
                  },
                  { requestId }
                );
              } catch (failErr) {
                if (EntityConflictError.is(failErr)) {
                  return;
                }
                throw failErr;
              }
              // Re-queue the workflow so it can process the step failure
              await queueMessage(world, getWorkflowQueueName(workflowName), {
                runId: workflowRunId,
                traceCarrier: await serializeTraceCarrier(),
                requestedAt: new Date(),
              });
              return;
            }
            // Capture startedAt for use in async callback (TypeScript narrowing doesn't persist)
            const stepStartedAt = step.startedAt;

            // Resolve the encryption key now that we're committed to running
            // user code: input hydration needs it, and `contextStorage` (and
            // any user-code paths that run inside it) capture the resolved
            // value. Triggers the underlying world / KMS fetch once, with
            // subsequent dehydrate paths reusing the memoized result.
            const encryptionKey = await getEncryptionKey();

            // Hydrate the step input arguments, closure variables, and thisVal
            // NOTE: This captures only the synchronous portion of hydration. Any async
            // operations (e.g., stream loading) are added to `ops` and executed later
            // via Promise.all(ops) - their timing is not included in this measurement.
            const ops: Promise<void>[] = [];
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

            // --- User code execution ---
            // Only errors from stepFn.apply() (user step code) should produce
            // step_failed/step_retrying. Infrastructure errors (network, server)
            // must propagate to the queue handler for automatic retry.
            let userCodeError: unknown;
            let userCodeFailed = false;

            const executionStartTime = Date.now();
            try {
              result = await trace('step.execute', {}, async () => {
                return await contextStorage.run(
                  {
                    stepMetadata: {
                      stepName,
                      stepId,
                      stepStartedAt: new Date(+stepStartedAt),
                      attempt,
                    },
                    workflowMetadata: {
                      workflowName,
                      workflowRunId,
                      workflowStartedAt: new Date(+workflowStartedAt),
                      // TODO: there should be a getUrl method on the world interface itself. This
                      // solution only works for vercel + local worlds.
                      url: isVercel
                        ? `https://${process.env.VERCEL_URL}`
                        : `http://localhost:${port ?? 3000}`,
                      features: { encryption: !!encryptionKey },
                    },
                    ops,
                    closureVars: hydratedInput.closureVars,
                    encryptionKey,
                  },
                  () => stepFn.apply(thisVal, args)
                );
              });
            } catch (err) {
              userCodeError = err;
              userCodeFailed = true;
            }
            const executionTimeMs = Date.now() - executionStartTime;

            cancelAbortReaders(...args, thisVal, hydratedInput.closureVars);

            span?.setAttributes({
              ...Attribute.QueueExecutionTimeMs(executionTimeMs),
            });

            // --- Dehydrate (serialize) the step's return value ---
            // A non-serializable return value is a user-code bug, not an
            // infrastructure failure. Route it through the same step-failure
            // path as a thrown error so SerializationError (which is marked
            // `fatal: true`) short-circuits the retry loop instead of
            // bubbling as an HTTP 500 and burning through all 4 queue
            // deliveries on a guaranteed-to-fail message.
            if (!userCodeFailed) {
              try {
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
              } catch (err) {
                userCodeError = err;
                userCodeFailed = true;
              }
            }

            // --- Handle user code errors ---
            if (userCodeFailed) {
              const err = userCodeError;

              // Infrastructure errors that somehow surfaced through user code
              // should propagate to the queue handler for retry, not consume
              // step attempts.
              if (RunExpiredError.is(err)) {
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
              if (WorkflowWorldError.is(err)) {
                if (err.status !== undefined && err.status >= 500) {
                  throw err;
                }
              }

              // Wrap AbortError in FatalError — abort is intentional cancellation, not retryable
              let effectiveErr: unknown = err;
              if (
                err instanceof Error &&
                err.name === 'AbortError' &&
                !FatalError.is(err)
              ) {
                const fatalErr = new FatalError(`Aborted: ${err.message}`);
                fatalErr.stack = err.stack;
                effectiveErr = fatalErr;
              }
              const normalizedError = await normalizeUnknownError(effectiveErr);
              const normalizedStack =
                normalizedError.stack || getErrorStack(effectiveErr) || '';

              // Record exception for OTEL error tracking
              if (effectiveErr instanceof Error) {
                span?.recordException?.(effectiveErr);
              }

              // Determine error category and retryability
              const isFatal = FatalError.is(effectiveErr);
              const isRetryable = RetryableError.is(effectiveErr);
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

              if (isFatal) {
                const description = describeError(err);
                const friendlyStep = formatStepName(stepName);
                const framing =
                  description.attribution === 'sdk'
                    ? `Step ${friendlyStep} failed with a FatalError from the SDK runtime — bubbling up to parent workflow`
                    : `Step ${friendlyStep} threw a FatalError — bubbling up to parent workflow`;
                // Mirror the workflow-level log formatting: put the framing +
                // stack into the message so console.error renders the stack
                // inline, and keep the metadata object small with only the
                // structured fields that log drains want to index.
                // No `hint` field here — actionable hint text lives on the
                // error message itself (so it survives serialization →
                // event log → observability rehydrate), and adding it
                // again here just duplicates it on stderr.
                stepLogger.error(
                  `${framing}\n${normalizedStack || normalizedError.message}`,
                  {
                    workflowRunId,
                    stepId,
                    stepName,
                    errorAttribution: description.attribution,
                    errorName: normalizedError.name,
                    errorMessage: normalizedError.message,
                  }
                );
                // Fail the step via event (event-sourced architecture).
                // Serialize the original thrown value so its full type identity
                // and custom properties round-trip through the event log.
                try {
                  await world.events.create(
                    workflowRunId,
                    {
                      eventType: 'step_failed',
                      specVersion: SPEC_VERSION_CURRENT,
                      correlationId: stepId,
                      eventData: {
                        stepName,
                        error: await dehydrateStepError(
                          err,
                          workflowRunId,
                          encryptionKey
                        ),
                      },
                    },
                    { requestId }
                  );
                } catch (stepFailErr) {
                  if (EntityConflictError.is(stepFailErr)) {
                    // Step already in terminal state — idempotent.
                    stepRuntimeLogger.info(
                      'Tried failing step, but step has already finished.',
                      {
                        errorName: stepFailErr.name,
                        errorMessage: stepFailErr.message,
                      }
                    );
                    return;
                  }
                  throw stepFailErr;
                }

                span?.setAttributes({
                  ...Attribute.StepStatus('failed'),
                  ...Attribute.StepFatalError(true),
                });
              } else {
                const maxRetries =
                  stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
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
                  const description = describeError(err);
                  const friendlyStep = formatStepName(stepName);
                  const framing =
                    description.attribution === 'sdk'
                      ? `Step ${friendlyStep} hit max retries on an SDK runtime error — bubbling to parent workflow`
                      : `Step ${friendlyStep} hit max retries — bubbling error thrown by your step to the parent workflow`;
                  stepLogger.error(
                    `${framing}\n${normalizedStack || normalizedError.message}`,
                    {
                      workflowRunId,
                      workflowName,
                      stepId,
                      stepName,
                      attempt: step.attempt,
                      retryCount,
                      errorAttribution: description.attribution,
                      errorName: normalizedError.name,
                      errorMessage: normalizedError.message,
                    }
                  );
                  // Don't include the machine step name in the persisted
                  // error message — observability already shows which step
                  // produced the event, and `stepName: 'step//./.../foo'`
                  // in the title is just noise. The CLI logger renders
                  // `Step foo (./...) hit max retries` separately.
                  const errorMessage = `Step failed after ${maxRetries} ${pluralize('retry', 'retries', maxRetries)}: ${normalizedError.message}`;
                  // Fail the step via event (event-sourced architecture).
                  // Wrap the original error with a FatalError that preserves
                  // the wrapped message plus the original thrown value as
                  // `cause` so it's recoverable after hydration.
                  const wrappedError = new FatalError(errorMessage);
                  (wrappedError as Error).cause = err;
                  if (normalizedStack) wrappedError.stack = normalizedStack;
                  try {
                    await world.events.create(
                      workflowRunId,
                      {
                        eventType: 'step_failed',
                        specVersion: SPEC_VERSION_CURRENT,
                        correlationId: stepId,
                        eventData: {
                          stepName,
                          error: await dehydrateStepError(
                            wrappedError,
                            workflowRunId,
                            encryptionKey
                          ),
                        },
                      },
                      { requestId }
                    );
                  } catch (stepFailErr) {
                    if (EntityConflictError.is(stepFailErr)) {
                      // Step already in terminal state — idempotent.
                      stepRuntimeLogger.info(
                        'Tried failing step, but step has already finished.',
                        {
                          errorName: stepFailErr.name,
                          errorMessage: stepFailErr.message,
                        }
                      );
                      return;
                    }
                    throw stepFailErr;
                  }

                  span?.setAttributes({
                    ...Attribute.StepStatus('failed'),
                    ...Attribute.StepRetryExhausted(true),
                  });
                } else {
                  // Not at max retries yet - log as a retryable error
                  if (RetryableError.is(err)) {
                    stepLogger.info(
                      'Encountered RetryableError, step will be retried',
                      {
                        workflowRunId,
                        workflowName,
                        stepId,
                        stepName,
                        attempt: currentAttempt,
                        errorName: err.name,
                        errorMessage: err.message,
                        errorStack: normalizedStack,
                      }
                    );
                  } else {
                    stepLogger.info('Encountered Error, step will be retried', {
                      workflowRunId,
                      workflowName,
                      stepId,
                      stepName,
                      attempt: currentAttempt,
                      errorName: normalizedError.name,
                      errorMessage: normalizedError.message,
                      errorStack: normalizedStack,
                    });
                  }
                  // Set step to pending for retry via event (event-sourced architecture)
                  // step_retrying records the error and sets status to pending.
                  // Serialize the original thrown value so its full type identity
                  // and custom properties round-trip through the event log.
                  try {
                    await world.events.create(
                      workflowRunId,
                      {
                        eventType: 'step_retrying',
                        specVersion: SPEC_VERSION_CURRENT,
                        correlationId: stepId,
                        eventData: {
                          stepName,
                          error: await dehydrateStepError(
                            err,
                            workflowRunId,
                            encryptionKey
                          ),
                          ...(RetryableError.is(err) && {
                            retryAfter: err.retryAfter,
                          }),
                        },
                      },
                      { requestId }
                    );
                  } catch (stepRetryErr) {
                    if (EntityConflictError.is(stepRetryErr)) {
                      // Step already in terminal state — idempotent.
                      stepRuntimeLogger.info(
                        'Tried retrying step, but step has already finished.',
                        {
                          errorName: stepRetryErr.name,
                          errorMessage: stepRetryErr.message,
                        }
                      );
                      return;
                    }
                    throw stepRetryErr;
                  }

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

              // Re-invoke the workflow to handle the failed/retrying step
              await queueMessage(world, getWorkflowQueueName(workflowName), {
                runId: workflowRunId,
                traceCarrier: await serializeTraceCarrier(),
                requestedAt: new Date(),
              });
              return;
            }

            // --- Infrastructure: complete the step ---
            // Errors here (network failures, server errors) propagate to the
            // queue handler for automatic retry.
            //
            // NOTE: None of the code from this point is guaranteed to run.
            // Since the step might fail or cause a function timeout and the
            // process might be SIGKILL'd, the workflow runtime must be
            // resilient to the below code not executing on a failed step.
            // (Dehydration already happened above and is accounted for in the
            // userCodeFailed path.)
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
            let stepCompleted409 = false;
            const [, traceCarrier] = await Promise.all([
              world.events
                .create(
                  workflowRunId,
                  {
                    eventType: 'step_completed',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: stepId,
                    eventData: {
                      stepName,
                      result: result as Uint8Array,
                    },
                  },
                  { requestId }
                )
                .catch((err: unknown) => {
                  if (EntityConflictError.is(err)) {
                    // Step already in terminal state — idempotent.
                    stepRuntimeLogger.info(
                      'Tried completing step, but step has already finished.',
                      {
                        errorName: err.name,
                        errorMessage: err.message,
                      }
                    );
                    stepCompleted409 = true;
                    return;
                  }
                  throw err;
                }),
              serializeTraceCarrier(),
            ]);

            if (stepCompleted409) {
              return;
            }

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
let cachedStepHandler: ((req: Request) => Promise<Response>) | undefined;
export const stepEntrypoint: (req: Request) => Promise<Response> =
  /* @__PURE__ */ withHealthCheck(async (req) => {
    if (!cachedStepHandler) {
      cachedStepHandler = stepHandler(await getWorldHandlers());
    }
    return cachedStepHandler(req);
  });
