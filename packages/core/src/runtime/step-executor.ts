import { types } from 'node:util';
import {
  FatalError,
  RetryableError,
  RunExpiredError,
  SerializationError,
  ThrottleError,
  TooEarlyError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  createWorkflowBaseUrl,
  pluralize,
  stepDisplayName,
} from '@workflow/utils';
import type {
  CreateEventParams,
  CreateEventRequest,
  EventResult,
  SerializedData,
  StepStartReason,
  World,
} from '@workflow/world';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
} from '@workflow/world';
import { envNumber } from '@workflow/world/env-config';
import type { FlushableStreamState } from '../flushable-stream.js';
import { runtimeLogger, stepLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
import type { PayloadKey } from '../serialization/encryption.js';
import { formatSerializationError } from '../serialization/errors.js';
import {
  cancelAbortReaders,
  dehydrateStepError,
  dehydrateStepReturnValue,
  hydrateStepArguments,
} from '../serialization.js';
import { setErrorStack } from '../set-error-stack.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { recordStepExecutionDuration, trace } from '../telemetry.js';
import {
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
  promoteAbortErrorToFatal,
} from '../types.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { isOptimisticInlineStartExplicitlyDisabled } from './constants.js';
import { getPortLazy } from './get-port-lazy.js';
import { memoizeEncryptionKey } from './helpers.js';
import {
  computeResumeTtrAttributes,
  type ResumeTtrTracking,
} from './resume-latency.js';
import {
  computeStepLatencyEventData,
  type StepLatencyEventData,
  type StepLatencyTracking,
} from './step-latency.js';
import { isUnserializableStepInputPlaceholder } from './unserializable-step.js';
import { safeWaitUntil } from './wait-until.js';

export const DEFAULT_STEP_MAX_RETRIES = 3;
export const STEP_STREAM_DRAIN_TIMEOUT_MS = 30_000;

export function getStepStreamDrainTimeoutMs(): number {
  return envNumber(
    'WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS',
    STEP_STREAM_DRAIN_TIMEOUT_MS,
    { integer: true, min: 1 }
  );
}

function isClientDisconnectError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === 'AbortError' || name === 'ResponseAborted';
}

