import { types } from 'node:util';
import {
  EntityConflictError,
  FatalError,
  RetryableError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  createWorkflowBaseUrl,
  pluralize,
  stepDisplayName,
} from '@workflow/utils';
import type { Event, SerializedData, Step, World } from '@workflow/world';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
} from '@workflow/world';
import type { CryptoKey } from '../encryption.js';
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
import { trace } from '../telemetry.js';
import {
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
  promoteAbortErrorToFatal,
} from '../types.js';

import {
  isOptimisticInlineStartEnabled,
  isOptimisticInlineStartExplicitlyDisabled,
} from './constants.js';
import { getPortLazy } from './get-port-lazy.js';
import { memoizeEncryptionKey } from './helpers.js';
import {
  computeStepLatencyEventData,
  type StepLatencyEventData,
  type StepLatencyTracking,
} from './step-latency.js';
import { safeWaitUntil } from './wait-until.js';

const DEFAULT_STEP_MAX_RETRIES = 3;

/**
 * Extract the inline delta from a step-terminal `events.create` result,
 * if the World populated one. A delta is only meaningful when the caller
 * requested it (`sinceCursor` was passed) and the World returned both
 * `events` and a `cursor`; otherwise we return undefined and the caller
 * falls back to the normal incremental `events.list`. `hasMore` defaults
 * to false (single page) when the World omits it.
 */
function extractInlineDelta(
  result: { events?: Event[]; cursor?: string | null; hasMore?: boolean },
  requested: boolean
): InlineEventDelta | undefined {
  if (!requested) return undefined;
  if (!result.events || result.cursor === undefined) return undefined;
  return {
    events: result.events,
    cursor: result.cursor,
    hasMore: result.hasMore ?? false,
  };
}

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
  /**
   * The workflow run's specVersion, used to gate payload compression.
   * Step outputs/errors are only gzip-compressed when the run is marked
   * as possibly containing compressed payloads (specVersion >= 5).
   */
  runSpecVersion?: number;
  /**
   * Lazy step start: the already-dehydrated step input. When provided, the
   * `step_started` event carries this input so the world creates the step on
   * the fly (no separate `step_created` round-trip). Set by the owned-inline
   * path for the step whose `step_created` the suspension handler deferred.
   * The world's atomic create-claim is the exactly-one-owner gate: losing it
   * surfaces as `EntityConflictError` → `{ type: 'skipped' }`, so a handler
   * that did not win the create never runs the body. Omitted on every other
   * path, where the step already has a `step_created` and `step_started`
   * carries no payload (the legacy contract).
   */
  lazyStepInput?: SerializedData;
  /**
   * Inline step ownership: the queue message ID of the invocation this
   * executeStep call runs in (from the queue handler's meta). When set, the
   * `step_started` this call sends is stamped with it — on the lazy paths
   * (where `lazyStepInput` is present) and on the owned-recovery bare start
   * (where it is not; the re-stamp keeps a recovered step readable as owned
   * by this message, since ownership derives from the LATEST start). Wake
   * replays that observe an actively-owned step suppress the immediate
   * requeue and enqueue a delayed backstop instead. Omitted on the
   * background-step path, whose bare start intentionally clears ownership
   * (the step is queue-owned from that point).
   */
  ownerMessageId?: string;
  /**
   * Inline-delta optimization (opt-in). When provided, the cursor of the
   * event log as observed by the caller *before* this step's events were
   * written. It is threaded into the step-terminal `events.create` so a
   * supporting World can return the delta of events written since (see
   * {@link import('@workflow/world').CreateEventParams.sinceCursor}).
   * Only set this when `correlationId`-based ownership guarantees this
   * handler is the sole inline writer for the run on this iteration.
   */
  inlineDeltaSinceCursor?: string;
  /**
   * Force optimistic inline start regardless of
   * `WORKFLOW_OPTIMISTIC_INLINE_START`. Set by turbo mode on the first delivery
   * of the first invocation, where forcing it is safe: there is no concurrent
   * peer handler to race the create-claim, so the body runs exactly once. Only
   * meaningful together with `lazyStepInput` (a brand-new lazy step).
   */
  forceOptimisticStart?: boolean;
  /**
   * Turbo mode only: a promise that resolves once the backgrounded
   * `run_started` has landed. When set, the lazy/optimistic `step_started` is
   * chained on it so the step is never created before its run exists. The body
   * still runs immediately against locally-synthesized state — only the network
   * write waits — so the `run_started` round-trip overlaps the body. `undefined`
   * outside turbo, where `run_started` was already awaited up front.
   */
  runReadyBarrier?: Promise<unknown>;
  /**
   * Latency telemetry (TTFS / STSO): eligibility and anchor timestamps decided
   * by the orchestrator. When set, this executor computes the final values
   * against the wall clock taken immediately before user code runs and
   * attaches them to the step's terminal event. Set only for the first step of
   * an inline batch, and only on first-attempt executions that qualify — see
   * runtime/step-latency.ts.
   */
  latencyTracking?: StepLatencyTracking;
}

