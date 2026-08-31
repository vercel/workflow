import assert from 'node:assert/strict';
import { types } from 'node:util';
import {
  EntityConflictError,
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
  Event,
  EventResult,
  SerializedData,
  StartedStep,
  World,
} from '@workflow/world';
import {
  requireEventSlot,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
} from '@workflow/world';
import { runtimeLogger, stepLogger } from '../logger.js';
import { getStepFunction, loadStepFunction } from '../private.js';
import type { PayloadKey } from '../serialization/encryption.js';
import { formatSerializationError } from '../serialization/errors.js';
import {
  cancelAbortReaders,
  dehydrateStepError,
  dehydrateStepReturnValue,
  hydrateStepArguments,
  hydrateStepError,
} from '../serialization.js';
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
import {
  isOptimisticInlineStartEnabled,
  isOptimisticInlineStartExplicitlyDisabled,
} from './constants.js';
import { getPortLazy } from './get-port-lazy.js';
import {
  maxEventSlot,
  memoizeEncryptionKey,
  type SlotSnapshotParams,
} from './helpers.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';
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
   * Pre-claimed inline start: the suspension handler committed (or lost) this
   * step's `step_created` + `step_started` pair inside its batched fan-out
   * write, so the start this executor would otherwise send has already been
   * decided. `owned: false` returns `{ type: 'skipped' }` before any write,
   * the same outcome as losing the lazy claim's atomic create. `owned: true`
   * skips both start paths (no start write at all) and runs the body against
   * the claimed step. Mutually exclusive with `lazyStepInput`: the input
   * already rode the pair's `step_created`, and the claimed step carries it.
   */
  preclaimedStart?: PreclaimedInlineStart;
  /**
   * Inline step ownership: the queue message ID of the invocation this
   * executeStep call runs in (from the queue handler's meta). When set, the
   * `step_started` this call sends is stamped with it: on the lazy paths
   * (where `lazyStepInput` is present) and on the owned-recovery
   * payload-less start (where it is not; the re-stamp keeps a recovered
   * step readable as owned by this message, since ownership derives from
   * the LATEST start, so a recovery start is never bare). Wake
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
   * How much of the run's log the caller's replay had loaded when it scheduled
   * this step, as the highest slot that log occupies. Seeds the snapshot every
   * write this executor makes carries; each committed event advances it to its
   * own slot, so a later write never names a position that predates an earlier
   * one from the same step.
   *
   * It matters most on the lazy inline path, where the `step_started` claim is
   * the step's FIRST durable write (its `step_created` is deferred): without a
   * seed the claim would name no position at all, and a replay working from a
   * stale view could claim (and then commit) a step scheduled without
   * observing an event it never loaded.
   *
   * A World that fences rejects a stale claim with `PreconditionFailedError`
   * (412); executeStep does NOT translate that rejection (re-claiming in place
   * would still commit the stale schedule), so it propagates for the caller to
   * abandon the batch and restart its replay. Undefined for a caller with
   * nothing loaded.
   */
  slotSnapshot?: SlotSnapshotParams;
  /**
   * Suppress optimistic inline start for this step regardless of
   * `WORKFLOW_OPTIMISTIC_INLINE_START` / `forceOptimisticStart`: take the
   * await-then-run path so the body only runs after the `step_started` claim
   * succeeds. Set by the runtime for guard-enforced batches that are
   * stale-sensitive (an open hook means an out-of-band event can make the
   * scheduling view stale): the guard's 412 fence can reject a stale claim's
   * durable writes, but it cannot un-run a body that optimistic start began
   * before the claim settled; awaiting the claim extends the fence to user
   * code. Wins over `forceOptimisticStart` and the env flag.
   */
  suppressOptimisticStart?: boolean;
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
   * still runs immediately against locally-synthesized state (only the network
   * write waits), so the `run_started` round-trip overlaps the body. `undefined`
   * outside turbo, where `run_started` was already awaited up front.
   */
  runReadyBarrier?: Promise<unknown>;
  /**
   * Latency telemetry (TTFS / STSO): eligibility and anchor timestamps decided
   * by the orchestrator. When set, this executor computes the final values
   * against the wall clock taken immediately before user code runs and
   * attaches them to the step's terminal event. Set only for the first step of
   * an inline batch, and only on first-attempt executions that qualify; see
   * runtime/step-latency.ts.
   */
  latencyTracking?: StepLatencyTracking;
  /**
   * Hook-resume TTR telemetry: the boundaries of a hook resumption whose next
   * durable step is the one this call is about to execute. When set, the
   * executor closes the measurement against the `step_started` claim and the
   * wall clock taken immediately before user code, and attaches the total plus
   * its phase breakdown to this step's `step.execute` span. Set by the runtime
   * for exactly one step per resumption; see runtime/resume-latency.ts.
   */
  resumeTracking?: ResumeTtrTracking;
  /**
   * Authoritative attempt number for this execution, used to bound retries
   * against `maxRetries` BEFORE the body runs. To also catch
   * step timeouts (which we can't have catch handlers for), we determine
   * the attempt count based as follows:
   * - Inline (combined handler): the number of `step_started` events already
   *   in the event log for this step, plus one for the attempt about to run.
   * - Background (queue-dispatched): the queue delivery count
   *   (`metadata.attempt`), which increments on every redelivery.
   */
  authoritativeAttempt?: number;
  /** One-shot recovery telemetry activated by the orchestrator replay. */
  replayRecoveryReporter?: ReplayRecoveryReporter;
}