async function settleReleasedStepStreams(
  states: FlushableStreamState[]
): Promise<void> {
  if (states.length === 0) return;

  const timeoutMs = getStepStreamDrainTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        states.map((state) =>
          (state.settleReleasedWrites?.() ?? Promise.resolve(false)).catch(
            (error) => {
              // A disconnected client may abandon one response stream, but it
              // must not let that rejection bypass durability waits for other
              // streams written by the same step.
              if (!isClientDisconnectError(error)) throw error;
              return false;
            }
          )
        )
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new WorkflowRuntimeError(
                `Timed out draining step stream writes after ${timeoutMs}ms`
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } catch (error) {
    if (!isClientDisconnectError(error)) throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Writes one step event for the executor. The orchestrator passes its
 * in-band writer (inline steps are in-band, and fenced); a background step's
 * queue handler passes a plain out-of-band writer.
 */
export type StepEventWriter = <T extends CreateEventRequest>(
  data: T,
  params?: CreateEventParams
) => Promise<EventResult>;

/** A `step_started` the caller wrote for this attempt. */
export interface CallerStart {
  startedAt: Date;
  /** `Date.now()` right before the write was sent. */
  postSentAtMs?: number;
  /** `Date.now()` once it returned. */
  completedAtMs?: number;
}

export interface StepExecutorParams {
  world: World;
  /** Writes this step's events. See {@link StepEventWriter}. */
  createEvent: StepEventWriter;
  workflowRunId: string;
  /** Deployment that owns the workflow run, for forwarded writable streams. */
  workflowDeploymentId?: string;
  workflowName: string;
  workflowStartedAt: number;
  /** Request ID of the invocation executing this step, when provided by its queue. */
  requestId?: string;
  /** Root run id of this run's lineage, carried into the step context. */
  rootRunId?: string;
  stepId: string;
  stepName: string;
  encryptionKey?: PayloadKey;
  /**
   * The workflow run's specVersion, used to gate payload compression.
   * Step outputs/errors are only compressed when the run is marked as
   * compression-capable (specVersion >= 5).
   */
  runSpecVersion?: number;
  /**
   * The attempt this execution is. The caller decides it: the queue message's
   * attempt on a first delivery, the count of `step_started` events plus one
   * after a log read, or the orchestrator's own count for an inline step.
   */
  attempt: number;
  /** Why this attempt starts; written on `step_started`. */
  startReason: StepStartReason;
  /**
   * When the step's first attempt started, for a retry. The step context's
   * `stepStartedAt` is the step's first start, not this attempt's.
   */
  firstStartedAt?: Date;
  /** The step's serialized input, as written on its `step_created`. */
  input: SerializedData;
  /**
   * Set when the caller already wrote this attempt's `step_started` (an
   * inline step created and started in one batch). The executor then writes
   * no start of its own.
   */
  started?: CallerStart;
  /**
   * The World's refusal of a `step_started` the caller wrote for this
   * attempt in a batch (a throttle, a finished run). Acted on as a refusal of
   * the executor's own start; the executor writes no start.
   */
  startRefusal?: unknown;
  /** Params for the outcome write (`step_completed` / `step_failed`). */
  terminalEventParams?: CreateEventParams;
  /**
   * Whether a retry at `retryAtMs` would land after the step's queue message
   * expires. The step is then failed instead of retried. Background steps
   * only; an inline step's retry creates a fresh message.
   */
  retryOutlivesMessage?: (retryAtMs: number) => boolean;
  /**
   * Called right before user code runs. The orchestrator throws from it when
   * its in-band writer has stopped, so a superseded orchestrator never starts
   * a body.
   */
  beforeBody?: () => void;
  /**
   * Start the body before this attempt's `step_started` commits (optimistic
   * inline start). Set by turbo mode for the inline steps of a run's first
   * delivery, where no other orchestrator of the run can exist yet, so the
   * start cannot be refused by the in-band fence after the body ran. The
   * `step_started` write still goes out, after {@link runReadyBarrier} and
   * {@link startAfter}, and the outcome write waits for it: if the start
   * fails, the body's outcome is discarded and the start's error is what the
   * caller sees. An explicit `WORKFLOW_OPTIMISTIC_INLINE_START=0` wins and
   * takes the awaited path.
   */
  forceOptimisticStart?: boolean;
  /**
   * Turbo mode only: settles once the backgrounded `run_started` has
   * landed (rejects if it failed). This attempt's `step_started` is sent only
   * after it, on both the optimistic and the awaited path, and an optimistic
   * body's stream and attribute writes wait for it too, so nothing this step
   * writes reaches the World before the run's start. `undefined` outside
   * turbo, where `run_started` was already awaited.
   */
  runReadyBarrier?: Promise<unknown>;
  /**
   * Settles once this step's `step_created` has committed (rejects if it
   * failed). Set when the caller wrote `step_created` without waiting for it
   * (turbo's optimistic inline start). Resolves with the start when the
   * caller's write committed this attempt's `step_started` too (one batch);
   * otherwise the executor sends `step_started` after it. A failure is the
   * start's failure.
   */
  startAfter?: Promise<CallerStart | undefined | void>;
  /**
   * Latency telemetry (TTFS / STSO): eligibility and anchor timestamps decided
   * by the orchestrator. See runtime/step-latency.ts.
   */
  latencyTracking?: StepLatencyTracking;
  /**
   * Hook-resume TTR telemetry for the step that follows a resumption. See
   * runtime/resume-latency.ts.
   */
  resumeTracking?: ResumeTtrTracking;
}

/**
 * Result of a step execution attempt. The caller decides what happens next
 * (wake the orchestrator, redeliver the message, continue the replay).
 *
 * `result` is the committed outcome write, so the orchestrator can consume
 * its own resolving event only after the commit (see
 * `orchestrator/consume-after-commit.ts`).
 */
export type StepExecutionResult =
  | {
      type: 'completed';
      hasPendingOps?: boolean;
      result: EventResult;
    }
  | { type: 'failed'; result: EventResult }
  | {
      type: 'retry';
      timeoutSeconds: number;
      retryAt: Date;
      result: EventResult;
    }
  | { type: 'gone' }
  | { type: 'throttled'; timeoutSeconds: number };

/** Message of the `step_failed` written when a step exhausts its retries. */
export function exceededMaxRetriesMessage(
  stepName: string,
  maxRetries: number
): string {
  return `Step "${stepName}" exceeded max retries (${maxRetries} ${pluralize('retry', 'retries', maxRetries)})`;
}

/**
 * Writes `step_failed` for a step whose next attempt would exceed its retry
 * budget, without running the body. Used when the log shows the step already
 * started `maxRetries + 1` times, including a `maxRetries: 0` step that is
 * redelivered after its single start.
 */
export async function failStepForExhaustedRetries(params: {
  createEvent: StepEventWriter;
  workflowRunId: string;
  stepId: string;
  stepName: string;
  attempt: number;
  maxRetries: number;
  encryptionKey: PayloadKey | undefined;
  runSpecVersion?: number;
}): Promise<StepExecutionResult> {
  const message = exceededMaxRetriesMessage(params.stepName, params.maxRetries);
  stepLogger.error('Step exceeded max retries', {
    workflowRunId: params.workflowRunId,
    stepName: params.stepName,
    stepId: params.stepId,
    attempt: params.attempt,
    maxRetries: params.maxRetries,
  });
  try {
    const result = await params.createEvent({
      eventType: 'step_failed',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: params.stepId,
      eventData: {
        stepName: params.stepName,
        attempt: params.attempt,
        error: await dehydrateStepError(
          new FatalError(message),
          params.workflowRunId,
          params.encryptionKey,
          [],
          globalThis,
          (params.runSpecVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION
        ),
      },
    });
    return { type: 'failed', result };
  } catch (err) {
    if (RunExpiredError.is(err)) return { type: 'gone' };
    throw err;
  }
}

/**
 * Executes one attempt of a step: writes `step_started` (unless the caller
 * already did), hydrates the input, runs the step function, and writes
 * exactly one of `step_completed`, `step_failed` or `step_retrying`.
 *
 * It decides nothing about ownership. The caller already established that
 * this invocation owns the attempt (an inline step in its orchestrator, or
 * the delivery of the step's own message after the log check). No refusal
 * from the World is read as "someone else did it": a refusal propagates, and
 * the queue's redelivery re-checks the log.
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
    attempt,
  } = params;
  // Truthiness, not presence: `vercel env pull` writes `VERCEL_URL=""` into
  // `.env.local`, and a framework that loads that file locally would otherwise
  // put us on the Vercel branch with nothing to build a host from, making
  // `https://` the base URL of every step.
  const isVercel = Boolean(process.env.VERCEL_URL);
  // Gate payload compression on the run's specVersion.
  const compression =
    (params.runSpecVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION;
  const createEvent = params.createEvent;

  // `step_started` identifies the invocation that performed this attempt.
  // Keep request and compute provenance independent: world-vercel serializes
  // requestId as analytics `vercelId`, while computeInstanceId identifies the
  // worker that executed the step.
  const stepStartedEventParams: CreateEventParams = {
    computeInstanceId: COMPUTE_INSTANCE_ID,
    ...(params.requestId ? { requestId: params.requestId } : {}),
  };

  const spanName = `step.execute ${stepDisplayName(stepName)}`;
  return trace(spanName, {}, async (span) => {
    span?.setAttributes({
      ...Attribute.StepName(stepName),
      ...Attribute.WorkflowName(workflowName),
      ...Attribute.WorkflowRunId(workflowRunId),
      ...Attribute.StepId(stepId),
      ...Attribute.StepAttempt(attempt),
    });

    // Memoized accessor for the per-run encryption key.
    const getEncryptionKey = memoizeEncryptionKey(world, workflowRunId);

    const stepFn = getStepFunction(stepName);
    if (!stepFn || typeof stepFn !== 'function') {
      // Step function not registered: fail the step immediately (not the run)
      // so the workflow can handle it via try/catch in user code.
      const errorMessage = `Step "${stepName}" is not registered in the current deployment. This usually indicates a build or bundling issue that caused the step to not be included in the deployment.`;
      runtimeLogger.error('Step function not registered, failing step', {
        workflowRunId,
        stepName,
        stepId,
      });
      try {
        // Turbo: the outcome of a step created in the background still
        // follows the run's start and the step's own creation. A rejection
        // fails this write with the earlier write's error.
        if (params.runReadyBarrier) await params.runReadyBarrier;
        if (params.startAfter) await params.startAfter;
        const result = await createEvent(
          {
            eventType: 'step_failed',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: {
              stepName,
              attempt,
              error: await dehydrateStepError(
                new FatalError(errorMessage),
                workflowRunId,
                await getEncryptionKey(),
                [],
                globalThis,
                compression
              ),
            },
          },
          params.terminalEventParams
        );
        span?.setAttributes({
          ...Attribute.StepStatus('failed'),
          ...Attribute.StepFatalError(true),
        });
        return { type: 'failed', result };
      } catch (err) {
        if (RunExpiredError.is(err)) return { type: 'gone' };
        throw err;
      }
    }

    const maxRetries = stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
    span?.setAttributes({
      ...Attribute.StepMaxRetries(maxRetries),
    });

    // `Date.now()` taken immediately before the `step_started` create is
    // issued; anchors RSFS's end point.
    let stepStartPostSentAtMs = params.started?.postSentAtMs;
    // `Date.now()` once the `step_started` response returned: T6 of the
    // hook-resume TTR window.
    let stepClaimCompletedAtMs = params.started?.completedAtMs;
    let stepStartedAt: Date;
    const startEvent = {
      eventType: 'step_started' as const,
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: {
        stepName,
        attempt,
        startReason: params.startReason,
      },
    };
    // A start refused for load or by a World that still keeps step rows
    // redelivers rather than failing; a start on a finished run ends the
    // attempt. Anything else propagates.
    const startErrorToResult = (
      err: unknown
    ): StepExecutionResult | undefined => {
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
      if (TooEarlyError.is(err)) {
        // A World that still keeps step rows may refuse a start before its
        // recorded `retryAfter`; redeliver and let the log check decide.
        return {
          type: 'throttled',
          timeoutSeconds: Math.max(1, err.retryAfter ?? 1),
        };
      }
      if (RunExpiredError.is(err)) {
        runtimeLogger.info(
          `Workflow run "${workflowRunId}" has already completed, skipping step "${stepId}": ${err.message}`
        );
        return { type: 'gone' };
      }
      return undefined;
    };
    if (params.startRefusal !== undefined) {
      const mapped = startErrorToResult(params.startRefusal);
      if (mapped) return mapped;
    }
    // Optimistic inline start (turbo's first delivery only, see
    // `forceOptimisticStart`): the body runs now and `step_started` follows
    // the run's start and the step's creation in the background.
    const optimisticStart =
      params.forceOptimisticStart === true &&
      params.started === undefined &&
      !isOptimisticInlineStartExplicitlyDisabled();
    span?.setAttributes(
      Attribute.StepStartStrategy(
        params.started
          ? 'batch_preclaimed'
          : optimisticStart
            ? 'optimistic'
            : 'awaited'
      )
    );
    // Settled outcome of the optimistic `step_started`. Handlers are attached
    // at once, so a fast rejection never surfaces as an unhandled rejection
    // while the body runs.
    let optimisticStartSettled:
      | Promise<{ ok: true } | { ok: false; err: unknown }>
      | undefined;
    if (params.started) {
      stepStartedAt = params.started.startedAt;
    } else if (optimisticStart) {
      const startedPromise = Promise.all([
        params.runReadyBarrier,
        params.startAfter,
      ]).then(async ([, callerStart]) => {
        if (callerStart) {
          stepStartPostSentAtMs = callerStart.postSentAtMs;
          stepClaimCompletedAtMs = callerStart.completedAtMs;
          return;
        }
        // Taken right before the create, after the barriers: RSFS measures
        // the run_started-to-POST stretch, and under turbo the barrier wait
        // is part of it.
        stepStartPostSentAtMs = Date.now();
        await createEvent(startEvent, stepStartedEventParams);
        stepClaimCompletedAtMs = Date.now();
      });
      optimisticStartSettled = startedPromise.then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err })
      );
      stepStartedAt = new Date();
    } else {
      try {
        // Turbo with optimistic start withheld (an explicit
        // `WORKFLOW_OPTIMISTIC_INLINE_START=0`): the awaited start still
        // follows the backgrounded `run_started` and the step's creation.
        if (params.runReadyBarrier) await params.runReadyBarrier;
        const callerStart = params.startAfter
          ? await params.startAfter
          : undefined;
        if (callerStart) {
          stepStartPostSentAtMs = callerStart.postSentAtMs;
          stepClaimCompletedAtMs = callerStart.completedAtMs;
          stepStartedAt = callerStart.startedAt;
        } else {
          stepStartPostSentAtMs = Date.now();
          const startResult = await createEvent(
            startEvent,
            stepStartedEventParams
          );
          stepClaimCompletedAtMs = Date.now();
          stepStartedAt = startResult.event?.createdAt ?? new Date();
        }
      } catch (err) {
        const mapped = startErrorToResult(err);
        if (mapped) return mapped;
        throw err;
      }
    }
    /**
     * Waits for the optimistic `step_started`. Returns the result that
     * replaces the attempt's outcome when the start did not commit (the
     * body's outcome is then discarded), and throws the start's error when it
     * maps to none. Called before every outcome write, so no outcome reaches
     * the World ahead of, or without, its start.
     */
    const reconcileOptimisticStart = async (): Promise<
      StepExecutionResult | undefined
    > => {
      if (!optimisticStartSettled) return undefined;
      const settled = await optimisticStartSettled;
      if (settled.ok) {
        // The start's POST time is known only now; RSFS was computed before
        // the body without it.
        const anchorMs = params.latencyTracking?.rsfsAnchorMs;
        if (
          latencyEventData &&
          latencyEventData.rsfs === undefined &&
          anchorMs !== undefined &&
          stepStartPostSentAtMs !== undefined
        ) {
          latencyEventData.rsfs = Math.max(0, stepStartPostSentAtMs - anchorMs);
          span?.setAttributes(Attribute.StepRsfsMs(latencyEventData.rsfs));
        }
        return undefined;
      }
      const mapped = startErrorToResult(settled.err);
      if (!mapped) throw settled.err;
      return mapped;
    };

    span?.setAttributes({
      ...Attribute.StepStatus('running'),
    });

    let result: unknown;

    // Ops that must be durably committed before step completion (e.g. a
    // step-initiated abort's hook_received event). See StepContext. Declared
    // outside the try so the failure path below can also drain them.
    const preCompletionOps: Promise<void>[] = [];
    const ops: Promise<void>[] = [];
    const streamStates: FlushableStreamState[] = [];
    let opsSettled = true;

    // Latency telemetry to attach to this step's terminal event.
    let latencyEventData: StepLatencyEventData | undefined;

    // Outside the try: a throw here (the orchestrator was superseded) must
    // not be recorded as a step failure.
    params.beforeBody?.();

    try {
      const encryptionKey = params.encryptionKey ?? (await getEncryptionKey());
      const hydratedInput = await trace(
        'step.hydrate',
        {},
        async (hydrateSpan) => {
          const startTime = Date.now();
          const hydrated = await hydrateStepArguments(
            params.input,
            workflowRunId,
            encryptionKey,
            ops,
            globalThis,
            {},
            params.workflowDeploymentId,
            streamStates,
            // A workflow-created writable passed into an optimistic step can
            // emit chunks before run_started lands, just like getWritable().
            optimisticStart ? params.runReadyBarrier : undefined
          );
          const durationMs = Date.now() - startTime;
          hydrateSpan?.setAttributes({
            ...Attribute.StepArgumentsCount(hydrated.args.length),
            ...Attribute.QueueDeserializeTimeMs(durationMs),
          });
          return hydrated;
        }
      );

      // Finalization of an unserializable-argument step writes step_created
      // (placeholder input) and step_failed as two separate durable writes.
      // A crash between them leaves the placeholder stored as the input.
      // NEVER run user code with placeholder arguments; complete the intended
      // failure instead. The SerializationError is fatal.
      if (isUnserializableStepInputPlaceholder(hydratedInput)) {
        const { message, hint } = formatSerializationError(
          'step arguments',
          undefined
        );
        throw new SerializationError(message, { hint });
      }

      const args = hydratedInput.args;
      const thisVal = hydratedInput.thisVal ?? null;
      const workflowBaseUrl = createWorkflowBaseUrl(
        isVercel
          ? `https://${process.env.VERCEL_URL}`
          : `http://localhost:${(await getPortLazy()) ?? 3000}`
      );

      // --- User code execution ---
      let userCodeError: unknown;
      let userCodeFailed = false;

      const executionStartTime = Date.now();
      latencyEventData = computeStepLatencyEventData({
        tracking: params.latencyTracking,
        stepCodeStartedAtMs: executionStartTime,
        attempt,
        lazyStepStart: false,
        optimisticStart,
        preclaimedStart: params.started !== undefined,
        stepStartPostSentAtMs,
      });
      if (latencyEventData) {
        span?.setAttributes({
          ...(latencyEventData.ttfs !== undefined
            ? Attribute.StepTtfsMs(latencyEventData.ttfs)
            : {}),
          ...(latencyEventData.stso !== undefined
            ? Attribute.StepStsoMs(latencyEventData.stso)
            : {}),
          ...(latencyEventData.rsfs !== undefined
            ? Attribute.StepRsfsMs(latencyEventData.rsfs)
            : {}),
          ...(latencyEventData.finalSchedulingReplay !== undefined
            ? Attribute.StepFinalSchedulingReplayMs(
                latencyEventData.finalSchedulingReplay
              )
            : {}),
          ...Attribute.StepLatencyOptimizations(
            latencyEventData.optimizations ?? []
          ),
        });
      }
      // Close the hook-resume TTR measurement immediately before user code.
      // The `reported` latch makes one resumption yield one sample.
      const reportResumeTtr = (): void => {
        const tracking = params.resumeTracking;
        if (!tracking || tracking.reported) return;
        const attributes = computeResumeTtrAttributes({
          tracking,
          attempt,
          stepClaimStartedAtMs: stepStartPostSentAtMs,
          stepClaimCompletedAtMs,
          stepCodeStartedAtMs: Date.now(),
        });
        if (!attributes) return;
        tracking.reported = true;
        span?.setAttributes(attributes);
      };

      let stepExecutionStatus: 'ok' | 'error' = 'ok';
      const stepExecutionStartTime = performance.now();
      try {
        result = await trace('step.execute', {}, async () => {
          return await contextStorage.run(
            {
              stepMetadata: {
                stepName,
                stepId,
                stepStartedAt: new Date(
                  +(params.firstStartedAt ?? stepStartedAt)
                ),
                attempt,
              },
              workflowMetadata: {
                workflowName,
                workflowRunId,
                workflowStartedAt: new Date(+workflowStartedAt),
                url: workflowBaseUrl,
                features: { encryption: !!encryptionKey },
              },
              workflowDeploymentId: params.workflowDeploymentId,
              rootRunId: params.rootRunId,
              ops,
              preCompletionOps,
              streamStates,
              closureVars: hydratedInput.closureVars,
              encryptionKey,
              // An optimistic body runs before `run_started` is known to have
              // landed. Its direct World writes (`setAttributes`) wait on
              // the barrier. Undefined on the awaited path.
              runReadyBarrier: optimisticStart
                ? params.runReadyBarrier
                : undefined,
            },
            () => {
              // The last instant before user code: T7 of the resume window.
              reportResumeTtr();
              world.telemetry?.recordStepExecution?.(stepId);
              return stepFn.apply(thisVal, args);
            }
          );
        });
      } catch (err) {
        stepExecutionStatus = 'error';
        userCodeError = err;
        userCodeFailed = true;
      } finally {
        void recordStepExecutionDuration(
          performance.now() - stepExecutionStartTime,
          stepExecutionStatus
        );
      }
      const executionTimeMs = Date.now() - executionStartTime;

      // Tear down abort-stream readers opened while hydrating the arguments,
      // on success and on failure, so a signal-bearing step does not leak one.
      cancelAbortReaders(...args, thisVal, hydratedInput.closureVars);

      if (userCodeFailed) {
        await settleReleasedStepStreams(streamStates).catch((error) => {
          runtimeLogger.warn(
            'Failed to drain released streams after step error',
            {
              workflowRunId,
              stepId,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        });
        throw userCodeError;
      }

      span?.setAttributes({
        ...Attribute.QueueExecutionTimeMs(executionTimeMs),
      });

      result = await trace('step.dehydrate', {}, async (dehydrateSpan) => {
        const startTime = Date.now();
        const dehydrated = await dehydrateStepReturnValue(
          result,
          workflowRunId,
          encryptionKey,
          ops,
          globalThis,
          false,
          false,
          compression,
          // A returned stream is piped to the World after the body, within
          // this step's op flush: gate its first write on the run-ready
          // barrier. Undefined on the awaited path.
          optimisticStart ? params.runReadyBarrier : undefined
        );
        const durationMs = Date.now() - startTime;
        dehydrateSpan?.setAttributes({
          ...Attribute.QueueSerializeTimeMs(durationMs),
          ...Attribute.StepResultType(typeof dehydrated),
        });
        return dehydrated;
      });

      // Arm the background flush before the durability wait so lock-held
      // streams keep their lifecycle even if a drain fails.
      if (ops.length > 0) {
        const opsPromise = Promise.all(ops);
        safeWaitUntil(opsPromise, (err) => {
          runtimeLogger.warn('Background flush of step stream ops failed', {
            workflowRunId,
            stepId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        opsSettled = false;
        const opsSettledPromise = Promise.race([
          opsPromise.then(
            () => {
              opsSettled = true;
            },
            (err) => {
              if (isClientDisconnectError(err)) {
                opsSettled = true;
                return;
              }
              throw err;
            }
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
        opsSettledPromise.catch(() => {});

        await settleReleasedStepStreams(streamStates);
        await opsSettledPromise;
      }

      // Commit must-be-durable ops (e.g. a step-initiated abort's
      // hook_received event) before writing step_completed, so a continuation
      // triggered by that event observes the abort rather than racing it.
      if (preCompletionOps.length > 0) {
        await Promise.all(preCompletionOps).catch(() => {});
      }
    } catch (err: unknown) {
      if (preCompletionOps.length > 0) {
        await Promise.all(preCompletionOps).catch(() => {});
      }

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
        // The World answered that the run is gone. The delivery acknowledges
        // without an outcome, so a wrong answer here strands the run: logged
        // at warn so it shows without DEBUG.
        stepLogger.warn('Workflow run gone, skipping step', {
          workflowRunId,
          stepId,
          during: 'body',
          message: err.message,
          status: err.status,
        });
        return { type: 'gone' };
      }

      // No outcome is written for an optimistic body whose start did not
      // commit.
      const lost = await reconcileOptimisticStart();
      if (lost) return lost;

      const writeFailed = async (
        error: unknown,
        attributes: Parameters<NonNullable<typeof span>['setAttributes']>[0]
      ): Promise<StepExecutionResult> => {
        try {
          const failed = await createEvent(
            {
              eventType: 'step_failed',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: stepId,
              eventData: {
                stepName,
                attempt,
                error: await dehydrateStepError(
                  error,
                  workflowRunId,
                  await getEncryptionKey(),
                  [],
                  globalThis,
                  compression
                ),
                ...latencyEventData,
              },
            },
            // The body ran: losing this write to redelivery would run it again.
            { ...params.terminalEventParams, afterStepBody: true }
          );
          span?.setAttributes({
            ...Attribute.StepStatus('failed'),
            ...attributes,
          });
          return { type: 'failed', result: failed };
        } catch (writeErr) {
          if (RunExpiredError.is(writeErr)) return { type: 'gone' };
          throw writeErr;
        }
      };

      if (isFatal) {
        stepLogger.error(
          'Encountered FatalError while executing step, bubbling up to parent workflow',
          { workflowRunId, stepName, errorStack: normalizedStack }
        );
        if (types.isNativeError(effectiveErr) && normalizedStack) {
          setErrorStack(effectiveErr, normalizedStack);
        }
        return writeFailed(effectiveErr, Attribute.StepFatalError(true));
      }

      span?.setAttributes({
        ...Attribute.StepAttempt(attempt),
        ...Attribute.StepMaxRetries(maxRetries),
      });

      const wrapExhausted = (message: string): FatalError => {
        const wrappedError = new FatalError(message);
        (wrappedError as Error).cause = err;
        if (normalizedStack) wrappedError.stack = normalizedStack;
        return wrappedError;
      };

      if (attempt >= maxRetries + 1) {
        stepLogger.error(
          'Max retries reached, bubbling error to parent workflow',
          {
            workflowRunId,
            stepName,
            attempt,
            retryCount: attempt - 1,
            errorStack: normalizedStack,
          }
        );
        return writeFailed(
          wrapExhausted(
            `Step "${stepName}" failed after ${maxRetries} ${pluralize('retry', 'retries', maxRetries)}: ${normalizedError.message}`
          ),
          Attribute.StepRetryExhausted(true)
        );
      }

      const retryAt = RetryableError.is(err)
        ? new Date(err.retryAfter)
        : new Date(Date.now() + 1000);
      if (params.retryOutlivesMessage?.(retryAt.getTime())) {
        stepLogger.error(
          'Step retry would outlive its queue message, failing the step',
          { workflowRunId, stepName, attempt, retryAt: retryAt.toISOString() }
        );
        return writeFailed(
          wrapExhausted(
            `Step "${stepName}" could not be retried: its next attempt at ${retryAt.toISOString()} is past the retention of its queue message: ${normalizedError.message}`
          ),
          Attribute.StepRetryExhausted(true)
        );
      }

      if (RetryableError.is(err)) {
        stepLogger.info('Encountered RetryableError, step will be retried', {
          workflowRunId,
          stepName,
          attempt,
          message: err.message,
        });
      } else {
        stepLogger.info('Encountered Error, step will be retried', {
          workflowRunId,
          stepName,
          attempt,
          errorStack: normalizedStack,
        });
      }

      if (types.isNativeError(err) && normalizedStack) {
        setErrorStack(err, normalizedStack);
      }
      let retrying: EventResult;
      try {
        retrying = await createEvent({
          eventType: 'step_retrying',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: stepId,
          eventData: {
            stepName,
            attempt,
            error: await dehydrateStepError(
              err,
              workflowRunId,
              await getEncryptionKey(),
              [],
              globalThis,
              compression
            ),
            retryAfter: retryAt,
          },
        });
      } catch (writeErr) {
        if (RunExpiredError.is(writeErr)) return { type: 'gone' };
        throw writeErr;
      }

      const timeoutSeconds = Math.max(
        1,
        Math.ceil((retryAt.getTime() - Date.now()) / 1000)
      );

      span?.setAttributes({
        ...Attribute.StepRetryTimeoutSeconds(timeoutSeconds),
        ...Attribute.StepRetryWillRetry(true),
      });

      return { type: 'retry', timeoutSeconds, retryAt, result: retrying };
    }

    // No outcome is written for an optimistic body whose start did not
    // commit.
    const lost = await reconcileOptimisticStart();
    if (lost) return lost;

    // Create step_completed event outside the step execution failure path:
    // persistence failures are infrastructure errors and should redeliver the
    // queue message, not become user step_retrying/step_failed events.
    let completedResult: EventResult;
    try {
      completedResult = await createEvent(
        {
          eventType: 'step_completed',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: stepId,
          eventData: {
            stepName,
            workflowName,
            result: result as Uint8Array,
            ...latencyEventData,
          },
        },
        params.terminalEventParams
      );
    } catch (err) {
      if (RunExpiredError.is(err)) {
        // The World answered that the run is gone. The delivery acknowledges
        // without an outcome, so a wrong answer here strands the run: logged
        // at warn so it shows without DEBUG.
        stepLogger.warn('Workflow run gone, skipping step', {
          workflowRunId,
          stepId,
          during: 'outcome',
          message: err.message,
          status: err.status,
        });
        return { type: 'gone' };
      }
      throw err;
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
    return {
      type: 'completed',
      hasPendingOps: !opsSettled,
      result: completedResult,
    };
  });
}