/**
 * Inline-delta returned by a step-terminal write when the caller passed
 * {@link StepExecutorParams.inlineDeltaSinceCursor} and the World supports
 * the optimization. `events` are the events written strictly after that
 * cursor (this step's events plus anything interleaved in-band), `cursor`
 * is the position past the last one, and `hasMore` signals a further page
 * (the caller then falls back to a full incremental fetch). Absent when
 * the World did not return a delta.
 */
export interface InlineEventDelta {
  events: Event[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Result of a step execution attempt. The caller decides what to do
 * based on the result type (e.g., queue workflow continuation, replay inline, etc.).
 *
 * `inlineDelta` is attached to a `completed` result when the caller
 * requested it via {@link StepExecutorParams.inlineDeltaSinceCursor} and
 * the World returned one. Step failures are rare and not the inline
 * optimization's target, so the `failed` path leaves it to the normal
 * incremental fetch.
 */
export type StepExecutionResult =
  | {
      type: 'completed';
      hasPendingOps?: boolean;
      inlineDelta?: InlineEventDelta;
    }
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
  // Gate payload compression on the run's specVersion: only runs marked
  // as possibly containing compressed payloads (spec >= 5) get gzip data.
  const compression =
    (params.runSpecVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION;

  const spanName = `step.execute ${stepDisplayName(stepName)}`;
  return trace(spanName, {}, async (span) => {
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
      // On the lazy inline path the suspension handler deferred this step's
      // `step_created`, expecting executeStep to materialize the step via a
      // lazy `step_started` carrying its input. We never get that far for an
      // unregistered step, so the step entity does not exist yet — writing
      // `step_failed` straight away would hit the world's "step must exist"
      // ordering guard and wedge the run. Send the lazy `step_started` first
      // (it creates the step + synthetic `step_created` atomically and keeps
      // replay correct), then fail it below. This also preserves the
      // exactly-one-owner guarantee: a concurrent handler that won the create
      // makes our lazy `step_started` reject with EntityConflictError → we
      // return `skipped` and never write the failure twice.
      if (params.lazyStepInput !== undefined) {
        try {
          // Turbo: this lazy `step_started` must not precede the backgrounded
          // `run_started`. Order it after the run-ready barrier (best-effort —
          // a barrier rejection means the run doesn't exist, and the create
          // below surfaces the real error). No-op outside turbo.
          if (params.runReadyBarrier) {
            await params.runReadyBarrier.catch(() => {});
          }
          await world.events.create(workflowRunId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: {
              stepName,
              workflowName,
              input: params.lazyStepInput,
              // Stamped for consistency even though this step terminal-fails
              // immediately below — the log should never show an unowned
              // lazy start.
              ...(params.ownerMessageId !== undefined
                ? { ownerMessageId: params.ownerMessageId }
                : {}),
            },
          });
        } catch (startErr) {
          if (EntityConflictError.is(startErr)) {
            return { type: 'skipped' };
          }
          if (RunExpiredError.is(startErr)) {
            return { type: 'gone' };
          }
          throw startErr;
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
              new FatalError(errorMessage),
              workflowRunId,
              await getEncryptionKey(),
              [],
              globalThis,
              compression
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

    // Maps a `step_started` rejection to a terminal StepExecutionResult,
    // shared by the await path (below) and the optimistic-start reconciliation.
    // Returns undefined when the error is not one we translate (caller rethrows).
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
          error: err instanceof Error ? err.message : String(err),
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
      return undefined;
    };

    // Optimistic inline start: when we hold the step input locally (lazy inline
    // path) and the optimization is enabled, fire `step_started` WITHOUT
    // awaiting and run the body against locally-synthesized state. A lazy step
    // is always brand-new ⇒ attempt 1, no prior error, started now — so we
    // don't need the server round-trip to begin. We reconcile the in-flight
    // `step_started` before any terminal write (`reconcileOptimisticStart`): if
    // it lost the atomic create-claim (409) or the run is gone/throttled, we
    // discard the body result. Running the body before confirming ownership can
    // execute a step more than once when handlers race — inline step bodies
    // must be idempotent; disable via WORKFLOW_OPTIMISTIC_INLINE_START=0.
    //
    // Turbo mode passes `forceOptimisticStart` to enable this regardless of the
    // env flag (its single-handler guarantee removes the race). But it still
    // defers to an *explicit* `WORKFLOW_OPTIMISTIC_INLINE_START=0`: forced
    // optimistic start runs the body before `step_started`/`run_started` is
    // confirmed, which is exactly the property an operator opts out of with that
    // flag, so an explicit opt-out wins over turbo's force.
    const optimisticStart =
      params.lazyStepInput !== undefined &&
      (isOptimisticInlineStartEnabled() ||
        (params.forceOptimisticStart === true &&
          !isOptimisticInlineStartExplicitlyDisabled()));

    let step: Step;
    // Settled outcome of the in-flight optimistic `step_started`. Handlers are
    // attached synchronously (`.then(ok, err)`) so a fast rejection never
    // surfaces as an unhandledRejection while the body runs.
    let optimisticStartSettled:
      | Promise<{ ok: true } | { ok: false; err: unknown }>
      | undefined;
    // Await the optimistic `step_started` outcome and translate a lost race /
    // terminal run / throttle into a result that short-circuits the body
    // output. Returns undefined when we own the step and may write its terminal
    // event. A non-translatable rejection is rethrown (so a transient
    // step_started failure propagates to the queue handler for redelivery,
    // exactly as on the await path). Idempotent — safe to call more than once.
    const reconcileOptimisticStart = async (): Promise<
      StepExecutionResult | undefined
    > => {
      if (!optimisticStartSettled) return undefined;
      const settled = await optimisticStartSettled;
      if (settled.ok) return undefined;
      const mapped = startErrorToResult(settled.err);
      if (!mapped) throw settled.err;
      return mapped;
    };

    if (optimisticStart) {
      // Chain the lazy `step_started` on the run-ready barrier (turbo mode):
      // the step can't be created before its run exists, but the body below
      // runs immediately against synthesized state, so the `run_started`
      // round-trip overlaps the body rather than blocking it. Outside turbo the
      // barrier is undefined and this is a plain create.
      const startedPromise = (params.runReadyBarrier ?? Promise.resolve()).then(
        () =>
          world.events.create(workflowRunId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: {
              stepName,
              workflowName,
              input: params.lazyStepInput,
              // Inline-ownership stamp — see StepExecutorParams.ownerMessageId.
              ...(params.ownerMessageId !== undefined
                ? { ownerMessageId: params.ownerMessageId }
                : {}),
            },
          })
      );
      optimisticStartSettled = startedPromise.then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err })
      );
      const now = new Date();
      step = {
        runId: workflowRunId,
        stepId,
        stepName,
        status: 'running',
        input: params.lazyStepInput,
        attempt: 1,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      };
    } else {
      // step_started validates state and returns the step entity. On the lazy
      // inline path we also carry the step `input` so the world creates the
      // step on the fly (no separate step_created round-trip). The world's
      // atomic create-claim makes this exactly-one-owner: a concurrent loser
      // gets EntityConflictError, mapped to `{ type: 'skipped' }`, so it never
      // runs the body. When `lazyStepInput` is absent this is the legacy
      // step_started (step already created, no payload).
      try {
        // Inline-ownership stamp: present on the lazy paths AND on the
        // owned-recovery bare start (a redelivery of the owning message
        // re-executing its step must re-stamp — ownership derives from the
        // latest start, so an unstamped recovery start would read as
        // "unowned" to a later wake). The background-step path passes no
        // ownerMessageId, so its bare start clears ownership as intended.
        const ownershipStamp =
          params.ownerMessageId !== undefined
            ? { ownerMessageId: params.ownerMessageId }
            : {};
        const startResult = await world.events.create(workflowRunId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: stepId,
          eventData:
            params.lazyStepInput !== undefined
              ? {
                  stepName,
                  workflowName,
                  input: params.lazyStepInput,
                  ...ownershipStamp,
                }
              : { stepName, ...ownershipStamp },
        });

        if (!startResult.step) {
          throw new WorkflowRuntimeError(
            `step_started event for "${stepId}" did not return step entity`
          );
        }
        step = startResult.step;
      } catch (err) {
        const mapped = startErrorToResult(err);
        if (mapped) return mapped;
        throw err;
      }
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
              await getEncryptionKey(),
              [],
              globalThis,
              compression
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