/**
 * The settled outcome of a `step_created` + `step_started` pair the
 * suspension handler folded into its batched fan-out write (see
 * `SuspensionHandlerResult.inlineClaims`). Handed to executeStep as
 * {@link StepExecutorParams.preclaimedStart} so the executor runs (or skips)
 * the body off the batch's verdict instead of sending a start of its own.
 */
export type PreclaimedInlineStart =
  | {
      /** The pair committed: this execution owns the step and runs the body. */
      owned: true;
      /**
       * The started step entity from the batch result, with the locally
       * dehydrated input attached by the suspension handler (batch responses
       * return refs lazily; the body's hydration wants the same bytes the
       * pair's `step_created` carried).
       */
      step: StartedStep;
      /**
       * `Date.now()` taken right before the batch POST that carried the pair:
       * the claim's "start POST sent" instant, anchoring RSFS exactly like
       * the lazy claim's own POST would.
       */
      batchPostSentAtMs?: number;
      /**
       * `Date.now()` taken right after that batch POST returned: the
       * claim's completion instant (T6 of the hook-resume TTR window).
       */
      claimCompletedAtMs?: number;
    }
  | {
      /**
       * The pair lost its atomic create-claim (per-event 409): a concurrent
       * writer owns the step, so the body must not run here.
       */
      owned: false;
    };

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
 * Does NOT queue workflow continuation messages; the caller decides what to do next.
 * Used by the combined workflow handler for step execution.
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
  // Truthiness, not presence: `vercel env pull` writes `VERCEL_URL=""` into
  // `.env.local`, and a framework that loads that file locally would otherwise
  // put us on the Vercel branch with nothing to build a host from, making
  // `https://` the base URL of every step.
  const isVercel = Boolean(process.env.VERCEL_URL);
  // Gate payload compression on the run's specVersion.
  const compression =
    (params.runSpecVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION;
  const replayRecoveryReporter =
    params.replayRecoveryReporter ?? ReplayRecoveryReporter.inert();
  /**
   * The highest log slot this executor knows about, seeded from the view its
   * caller scheduled the step against and advanced by every event it commits.
   *
   * Advancing is what keeps the snapshot honest across a step's own writes. A
   * step commits `step_started` and then `step_completed`; if the second still
   * named the caller's original position, the World would report the first one
   * back as an event this writer had not seen, on every step, forever.
   *
   * This reads a report for its highest position and then discards it, where
   * the replay loop and the suspension handler merge theirs with
   * `absorbSkippedSlotReport`. That is the difference between the callers, not
   * an oversight: an executor holds no loaded log to merge into. It runs from a
   * queued delivery whose only view of the log is the integer its caller passed
   * in, so the position is the entire value the report has to it. Whoever
   * replays next loads the log and gets the events themselves.
   */
  let knownSlot = params.slotSnapshot?.eventCount;
  const observeSlot = (result: { event?: Event; events?: Event[] }): void => {
    if (knownSlot === undefined) {
      // The caller scheduled this step without naming a position, so there is
      // no snapshot to advance and the writes below send none. Not the same as
      // a run without positions: every run has them, this executor was not
      // told which one it started from.
      return;
    }
    const observed: number[] = [];
    if (result.event) {
      observed.push(requireEventSlot(result.event.eventId));
    }
    const reported = maxEventSlot(result.events ?? []);
    if (reported !== undefined) {
      observed.push(reported);
    }
    for (const slot of observed) {
      if (slot > knownSlot) {
        knownSlot = slot;
      }
    }
  };
  const createEvent = async <T extends CreateEventRequest>(
    data: T,
    eventParams?: CreateEventParams
  ) => {
    const result = await replayRecoveryReporter.withEventCreate(
      knownSlot === undefined
        ? eventParams
        : { eventCount: knownSlot, ...eventParams },
      (p) => world.events.create(workflowRunId, data, p)
    );
    observeSlot(result);
    return result;
  };

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
    });

    // The two lazy start modes are mutually exclusive by construction (the
    // caller sets one or the other), and several branches below read only one
    // of them to decide whether the step is brand-new. Enforced rather than
    // documented so a caller that ever sets both fails here instead of
    // silently taking the pre-claimed path with an unsent input.
    assert(
      !(params.lazyStepInput !== undefined && params.preclaimedStart),
      'executeStep: lazyStepInput and preclaimedStart are mutually exclusive'
    );

    // A pre-claimed start that LOST the batched pair's atomic create-claim: a
    // concurrent writer owns this step. Same outcome as losing the lazy
    // claim (EntityConflictError → skipped), decided before ANY write, the
    // unregistered-step fallback below included, since a step this handler
    // does not own is not its to fail.
    if (params.preclaimedStart && params.preclaimedStart.owned === false) {
      runtimeLogger.debug('Pre-claimed step start lost, skipping', {
        stepName,
        stepId,
        workflowRunId,
      });
      span?.setAttributes({
        ...Attribute.StepSkipped(true),
        // `running`, not `completed`: the pair's 409 says the step already
        // EXISTS, and the writer that won the create-claim is executing it.
        // The other skip site below is a genuine terminal-state conflict;
        // tagging both `completed` would make the attribute read 100%
        // `completed` and lose the only distinction worth querying it for.
        ...Attribute.StepSkipReason('running'),
      });
      return { type: 'skipped' };
    }

    // Memoized accessor for the per-run encryption key. The first caller
    // (input hydration on the success path, or one of the early-return
    // dehydrateStepError paths if step_started fails) triggers the actual
    // fetch / HKDF derivation; subsequent callers await the cached promise.
    const getEncryptionKey = memoizeEncryptionKey(world, workflowRunId);

    // A registered step exposes maxRetries without invoking a lazy module
    // loader. Preserve the pre-claim retry ceiling for this common path;
    // lazy loaders themselves must wait until after the claim so their load
    // errors can be durably recorded on the step.
    const registeredStepFn = getStepFunction(stepName);
    if (
      typeof registeredStepFn === 'function' &&
      params.authoritativeAttempt !== undefined &&
      params.authoritativeAttempt >
        (registeredStepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES) + 1
    ) {
      const maxRetries =
        registeredStepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
      const errorMessage = `Step "${stepName}" exceeded max retries (${maxRetries} ${pluralize('retry', 'retries', maxRetries)})`;
      stepLogger.error('Step exceeded max retries', {
        workflowRunId,
        stepName,
        stepId,
        attempt: params.authoritativeAttempt,
        maxRetries,
      });
      try {
        await createEvent({
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
      } catch (err) {
        if (EntityConflictError.is(err)) return { type: 'skipped' };
        if (RunExpiredError.is(err)) return { type: 'gone' };
        throw err;
      }
      span?.setAttributes({
        ...Attribute.StepStatus('failed'),
        ...Attribute.StepRetryExhausted(true),
      });
      return { type: 'failed' };
    }

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
    // is always brand-new ⇒ attempt 1, no prior error, started now, so we
    // don't need the server round-trip to begin. We reconcile the in-flight
    // `step_started` before any terminal write (`reconcileOptimisticStart`): if
    // it lost the atomic create-claim (409) or the run is gone/throttled, we
    // discard the body result. Running the body before confirming ownership can
    // execute a step more than once when handlers race, so inline step bodies
    // must be idempotent; disable via WORKFLOW_OPTIMISTIC_INLINE_START=0.
    //
    // Turbo mode passes `forceOptimisticStart` to enable this regardless of the
    // env flag (its single-handler guarantee removes the race). But it still
    // defers to an *explicit* `WORKFLOW_OPTIMISTIC_INLINE_START=0`: forced
    // optimistic start runs the body before `step_started`/`run_started` is
    // confirmed, which is exactly the property an operator opts out of with that
    // flag, so an explicit opt-out wins over turbo's force.
    const optimisticStart =
      // A pre-claimed start already settled its claim in the suspension
      // batch; there is nothing to fire optimistically (lazyStepInput is
      // also absent on that path; this term is documentation).
      params.preclaimedStart === undefined &&
      params.lazyStepInput !== undefined &&
      // Stale-sensitive guarded batches await the claim so the 412 fence
      // covers the body, not just durable writes; see
      // StepExecutorParams.suppressOptimisticStart.
      params.suppressOptimisticStart !== true &&
      (isOptimisticInlineStartEnabled() ||
        (params.forceOptimisticStart === true &&
          !isOptimisticInlineStartExplicitlyDisabled()));

    let step: StartedStep;
    // Params for the `step_started` create on either path below. The slot
    // snapshot is not spread here: `createEvent` attaches it to every write,
    // this one included.
    const startEventParams = stepStartedEventParams;
    // `Date.now()` taken immediately before the `step_started` create is
    // issued (either path below); anchors RSFS's end point. See
    // StepLatencyEventData.rsfs and the call sites below.
    let stepStartPostSentAtMs: number | undefined;
    // `Date.now()` taken once the `step_started` response has returned and the
    // claim succeeded: T6 of the hook-resume TTR window. Only the await path
    // can set it: optimistic inline start deliberately does not wait for the
    // claim before running the body, so at T7 it has no completion instant and
    // the TTR breakdown reports no `step_claim_ms` (see
    // runtime/resume-latency.ts).
    let stepClaimCompletedAtMs: number | undefined;
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
    // exactly as on the await path). Idempotent: safe to call more than once.
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

    if (params.preclaimedStart?.owned) {
      // Pre-claimed inline start: the suspension handler's batched fan-out
      // already committed this step's `step_created` + `step_started` pair,
      // so this execution owns a started attempt-1 step without sending a
      // start of its own: the body begins straight off the batch commit and
      // the terminal write below has no in-flight claim to reconcile. The
      // batch timestamps stand in for the claim's: the POST instant anchors
      // RSFS, the response instant is TTR's claim completion (T6).
      step = params.preclaimedStart.step;
      stepStartPostSentAtMs = params.preclaimedStart.batchPostSentAtMs;
      stepClaimCompletedAtMs = params.preclaimedStart.claimCompletedAtMs;
    } else if (optimisticStart) {
      // Chain the lazy `step_started` on the run-ready barrier (turbo mode):
      // the step can't be created before its run exists, but the body below
      // runs immediately against synthesized state, so the `run_started`
      // round-trip overlaps the body rather than blocking it. Outside turbo the
      // barrier is undefined and this is a plain create.
      const startedPromise = (params.runReadyBarrier ?? Promise.resolve()).then(
        () => {
          // Taken right before the create fires, not before the barrier:
          // RSFS measures the run_started-to-POST stretch, and the barrier
          // wait IS part of that stretch under turbo.
          stepStartPostSentAtMs = Date.now();
          return createEvent(
            {
              eventType: 'step_started',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: stepId,
              eventData: {
                stepName,
                workflowName,
                input: params.lazyStepInput,
                // Inline-ownership stamp; see StepExecutorParams.ownerMessageId.
                ...(params.ownerMessageId !== undefined
                  ? { ownerMessageId: params.ownerMessageId }
                  : {}),
              },
            },
            // Guard the claim; see StepExecutorParams.slotSnapshot. A
            // stale (412) rejection surfaces via reconcileOptimisticStart as a
            // non-translatable error: the body result is discarded and the
            // rejection propagates to the caller.
            startEventParams
          );
        }
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
        // owned-recovery payload-less start (a redelivery of the owning
        // message re-executing its step must re-stamp, since ownership derives
        // from the latest start, so an unstamped recovery start would read
        // as "unowned" to a later wake). Only the background-step path
        // passes no ownerMessageId: its start is the bare one, clearing
        // ownership as intended.
        const ownershipStamp =
          params.ownerMessageId !== undefined
            ? { ownerMessageId: params.ownerMessageId }
            : {};
        stepStartPostSentAtMs = Date.now();
        const startResult = await createEvent(
          {
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
          },
          // Guard the claim; see StepExecutorParams.slotSnapshot. A
          // stale (412) rejection is intentionally NOT translated by
          // startErrorToResult below, so it propagates to the caller for a
          // fresh replay.
          startEventParams
        );
        stepClaimCompletedAtMs = Date.now();

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

    let stepFn: Awaited<ReturnType<typeof loadStepFunction>>;
    try {
      stepFn = await loadStepFunction(stepName);
    } catch (err) {
      if (optimisticStart) {
        const reconcile = await reconcileOptimisticStart();
        if (reconcile) return reconcile;
      }

      const normalizedError = await normalizeUnknownError(err);
      const normalizedStack = normalizedError.stack || getErrorStack(err) || '';
      const wrappedError = new FatalError(
        `Failed to load step "${stepName}": ${normalizedError.message}`
      );
      (wrappedError as Error).cause = err;
      if (normalizedStack) wrappedError.stack = normalizedStack;

      stepLogger.error('Failed to load step function, failing step', {
        workflowRunId,
        stepName,
        errorStack: normalizedStack,
      });

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

    if (!stepFn || typeof stepFn !== 'function') {
      // Step function not registered — fail the step (not the run).
      const errorMessage = `Step "${stepName}" is not registered in the current deployment. This usually indicates a build or bundling issue that caused the step to not be included in the deployment.`;
      runtimeLogger.error('Step function not registered, failing step', {
        workflowRunId,
        stepName,
        stepId,
      });

      if (optimisticStart) {
        const reconcile = await reconcileOptimisticStart();
        if (reconcile) return reconcile;
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

    // Enforce the retry ceiling before running the body. This has to happen
    // after loading the function because maxRetries is defined on it.
    if (
      params.authoritativeAttempt !== undefined &&
      params.authoritativeAttempt > maxRetries + 1
    ) {
      const retryCount = maxRetries;
      const errorMessage = `Step "${stepName}" exceeded max retries (${retryCount} ${pluralize('retry', 'retries', retryCount)})`;
      stepLogger.error('Step exceeded max retries', {
        workflowRunId,
        stepName,
        stepId,
        attempt: params.authoritativeAttempt,
        maxRetries,
      });
      try {
        await createEvent({
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
      } catch (err) {
        if (EntityConflictError.is(err)) return { type: 'skipped' };
        if (RunExpiredError.is(err)) return { type: 'gone' };
        throw err;
      }
      span?.setAttributes({
        ...Attribute.StepStatus('failed'),
        ...Attribute.StepRetryExhausted(true),
      });
      return { type: 'failed' };
    }

    let result: unknown;

    // Check max retries AFTER step_started (attempt was just incremented).
    // Only enforce when the step has a previous error; this distinguishes
    // actual retries (failed → retry) from concurrent inline starts
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
          // Ignore: best-effort cause attachment.
        }
      }
      try {
        await createEvent({
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

    // Backfill RSFS onto the already-computed telemetry once the optimistic
    // turbo start has settled. On that path the step-start POST fires inside
    // the run-ready barrier's `.then`, so `stepStartPostSentAtMs` (and
    // therefore RSFS) is usually still unset when `latencyEventData` is
    // first computed just before user code (the barrier is still in flight
    // for any non-trivial `run_started` round-trip, which is exactly the
    // slow-run_started case RSFS exists to measure). By the time
    // `reconcileOptimisticStart()` has awaited the barrier the POST timestamp
    // is known, so we patch RSFS in before the terminal event is written.
    // Without this, slow-run_started samples are dropped, biasing RSFS
    // percentiles low (missing-not-at-random). Recomputes only RSFS;
    // TTFS/STSO stay anchored to `executionStartTime` as computed above.
    const backfillOptimisticRsfs = (): void => {
      if (!latencyEventData || latencyEventData.rsfs !== undefined) return;
      const anchorMs = params.latencyTracking?.rsfsAnchorMs;
      if (anchorMs === undefined || stepStartPostSentAtMs === undefined) return;
      latencyEventData.rsfs = Math.max(0, stepStartPostSentAtMs - anchorMs);
      if (span) {
        span.setAttributes({
          ...Attribute.StepRsfsMs(latencyEventData.rsfs),
        });
      }
    };

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

      // Finalization of an unserializable-argument step writes step_created
      // (placeholder input) and step_failed as two separate durable writes.
      // A crash or transient failure between them leaves this step pending
      // with the placeholder stored as its input, and normal crash recovery
      // then dispatches it here. NEVER run user code with placeholder
      // arguments; complete the intended failure instead. The
      // SerializationError is fatal (`fatal: true`), so the catch below
      // writes step_failed without retries, exactly what the interrupted
      // finalization was about to do.
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
      // Wrap only stepFn.apply() (user step code) so cleanup below runs on
      // BOTH success and failure. A user-code throw is captured here and
      // re-raised after cancelAbortReaders, so it still flows to the outer
      // catch (step_failed/step_retrying), but the abort-stream reader is
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
        preclaimedStart: params.preclaimedStart !== undefined,
        stepStartPostSentAtMs,
      });
      if (latencyEventData) {
        // Mirror the latency telemetry onto the step span so traces show
        // TTFS/STSO/RSFS alongside the flame graph, not just Datadog metrics.
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
      /**
       * Close the hook-resume TTR measurement (see runtime/resume-latency.ts).
       *
       * Called from INSIDE `contextStorage.run`, immediately before
       * `stepFn.apply()`, deliberately not alongside the step-latency
       * telemetry above. `executionStartTime` is taken before the inner
       * `step.execute` span and the step context are established, and
       * `step_prepare_ms` is documented to include exactly that setup, so
       * anchoring T7 there would under-report both the phase and the total.
       * TTFS/STSO keep their own anchor so this changes nothing about them.
       *
       * The `reported` latch makes one resumption yield one sample even
       * though every step of an inline batch is handed the same tracking
       * object: whichever step first reaches user code takes the
       * measurement. Sharing it (rather than pinning the batch's first step)
       * is what keeps the sample alive when that first step loses its atomic
       * create-claim to a concurrent invocation while a sibling proceeds.
       * The check-and-set is synchronous, so concurrent siblings cannot both
       * pass it.
       */
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
              rootRunId: params.rootRunId,
              ops,
              preCompletionOps,
              closureVars: hydratedInput.closureVars,
              encryptionKey,
              // Turbo optimistic start runs this body before `run_started` is
              // durable. Expose the barrier so a direct step-body world write
              // (e.g. `setAttributes`) can order itself after the
              // run exists. Undefined on the await path (run already durable).
              runReadyBarrier: optimisticStart
                ? params.runReadyBarrier
                : undefined,
            },
            () => {
              // The last instant before user code: T7 of the resume window.
              reportResumeTtr();
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

      // Tear down any abort-stream readers opened while hydrating the step's
      // arguments (a serialized AbortSignal opens a real-time abort reader for
      // the step's duration). Without this the reader's `read()` promise never
      // settles, so the `ops` flush below always loses the 500ms race and the
      // step reports `hasPendingOps`, forcing the inline loop to queue a
      // continuation and paying a full round-trip per signal-bearing step.
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
      // WorkflowServerWritableStream acks writes on buffer entry
      // (group-commit batching); durability is enforced by its drain
      // barrier, which the flushable state's completion awaits after
      // lock release. Most ops settle within ~200ms (lock-release
      // polling + one batched HTTP flush).
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
      // Reconcile it now: if we lost the create-claim (or the run is
      // gone/throttled) discard this result and don't write step_completed.
      // Reconcile before draining preCompletionOps: a discarded result means
      // the winning handler owns the outcome (and re-fires any abort
      // idempotently), so there's no point paying the abort-commit latency.
      if (optimisticStart) {
        const reconcile = await reconcileOptimisticStart();
        if (reconcile) return reconcile;
        // Barrier resolved: the step-start POST timestamp is now known, so
        // RSFS can be attached to the step_completed event below.
        backfillOptimisticRsfs();
      }

      // Commit must-be-durable ops (e.g. a step-initiated abort's
      // hook_received event) before writing step_completed, so any workflow
      // continuation triggered by that event observes the abort rather than
      // racing it. These ops swallow their own errors, so awaiting only
      // enforces ordering (the `.catch()` defends the no-reject contract on
      // StepContext.preCompletionOps).
      //
      // Tradeoff: correctness requires the hook be durable before completion,
      // so, unlike the background `ops` flush above, this cannot be capped
      // with a resolve-on-timeout race. A slow resume therefore adds its
      // latency to a step that aborts a controller, and a true hang holds
      // completion until the platform/queue execution timeout fires; the queue
      // then redelivers and the step retries, re-firing the abort idempotently.
      if (preCompletionOps.length > 0) {
        await Promise.all(preCompletionOps).catch(() => {});
      }
    } catch (err: unknown) {
      // Optimistic start: the body threw before `step_started` was confirmed.
      // Reconcile first: if we lost the create-claim (or the run is
      // gone/throttled) the body error is moot; discard it and don't write a
      // terminal event (the winning handler owns the outcome). Reconcile
      // before draining preCompletionOps for the same reason as the success
      // path: a discarded outcome doesn't need the abort committed here.
      if (optimisticStart) {
        const reconcile = await reconcileOptimisticStart();
        if (reconcile) return reconcile;
        // Barrier resolved: attach RSFS to the step_failed event(s) below.
        backfillOptimisticRsfs();
      }

      // Order any must-be-durable ops (e.g. a step-initiated abort's
      // hook_received event) ahead of step_failed too: a step that aborts and
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
          await createEvent({
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
          await createEvent({
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
        await createEvent({
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
    // hasPendingOps signals the combined handler to break the loop
    // and queue a continuation so waitUntil can flush them.
    return { type: 'completed', hasPendingOps: !opsSettled, inlineDelta };
  });
}
