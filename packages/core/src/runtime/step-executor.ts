import { types } from 'node:util';
import { waitUntil } from '@vercel/functions';
import {
  EntityConflictError,
  FatalError,
  RetryableError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { pluralize } from '@workflow/utils';
import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import type { CryptoKey } from '../encryption.js';
import { runtimeLogger, stepLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
import {
  dehydrateStepError,
  dehydrateStepReturnValue,
  hydrateStepArguments,
  hydrateStepError,
} from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { trace } from '../telemetry.js';
import {
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
  promoteAbortErrorToFatal,
} from '../types.js';
import { getPortLazy } from './get-port-lazy.js';
import { memoizeEncryptionKey } from './helpers.js';

const DEFAULT_STEP_MAX_RETRIES = 3;

export interface StepExecutorParams {
  world: World;
  workflowRunId: string;
  /** Deployment that owns the workflow run, for forwarded writable streams. */
  workflowDeploymentId?: string;
  workflowName: string;
  workflowStartedAt: number;
  stepId: string;
  stepName: string;
  encryptionKey?: CryptoKey;
}

/**
 * Result of a step execution attempt. The caller decides what to do
 * based on the result type (e.g., queue workflow continuation, replay inline, etc.).
 */
export type StepExecutionResult =
  | { type: 'completed'; hasPendingOps?: boolean }
  | { type: 'failed' }
  | { type: 'retry'; timeoutSeconds: number }
  | { type: 'skipped' }
  | { type: 'gone' }
  | { type: 'throttled'; timeoutSeconds: number };

/**
 * Executes a single step: creates step_started event, hydrates input,
 * runs the step function, creates step_completed/step_failed/step_retrying events.
 *
 * Does NOT queue workflow continuation messages — the caller decides what to do next.
 * Used by both the V1 step handler and the V2 combined handler.
 */
export async function executeStep(
  params: StepExecutorParams
): Promise<StepExecutionResult> {
  const {
    world,
    workflowRunId,
    workflowName,
    workflowStartedAt,
    stepId,
    stepName,
  } = params;
  const isVercel = process.env.VERCEL_URL !== undefined;

  return trace(`STEP ${stepName}`, {}, async (span) => {
    span?.setAttributes({
      ...Attribute.StepName(stepName),
      ...Attribute.WorkflowName(workflowName),
      ...Attribute.WorkflowRunId(workflowRunId),
      ...Attribute.StepId(stepId),
    });

    // Memoized accessor for the per-run encryption key. The first caller
    // (input hydration on the success path, or one of the early-return
    // dehydrateStepError paths if step_started fails) triggers the actual
    // fetch / HKDF derivation; subsequent callers await the cached promise.
    const getEncryptionKey = memoizeEncryptionKey(world, workflowRunId);

    const stepFn = getStepFunction(stepName);
    if (!stepFn || typeof stepFn !== 'function') {
      // Step function not registered — fail the step immediately (not the run).
      // This matches the V1 step handler pattern: create step_failed event so
      // the workflow can handle it gracefully via try/catch in user code.
      const errorMessage = `Step "${stepName}" is not registered in the current deployment. This usually indicates a build or bundling issue that caused the step to not be included in the deployment.`;
      runtimeLogger.error('Step function not registered, failing step', {
        workflowRunId,
        stepName,
        stepId,
      });
      try {
        await world.events.create(workflowRunId, {
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
        });
      } catch (stepFailErr) {
        if (EntityConflictError.is(stepFailErr)) {
          return { type: 'skipped' };
        }
        throw stepFailErr;
      }
      span?.setAttributes({
        ...Attribute.StepStatus('failed'),
        ...Attribute.StepFatalError(true),
      });
      return { type: 'failed' };
    }

    const maxRetries = stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;

    span?.setAttributes({
      ...Attribute.StepMaxRetries(maxRetries),
    });

    // step_started validates state and returns the step entity
    let step;
    try {
      const startResult = await world.events.create(workflowRunId, {
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: stepId,
        eventData: { stepName },
      });

      if (!startResult.step) {
        throw new WorkflowRuntimeError(
          `step_started event for "${stepId}" did not return step entity`
        );
      }
      step = startResult.step;
    } catch (err) {
      if (ThrottleError.is(err)) {
        const retryAfter = Math.max(
          1,
          typeof err.retryAfter === 'number' ? err.retryAfter : 1
        );
        runtimeLogger.info('Throttled on step_started, deferring', {
          retryAfterSeconds: retryAfter,
        });
        return { type: 'throttled', timeoutSeconds: retryAfter };
      }
      if (RunExpiredError.is(err)) {
        runtimeLogger.info(
          `Workflow run "${workflowRunId}" has already completed, skipping step "${stepId}": ${err.message}`
        );
        return { type: 'gone' };
      }
      if (EntityConflictError.is(err)) {
        runtimeLogger.debug('Step in terminal state, skipping', {
          stepName,
          stepId,
          workflowRunId,
          error: err.message,
        });
        span?.setAttributes({
          ...Attribute.StepSkipped(true),
          ...Attribute.StepSkipReason('completed'),
        });
        return { type: 'skipped' };
      }
      if (TooEarlyError.is(err)) {
        const timeoutSeconds = Math.max(1, err.retryAfter ?? 1);
        runtimeLogger.debug('Step retryAfter timestamp not yet reached', {
          stepName,
          stepId,
          timeoutSeconds,
        });
        return { type: 'retry', timeoutSeconds };
      }
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

    // Check max retries AFTER step_started (attempt was just incremented).
    // Only enforce when the step has a previous error — this distinguishes
    // actual retries (failed → retry) from concurrent starts (V2 inline
    // execution loop can cause multiple handlers to step_started the same
    // step simultaneously, inflating the attempt counter without any failure).
    if (step.attempt > maxRetries + 1 && step.error) {
      const retryCount = step.attempt - 1;
      const errorMessage = `Step "${stepName}" exceeded max retries (${retryCount} ${pluralize('retry', 'retries', retryCount)})`;
      stepLogger.error('Step exceeded max retries', {
        workflowRunId,
        stepName,
        retryCount,
      });
      // Preserve the prior attempt's serialized error as the cause so the
      // underlying failure is recoverable from `step.error.cause` after
      // hydration, without forcing consumers to walk the step_retrying
      // event history. Best-effort: if hydration of the prior `step.error`
      // throws, fall back to a FatalError without cause.
      const wrappedError = new FatalError(errorMessage);
      if (step.error != null) {
        try {
          (wrappedError as Error).cause = await hydrateStepError(
            step.error,
            workflowRunId,
            await getEncryptionKey()
          );
        } catch {
          // Ignore — best-effort cause attachment.
        }
      }
      try {
        await world.events.create(workflowRunId, {
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
        });
      } catch (err) {
        if (EntityConflictError.is(err)) {
          runtimeLogger.info(
            'Tried failing step, but step has already finished.',
            {
              workflowRunId,
              stepId,
              stepName,
              message: err.message,
            }
          );
          return { type: 'skipped' };
        }
        throw err;
      }
      span?.setAttributes({
        ...Attribute.StepStatus('failed'),
        ...Attribute.StepRetryExhausted(true),
      });
      return { type: 'failed' };
    }

    try {
      const attempt = step.attempt;

      if (!step.startedAt) {
        throw new WorkflowRuntimeError(
          `Step "${stepId}" has no "startedAt" timestamp`
        );
      }
      const stepStartedAt = step.startedAt;
      const ops: Promise<void>[] = [];
      // Use the provided encryption key when available, otherwise resolve
      // through the memoized accessor declared at the top of this trace.
      const encryptionKey = params.encryptionKey ?? (await getEncryptionKey());
      const hydratedInput = await trace(
        'step.hydrate',
        {},
        async (hydrateSpan) => {
          const startTime = Date.now();
          const hydrated = await hydrateStepArguments(
            step.input,
            workflowRunId,
            encryptionKey,
            ops,
            globalThis,
            {},
            params.workflowDeploymentId
          );
          const durationMs = Date.now() - startTime;
          hydrateSpan?.setAttributes({
            ...Attribute.StepArgumentsCount(hydrated.args.length),
            ...Attribute.QueueDeserializeTimeMs(durationMs),
          });
          return hydrated;
        }
      );

      const args = hydratedInput.args;
      const thisVal = hydratedInput.thisVal ?? null;
      const port = isVercel ? undefined : await getPortLazy();

      const executionStartTime = Date.now();
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
              url: isVercel
                ? `https://${process.env.VERCEL_URL}`
                : `http://localhost:${port ?? 3000}`,
              features: { encryption: !!encryptionKey },
            },
            workflowDeploymentId: params.workflowDeploymentId,
            ops,
            closureVars: hydratedInput.closureVars,
            encryptionKey,
          },
          () => stepFn.apply(thisVal, args)
        );
      });
      const executionTimeMs = Date.now() - executionStartTime;

      span?.setAttributes({
        ...Attribute.QueueExecutionTimeMs(executionTimeMs),
      });

      result = await trace('step.dehydrate', {}, async (dehydrateSpan) => {
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
      });

      // Flush pending ops (stream writes, etc.) with a short inline wait.
      // Now that WorkflowServerWritableStream flushes synchronously on
      // each write (not via setTimeout), the flushablePipe's pendingOps
      // accurately reflects whether data has reached the server. Most ops
      // settle within ~200ms (100ms lock-release polling + HTTP flush).
      // If ops don't settle in 500ms (e.g., WritableStream kept open
      // across steps), waitUntil handles the rest.
      let opsSettled = true;
      if (ops.length > 0) {
        const opsPromise = Promise.all(ops).catch((err) => {
          const isAbortError =
            err?.name === 'AbortError' || err?.name === 'ResponseAborted';
          if (!isAbortError) throw err;
        });
        waitUntil(opsPromise);
        opsSettled = await Promise.race([
          opsPromise.then(() => true as const),
          new Promise<false>((r) => setTimeout(() => r(false), 500)),
        ]);
      }

      // Create step_completed event
      let stepCompleted409 = false;
      await world.events
        .create(workflowRunId, {
          eventType: 'step_completed',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: stepId,
          eventData: {
            stepName,
            result: result as Uint8Array,
          },
        })
        .catch((err) => {
          if (EntityConflictError.is(err)) {
            runtimeLogger.info(
              'Tried completing step, but step has already finished.',
              {
                workflowRunId,
                stepId,
                stepName,
                message: err.message,
              }
            );
            stepCompleted409 = true;
            return;
          }
          throw err;
        });

      if (stepCompleted409) {
        return { type: 'skipped' };
      }

      span?.setAttributes({
        ...Attribute.StepStatus('completed'),
        ...Attribute.StepResultType(typeof result),
      });

      if (ops.length > 0) {
        stepLogger.debug('Step has pending ops', {
          workflowRunId,
          stepName,
          opsCount: ops.length,
        });
      }
      // hasPendingOps signals the V2 handler to break the loop
      // and queue a continuation so waitUntil can flush them.
      return { type: 'completed', hasPendingOps: !opsSettled };
    } catch (err: unknown) {
      const effectiveErr = promoteAbortErrorToFatal(err);

      const normalizedError = await normalizeUnknownError(effectiveErr);
      const normalizedStack =
        normalizedError.stack || getErrorStack(effectiveErr) || '';

      if (effectiveErr instanceof Error) {
        span?.recordException?.(effectiveErr);
      }

      const isFatal = FatalError.is(effectiveErr);

      span?.setAttributes({
        ...Attribute.StepErrorName(getErrorName(effectiveErr)),
        ...Attribute.StepErrorMessage(normalizedError.message),
        ...Attribute.ErrorType(getErrorName(effectiveErr)),
        ...Attribute.ErrorCategory(
          isFatal
            ? 'fatal'
            : RetryableError.is(effectiveErr)
              ? 'retryable'
              : 'transient'
        ),
        ...Attribute.ErrorRetryable(!isFatal),
      });

      if (RunExpiredError.is(err)) {
        stepLogger.info('Workflow run already completed, skipping step', {
          workflowRunId,
          stepId,
          message: err.message,
        });
        return { type: 'gone' };
      }

      if (isFatal) {
        stepLogger.error(
          'Encountered FatalError while executing step, bubbling up to parent workflow',
          { workflowRunId, stepName, errorStack: normalizedStack }
        );
        // Apply the normalized stack to the thrown value so the serialized
        // error preserves it for consumers. `types.isNativeError()` works
        // across VM realms (a workflow-thrown error is an instance of the
        // VM's Error class, not the host's).
        if (types.isNativeError(effectiveErr) && normalizedStack) {
          (effectiveErr as Error).stack = normalizedStack;
        }
        try {
          await world.events.create(workflowRunId, {
            eventType: 'step_failed',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: {
              stepName,
              error: await dehydrateStepError(
                effectiveErr,
                workflowRunId,
                await getEncryptionKey()
              ),
            },
          });
        } catch (stepFailErr) {
          if (EntityConflictError.is(stepFailErr)) {
            runtimeLogger.info(
              'Tried failing step, but step has already finished.',
              {
                workflowRunId,
                stepId,
                stepName,
                message: stepFailErr.message,
              }
            );
            return { type: 'skipped' };
          }
          throw stepFailErr;
        }
        span?.setAttributes({
          ...Attribute.StepStatus('failed'),
          ...Attribute.StepFatalError(true),
        });
        return { type: 'failed' };
      }

      // Non-fatal error: check if retries remaining
      const currentAttempt = step.attempt;

      span?.setAttributes({
        ...Attribute.StepAttempt(currentAttempt),
        ...Attribute.StepMaxRetries(maxRetries),
      });

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
        // Wrap the original thrown value as `cause` on a fresh FatalError
        // so the wrapping message + retry-count framing is the user-facing
        // error while the original failure remains recoverable from
        // `err.cause` after hydration.
        const wrappedError = new FatalError(errorMessage);
        (wrappedError as Error).cause = err;
        if (normalizedStack) wrappedError.stack = normalizedStack;
        try {
          await world.events.create(workflowRunId, {
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
          });
        } catch (stepFailErr) {
          if (EntityConflictError.is(stepFailErr)) {
            runtimeLogger.info(
              'Tried failing step, but step has already finished.',
              {
                workflowRunId,
                stepId,
                stepName,
                message: stepFailErr.message,
              }
            );
            return { type: 'skipped' };
          }
          throw stepFailErr;
        }
        span?.setAttributes({
          ...Attribute.StepStatus('failed'),
          ...Attribute.StepRetryExhausted(true),
        });
        return { type: 'failed' };
      }

      // Retries remaining
      if (RetryableError.is(err)) {
        stepLogger.info('Encountered RetryableError, step will be retried', {
          workflowRunId,
          stepName,
          attempt: currentAttempt,
          message: err.message,
        });
      } else {
        stepLogger.info('Encountered Error, step will be retried', {
          workflowRunId,
          stepName,
          attempt: currentAttempt,
          errorStack: normalizedStack,
        });
      }

      // Apply the normalized stack to the thrown value so it survives
      // serialization. See the FatalError site above for why we use
      // `types.isNativeError` instead of `err instanceof Error`.
      if (types.isNativeError(err) && normalizedStack) {
        (err as Error).stack = normalizedStack;
      }
      try {
        await world.events.create(workflowRunId, {
          eventType: 'step_retrying',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: stepId,
          eventData: {
            stepName,
            error: await dehydrateStepError(
              err,
              workflowRunId,
              await getEncryptionKey()
            ),
            ...(RetryableError.is(err) && { retryAfter: err.retryAfter }),
          },
        });
      } catch (stepRetryErr) {
        if (EntityConflictError.is(stepRetryErr)) {
          runtimeLogger.info(
            'Tried retrying step, but step has already finished.',
            {
              workflowRunId,
              stepId,
              stepName,
              message: stepRetryErr.message,
            }
          );
          return { type: 'skipped' };
        }
        throw stepRetryErr;
      }

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

      return { type: 'retry', timeoutSeconds };
    }
  });
}