    // Ops that must be durably committed before step completion (e.g. a
    // step-initiated abort's hook_received event). See StepContext. Declared
    // outside the try so the failure path below can also drain them.
    const preCompletionOps: Promise<void>[] = [];
    const ops: Promise<void>[] = [];
    let opsSettled = true;

    // Latency telemetry to attach to this step's terminal event. Computed
    // right before user code runs; declared here so the failure path (the
    // catch below) can attach it to step_failed too.
    let latencyEventData: StepLatencyEventData | undefined;

    try {
      const attempt = step.attempt;

      if (!step.startedAt) {
        throw new WorkflowRuntimeError(
          `Step "${stepId}" has no "startedAt" timestamp`
        );
      }
      const stepStartedAt = step.startedAt;
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
      const workflowBaseUrl = createWorkflowBaseUrl(
        isVercel
          ? `https://${process.env.VERCEL_URL}`
          : `http://localhost:${(await getPortLazy()) ?? 3000}`
      );

      // --- User code execution ---
      // Wrap only stepFn.apply() (user step code) so cleanup below runs on
      // BOTH success and failure. A user-code throw is captured here and
      // re-raised after cancelAbortReaders, so it still flows to the outer
      // catch (step_failed/step_retrying) — but the abort-stream reader is
      // torn down first. Without this, a throwing/retrying signal-bearing
      // step would leak a real-time abort reader per attempt.
      let userCodeError: unknown;
      let userCodeFailed = false;

      const executionStartTime = Date.now();
      latencyEventData = computeStepLatencyEventData({
        tracking: params.latencyTracking,
        stepCodeStartedAtMs: executionStartTime,
        attempt,
        lazyStepStart: params.lazyStepInput !== undefined,
        optimisticStart,
      });
      if (latencyEventData) {
        // Mirror the latency telemetry onto the step span so traces show
        // TTFS/STSO alongside the flame graph, not just Datadog metrics.
        span?.setAttributes({
          ...(latencyEventData.ttfs !== undefined
            ? Attribute.StepTtfsMs(latencyEventData.ttfs)
            : {}),
          ...(latencyEventData.stso !== undefined
            ? Attribute.StepStsoMs(latencyEventData.stso)
            : {}),
          ...Attribute.StepLatencyOptimizations(
            latencyEventData.optimizations ?? []
          ),
        });
      }
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
                url: workflowBaseUrl,
                features: { encryption: !!encryptionKey },
              },
              workflowDeploymentId: params.workflowDeploymentId,
              ops,
              preCompletionOps,
              closureVars: hydratedInput.closureVars,
              encryptionKey,
              // Turbo optimistic start runs this body before `run_started` is
              // durable. Expose the barrier so a direct step-body world write
              // (e.g. `experimental_setAttributes`) can order itself after the
              // run exists. Undefined on the await path (run already durable).
              runReadyBarrier: optimisticStart
                ? params.runReadyBarrier
                : undefined,
            },
            () => stepFn.apply(thisVal, args)
          );
        });
      } catch (err) {
        userCodeError = err;
        userCodeFailed = true;
      }
      const executionTimeMs = Date.now() - executionStartTime;

      // Tear down any abort-stream readers opened while hydrating the step's
      // arguments (a serialized AbortSignal opens a real-time abort reader for
      // the step's duration). Without this the reader's `read()` promise never
      // settles, so the `ops` flush below always loses the 500ms race and the
      // step reports `hasPendingOps` — forcing the inline loop to queue a
      // continuation and paying a full round-trip per signal-bearing step.
      // The non-inline `step-handler` path already does this after user code.
      // Runs unconditionally (success or failure) so a throwing step doesn't
      // leak the reader.
      cancelAbortReaders(...args, thisVal, hydratedInput.closureVars);

      // Re-raise a user-code failure now that cleanup has run; the outer
      // catch maps it to step_failed/step_retrying.
      if (userCodeFailed) {
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
          // Turbo optimistic start: a returned stream is piped to the server
          // after the body but within this same op flush, so gate its first
          // write on the run-ready barrier. Undefined on the await path.
          optimisticStart ? params.runReadyBarrier : undefined
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
      if (ops.length > 0) {
        const opsPromise = Promise.all(ops);
        // The race below surfaces failures inline when ops settle quickly;
        // if the 500ms timeout wins, the failure is only observed here. The
        // promise handed to waitUntil must never reject (an unconsumed
        // waitUntil rejection crashes the process as unhandledRejection),
        // so unexpected failures are logged instead.
        safeWaitUntil(opsPromise, (err) => {
          runtimeLogger.warn('Background flush of step stream ops failed', {
            workflowRunId,
            stepId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        opsSettled = await Promise.race([
          opsPromise.then(
            () => true as const,
            (err) => {
              // Ignore expected client disconnect errors (e.g., browser
              // refresh during streaming)
              const isAbortError =
                err?.name === 'AbortError' || err?.name === 'ResponseAborted';
              if (isAbortError) return true as const;
              throw err;
            }
          ),
          new Promise<false>((r) => setTimeout(() => r(false), 500)),
        ]);
      }

      // Optimistic start: the body ran before `step_started` was confirmed.
      // Reconcile it now — if we lost the create-claim (or the run is
      // gone/throttled) discard this result and don't write step_completed.
      // Reconcile before draining preCompletionOps: a discarded result means
      // the winning handler owns the outcome (and re-fires any abort
      // idempotently), so there's no point paying the abort-commit latency.
      if (optimisticStart) {
        const reconcile = await reconcileOptimisticStart();
        if (reconcile) return reconcile;
      }

      // Commit must-be-durable ops (e.g. a step-initiated abort's
      // hook_received event) before writing step_completed, so any workflow
      // continuation triggered by that event observes the abort rather than
      // racing it. These ops swallow their own errors, so awaiting only
      // enforces ordering (the `.catch()` defends the no-reject contract on
      // StepContext.preCompletionOps).
      //
      // Tradeoff: correctness requires the hook be durable before completion,
      // so — unlike the background `ops` flush above — this cannot be capped
      // with a resolve-on-timeout race. A slow resume therefore adds its
      // latency to a step that aborts a controller, and a true hang holds
      // completion until the platform/queue execution timeout fires; the queue
      // then redelivers and the step retries, re-firing the abort idempotently.
      if (preCompletionOps.length > 0) {
        await Promise.all(preCompletionOps).catch(() => {});
      }
    } catch (err: unknown) {
      // Optimistic start: the body threw before `step_started` was confirmed.
      // Reconcile first — if we lost the create-claim (or the run is
      // gone/throttled) the body error is moot; discard it and don't write a
      // terminal event (the winning handler owns the outcome). Reconcile
      // before draining preCompletionOps for the same reason as the success
      // path: a discarded outcome doesn't need the abort committed here.
      if (optimisticStart) {
        const reconcile = await reconcileOptimisticStart();
        if (reconcile) return reconcile;
      }

      // Order any must-be-durable ops (e.g. a step-initiated abort's
      // hook_received event) ahead of step_failed too — a step that aborts and
      // then throws must still have the abort recorded before the failure
      // continuation observes it. Same latency tradeoff and no-reject contract
      // as the success path above. See StepContext.preCompletionOps.
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
                await getEncryptionKey(),
                [],
                globalThis,
                compression
              ),
              ...latencyEventData,
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
                await getEncryptionKey(),
                [],
                globalThis,
                compression
              ),
              ...latencyEventData,
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
              await getEncryptionKey(),
              [],
              globalThis,
              compression
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

    // Create step_completed event outside the step execution failure path:
    // persistence failures are infrastructure errors and should redeliver the
    // queue message, not become user step_retrying/step_failed events.
    let completedResult: Awaited<ReturnType<typeof world.events.create>>;
    try {
      completedResult = await world.events.create(
        workflowRunId,
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
        params.inlineDeltaSinceCursor !== undefined
          ? { sinceCursor: params.inlineDeltaSinceCursor }
          : undefined
      );
    } catch (err) {
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
        return { type: 'skipped' };
      }
      if (RunExpiredError.is(err)) {
        stepLogger.info('Workflow run already completed, skipping step', {
          workflowRunId,
          stepId,
          message: err.message,
        });
        return { type: 'gone' };
      }
      throw err;
    }

    const inlineDelta = extractInlineDelta(
      completedResult,
      params.inlineDeltaSinceCursor !== undefined
    );

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
    return { type: 'completed', hasPendingOps: !opsSettled, inlineDelta };
  });
}
