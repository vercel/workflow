/**
 * QuickJS WebAssembly (WASM) VM integration with the Workflow DevKit.
 *
 * This module provides the entry point for running workflows in the
 * QuickJS VM engine instead of the `node:vm` engine. Both engines
 * implement the same event-replay execution model, where every invocation:
 *
 * 1. Loads the full event log for the run
 * 2. Runs the workflow function from the top in a fresh QuickJS VM,
 *    replaying the event log to resolve awaited primitives
 * 3. On suspension: creates events + queues steps for new pending ops
 * 4. On completion: creates run_completed
 * 5. On failure: creates run_failed
 */

import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  HookNotFoundError,
  MaxEventsExceededError,
  RunExpiredError,
  ThrottleError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type EventResult,
  ROOT_RUN_ID_ATTRIBUTE,
  type RunInput,
  type SerializedData,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotMetadata,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowRun,
} from '@workflow/world';
import { classifyRunError } from '../classify-error.js';
import { runtimeLogger } from '../logger.js';
import { getStepFunction } from '../private.js';
import {
  deriveRunPayloadKeys,
  encrypt as encryptSerializedData,
  type RunPayloadKeys,
} from '../serialization/encryption.js';
import {
  dehydrateRunError,
  dehydrateStepArguments,
  dehydrateStepError,
  hydrateRunError,
  maybeEncrypt,
} from '../serialization.js';
import { remapErrorStack, stripInlineSourceMap } from '../source-map.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier, trace } from '../telemetry.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { getMaxInlineSteps } from './constants.js';
import { getPortLazy } from './get-port-lazy.js';
import {
  getWorkflowQueueName,
  maxEventSlot,
  queueMessage,
  REPLAY_RESOLVE_DATA,
  runDispatchContext,
  stepDispatchIdempotencyKey,
} from './helpers.js';
import {
  publishForceClaimVictimWake,
  republishOwedForceClaimVictimWakes,
} from './hook-wake.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
} from './lifecycle-hooks.js';
import {
  schedulesWaitTimer,
  stepsToReenqueue,
} from './orchestrator/creator-rules.js';
import {
  type InBandWriter,
  OrchestratorSupersededError,
} from './orchestrator/in-band-writer.js';
import {
  getOrchestratorLingerMs,
  getOrchestratorPollIntervalMs,
  LiveLogFeed,
} from './orchestrator/live-feed.js';
import {
  analyzeLogSteps,
  awaitsExternalWork,
  type LogStepState,
  MAX_STEP_MESSAGE_INPUT_BYTES,
} from './orchestrator/log-state.js';
import { stepMessageRetentionSeconds } from './orchestrator/step-retention.js';
import { quickjsWasiVersion } from './quickjs-assets.generated.js';
import { QuickJSLogView } from './quickjs-log-view.js';
import {
  BASELINE_BUNDLE_FILENAME,
  type PendingAttribute,
  type PendingHook,
  type PendingHookDispose,
  type PendingOperation,
  type PendingStep,
  type PendingWait,
  startQuickJSWorkflow,
} from './quickjs-runtime.js';
import {
  checkSnapshotMetadataBounds,
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  openSnapshot,
  SnapshotRejectedError,
  sealSnapshot,
} from './quickjs-snapshot-codec.js';
import { ReplayBudget } from './replay-budget.js';
import {
  type CallerStart,
  DEFAULT_STEP_MAX_RETRIES,
  executeStep,
  type StepExecutionResult,
} from './step-executor.js';
import { runStepSingleFlight } from './step-single-flight.js';
import { unserializableStepInputPlaceholder } from './unserializable-step.js';
import {
  getSnapshotThresholdForHandler,
  isSnapshotThresholdConfigured,
  isUnencryptedSnapshottingAllowed,
} from './vm-mode.js';
import { getWaitContinuationDispatch } from './wait-continuation.js';
import { safeWaitUntil } from './wait-until.js';
import { getWorld } from './world.js';

/** An `events.create` bound to the run; see `dispatchPendingOps.createEvent`. */
type EventCreator = (
  data: CreateEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

/** Tiny ms timer using performance.now(), already monotonic on Node. */
function tick(): number {
  return performance.now();
}

/**
 * Returns true when the supplied preloaded events indicate this is the
 * first workflow handler invocation for the run, i.e. the log contains
 * nothing beyond `run_created` / `run_started`. In that case the
 * preloaded events ARE the complete event log and the `events.list`
 * round-trips can be skipped entirely.
 *
 * Crucially, if the world backfilled a missing `run_created` via the
 * resilient start path, `preloadedEvents` contains it even when a fresh
 * `events.list` might not (eventual consistency), so preferring the
 * preloaded events on first invocation is also the more correct choice.
 *
 * Returns false when `preloadedEvents` is missing/empty so the caller
 * falls back to the normal fetch path.
 *
 * Exported for unit testing.
 */
export function isFirstInvocation(
  preloadedEvents: readonly Event[] | undefined
): boolean {
  if (!Array.isArray(preloadedEvents) || preloadedEvents.length === 0) {
    return false;
  }
  return preloadedEvents.every(
    (e) => e.eventType === 'run_created' || e.eventType === 'run_started'
  );
}

/**
 * Queue a step for background execution via the unified workflow queue
 * (V2 architecture). The combined handler in runtime.ts dispatches
 * messages with `stepId` to executeStep, which works for both VM engines.
 * `delaySeconds` supports retry/throttle backoff.
 */
async function queueStepMessage(params: {
  world: Awaited<ReturnType<typeof getWorld>>;
  runId: string;
  workflowRun: WorkflowRun;
  step: PendingStep;
  delaySeconds?: number;
  /** Queue namespace for the publish (see runtime.ts). */
  namespace: string | undefined;
  /** Run-origin trace carrier accessor (see runWorkflowWithQuickJS). */
  nextTraceCarrier: () => Promise<Record<string, string>>;
  /**
   * Publish purpose, used to bucket the idempotency key. Worlds retire
   * used keys (VQS retention TTL, world-postgres completed-keys cache),
   * so a key shared across purposes silently swallows the second
   * publish. See wait-continuation.ts for the same hazard on wait
   * keys. `dispatch` is the plain background handoff (overflow / crash
   * recovery) and uses the step-identity-scoped dispatch key
   * (stepDispatchIdempotencyKey) so it stays mutually
   * exclusive with the node engine's dispatch of the same step;
   * `backstop:<epoch>` covers delayed crash backstops, scoped to the
   * ownership epoch so a refreshed lease re-arms a NEW backstop instead
   * of being absorbed by the in-flight one; `retry:<n>` covers delayed
   * retry/throttle re-enqueues, scoped to the attempt so each backoff
   * hop is enqueueable.
   */
  purpose: 'dispatch' | `backstop:${string}` | `retry:${number}`;
  /**
   * Resilient step dispatch: the serialized (possibly encrypted) step input
   * to carry on the message as `stepInput`, so the consumer can idempotently
   * re-ensure the `step_created` event if the producer's parallel direct
   * write failed transiently. Only set on `dispatch` publishes that
   * dispatchPendingOps parallelizes with the step_created write.
   */
  stepInput?: Uint8Array;
  /** The attempt the message starts with, when above 1. */
  stepAttempt?: number;
  /** Event id of the step's `step_created`, for reading its input back. */
  stepCreatedEventId?: string;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<void> {
  const {
    world,
    runId,
    workflowRun,
    step,
    delaySeconds,
    namespace,
    nextTraceCarrier,
    purpose,
    stepInput,
    wfdiag,
  } = params;
  const traceCarrier = await nextTraceCarrier();
  await queueMessage(
    world,
    getWorkflowQueueName(workflowRun.workflowName, namespace),
    {
      runId,
      stepId: step.correlationId,
      stepName: step.stepId,
      traceCarrier,
      requestedAt: new Date(),
      ...(stepInput !== undefined ? { stepInput: { input: stepInput } } : {}),
      ...(params.stepAttempt !== undefined && params.stepAttempt > 1
        ? { stepAttempt: params.stepAttempt }
        : {}),
      ...(params.stepCreatedEventId
        ? { stepCreatedEventId: params.stepCreatedEventId }
        : {}),
      // Immutable run identity so the consumer can start the step without a
      // blocking runs.get — see RunDispatchContextSchema.
      runContext: runDispatchContext(workflowRun),
    },
    {
      // The 'dispatch' key is step-identity-scoped (correlationId + hashed
      // step name), shared with the node engine's dispatch of the same step
      // so the two stay mutually exclusive, without a revoked resilient
      // message absorbing a reassigned correlation id's legitimate dispatch.
      // See stepDispatchIdempotencyKey.
      idempotencyKey:
        purpose === 'dispatch'
          ? stepDispatchIdempotencyKey(step.correlationId, step.stepId)
          : `${step.correlationId}:${purpose}`,
      retentionSeconds: stepMessageRetentionSeconds(
        getStepFunction(step.stepId)?.maxRetries ?? DEFAULT_STEP_MAX_RETRIES
      ),
      ...(delaySeconds && delaySeconds > 0 ? { delaySeconds } : {}),
    }
  );
  wfdiag('step_queued', {
    stepId: step.stepId,
    correlationId: step.correlationId,
    purpose,
    delaySeconds: delaySeconds ?? 0,
    ...(stepInput !== undefined ? { resilient: true } : {}),
  });
}

/**
 * Runs whose heap exceeded {@link MAX_SNAPSHOT_PLAINTEXT_BYTES} at some
 * suspension. WASM linear memory never shrinks, so a run that crossed
 * the ceiling once will exceed it at EVERY later suspension — without
 * this latch each of those would re-pay `session.snapshot()` (two full
 * copies of the heap) just to discard the result. Process-local by
 * design: the warm instance replaying the same run repeatedly is where
 * the repeated cost lives; a cold instance pays one probe and re-latches.
 * Bounded defensively (a process rarely sees many distinct oversized
 * runs).
 */
const oversizedSnapshotRuns = globalSingleton(
  '@workflow/core//quickjsOversizedSnapshotRuns',
  1,
  () => new Set<string>()
);
const OVERSIZED_SNAPSHOT_RUNS_MAX = 1024;

function latchOversizedSnapshotRun(runId: string): void {
  if (oversizedSnapshotRuns.size >= OVERSIZED_SNAPSHOT_RUNS_MAX) {
    oversizedSnapshotRuns.clear();
  }
  oversizedSnapshotRuns.add(runId);
}

/**
 * Runs this process has observed with a log still below the snapshot
 * threshold at the end of an invocation, and no snapshot restored or
 * saved. A snapshot is only ever saved once a run's log has reached the
 * threshold (the save gate counts every event the saving VM processed),
 * so for these runs the next invocation's `snapshots.load` would be a
 * guaranteed miss: an awaited round-trip on the resume's critical path
 * that short runs, by design, should never pay. The next invocation in
 * this process skips the probe instead.
 *
 * Staleness is safe in the only direction it can go: another instance may
 * have grown the log past the threshold and saved a snapshot since, and
 * skipping the load then costs one full replay (always correct). That
 * invocation sees a log at or above the threshold and clears the entry,
 * so the next one probes again. Bounded like the oversized latch.
 */
const runsBelowSnapshotThreshold = globalSingleton(
  '@workflow/core//quickjsRunsBelowSnapshotThreshold',
  1,
  () => new Set<string>()
);
const RUNS_BELOW_SNAPSHOT_THRESHOLD_MAX = 4096;

function noteSnapshotThresholdProgress(
  runId: string,
  belowThreshold: boolean
): void {
  if (!belowThreshold) {
    runsBelowSnapshotThreshold.delete(runId);
    return;
  }
  if (runsBelowSnapshotThreshold.size >= RUNS_BELOW_SNAPSHOT_THRESHOLD_MAX) {
    runsBelowSnapshotThreshold.clear();
  }
  runsBelowSnapshotThreshold.add(runId);
}

/** Test-only: forget the process-local snapshot latches. */
export function __resetSnapshotLatchesForTests(): void {
  oversizedSnapshotRuns.clear();
  runsBelowSnapshotThreshold.clear();
}

/**
 * Dispatch durable side effects for a set of pending VM operations:
 * step_created (+ optional queueing), hook_created / hook_received (aborts),
 * attr_set, hook_disposed, and wait_created events.
 *
 * Steps are created but (usually) not queued here: queueing (or inline
 * execution) is the caller's decision. Used both for suspension
 * processing (the inline loop) and for the terminal drain (flushing
 * leftover side effects when the workflow completed or failed, mirroring
 * the node:vm engine's drainPendingQueueItems).
 *
 * The one exception is resilient step dispatch: for step cids named in
 * `queueStepCids` (the caller's overflow steps) that pass the eligibility
 * gates, the step_created write is parallelized with the step's queue
 * publish: the message carries the serialized input (`stepInput`) so the
 * consumer can idempotently re-ensure the event if the direct write failed
 * transiently. Steps queued this way are reported in `queuedStepCids`; the
 * caller queues the rest itself.
 */
async function dispatchPendingOps(params: {
  world: Awaited<ReturnType<typeof getWorld>>;
  runId: string;
  /**
   * The seam every event write in this pass goes through. The inline loop
   * passes a create that names the log position this invocation holds
   * (`eventCount`) and queues what the World hands back for the live VM; see
   * {@link QuickJSLogView}. The terminal drain passes a plain create, since
   * the run is ending and nothing reads its log afterwards.
   */
  createEvent: EventCreator;
  /**
   * The cursor this invocation's log was read to, when the caller wants a lone
   * `hook_created` to ask for the inline delta against it (`sinceCursor`).
   * The hook's awaiters are settled by the event that write commits and by
   * nothing else (a `hook_created`, or the `hook_conflict` a claimed token
   * commits instead), so the delta hands the VM that event, plus anything
   * another writer landed meanwhile, without a listing. Same gate as the node
   * engine's `hookDeltaCursor`: asked for only when exactly one hook needs
   * creating, since two creates diffing against one cursor would produce two
   * deltas of which only the first could be taken. Omitted by the terminal
   * drain.
   */
  deltaCursor?: string;
  workflowRun: WorkflowRun;
  encryptionKey: RunPayloadKeys | undefined;
  pendingOperations: PendingOperation[];
  /**
   * Step cids whose `step_created` must NOT be written here: the inline
   * loop claims these atomically via a lazy `step_started` (carrying the
   * input), so a concurrent claimant loses with EntityConflictError
   * instead of both invocations bare-starting the same step.
   */
  skipStepCreation?: Set<string>;
  /**
   * Correlation ids of the waits and attribute writes whose event this
   * invocation already committed. Neither has a row a World could refuse a
   * second create with, and the VM may not have been fed the committed event
   * yet (a write's own event is delivered off its response only for
   * `wait_completed`; see `QuickJSLogView.absorb`), so it still reports the
   * op as uncreated. Updated here with every create this dispatch commits.
   */
  writtenOpIds?: Set<string>;
  /** Queue message id of this delivery, recorded on step and wait creates. */
  creatorMessageId?: string;
  /**
   * Step cids the caller intends to hand to the queue this turn (overflow
   * steps beyond the inline cap). Eligible ones are published here, in
   * parallel with their step_created write (resilient step dispatch), and
   * reported back in `queuedStepCids`.
   */
  queueStepCids?: Set<string>;
  /** Queue namespace for all message publishes (see runtime.ts). */
  namespace: string | undefined;
  /**
   * Run-origin trace carrier accessor from runtime.ts. In the default
   * `linked` trace mode this returns the carrier of the run's ORIGIN
   * context (workflow.start), so every invocation links back to the
   * start in a star. Capturing the current context here instead would
   * chain invocations to each other and fragment the run view on async
   * queues.
   */
  nextTraceCarrier: () => Promise<Record<string, string>>;
  /**
   * When true (the inline loop), a step carrying `serializationError` is
   * finalized as step_created (placeholder input) + step_failed so the
   * live-VM feed rejects the step's promise and workflow code can catch
   * it, mirroring the node:vm engine's finalizeUnserializableStep. When
   * false (the terminal drain), such steps are skipped entirely: the run
   * is already completing/failing, no replay follows the drain to observe
   * the failure, and a completed run carrying a failed step would read as
   * a bug from the dashboard, matching the node:vm drain's behavior.
   */
  finalizeUnserializableSteps?: boolean;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<{
  createdAttributeEvent: boolean;
  createdGetConflictHook: boolean;
  /**
   * A hook create committed a `hook_conflict` instead of a `hook_created`.
   * The workflow consumes it on its next pass: the caller wakes the run if
   * the delivery could end before that.
   */
  createdHookConflict: boolean;
  /** Step cids already published via resilient dispatch. See above. */
  queuedStepCids: Set<string>;
  /**
   * Step cids finalized as failed because their input refused to
   * serialize (see `finalizeUnserializableSteps`). No execution message
   * exists for these; the caller must ensure the run observes the
   * terminal event (the inline loop's feed, or the requeue signal).
   */
  failedSerializationStepCids: Set<string>;
  /** Event ids of the `step_created` events this dispatch wrote. */
  createdStepEventIds: Map<string, string>;
  /** Serialized inputs of the steps this dispatch created. */
  createdStepInputs: Map<string, Uint8Array>;
}> {
  const {
    world,
    runId,
    workflowRun,
    encryptionKey,
    pendingOperations,
    createEvent,
  } = params;
  const skipStepCreation = params.skipStepCreation;
  const createdStepEventIds = new Map<string, string>();
  const createdStepInputs = new Map<string, Uint8Array>();
  const creatorMessageId = params.creatorMessageId;
  const wfdiag = params.wfdiag;
  // Step cids published via resilient dispatch below (create + queue in
  // parallel, message carrying `stepInput`). Reported to the caller so it
  // skips them in its own queueing pass.
  const queuedStepCids = new Set<string>();
  // Step cids finalized as step_created + step_failed because their input
  // refused to serialize. See the `finalizeUnserializableSteps` param.
  const failedSerializationStepCids = new Set<string>();
  // Resilient step dispatch eligibility, shared by every step op below (the
  // per-step input-size check is applied inside the op): feature enabled and
  // a binary-safe (CBOR) queue transport for the run.
  //
  // Unlike the node:vm suspension handler's gate (see
  // SuspensionHandlerParams.stepDispatch), there is NO precondition-guard
  // gate here: this engine's step_created writes are unguarded (no snapshot
  // is attached), so a guard-enforcing World can never 412-reject them:
  // the consumer's re-ensure therefore cannot materialize a step the guard
  // rejected. If this engine ever adopts guarded suspension writes, the
  // capability gate from the node:vm handler must be added here too.
  // Set when a hook with a parked getConflict() awaiter had its
  // hook_created written this invocation. The workflow must be re-invoked
  // so replay can confirm creation and resolve the awaiter.
  let createdGetConflictHook = false;
  // Set when a hook create committed a `hook_conflict` this invocation.
  let createdHookConflict = false;
  // Set when a new attr_set event is written this invocation. The
  // workflow must be re-invoked to consume it (resolving the pending
  // setAttributes() promise), so the entrypoint requeues immediately,
  // same pattern as an elapsed wait.
  let createdAttributeEvent = false;
  const opsPromises: Promise<void>[] = [];
  const hooksNeedingCreation = pendingOperations.filter(
    (op) => op.type === 'hook' && !op.hasCreatedEvent
  ).length;
  const hookDeltaCursor =
    hooksNeedingCreation === 1 ? params.deltaCursor : undefined;

  const processHookOp = async (hook: PendingHook): Promise<void> => {
    runtimeLogger.debug('QuickJS runtime: processing hook op', {
      workflowRunId: runId,
      correlationId: hook.correlationId,
      token: hook.token,
      tokenType: typeof hook.token,
      isWebhook: hook.isWebhook,
      isSystem: hook.isSystem,
      hasCreatedEvent: hook.hasCreatedEvent,
      abortRequested: hook.abortRequested,
    });

    if (!hook.hasCreatedEvent) {
      // `hook.metadata` is the format-prefixed devalue bytes
      // produced by `globalThis[Symbol.for('workflow-serialize')]
      // (options.metadata)` inside the VM. Encrypt on the host
      // side before writing, which matches the node:vm engine's
      // `dehydrateStepArguments` flow.
      //
      // No pre-check via hooks.list: with deterministic correlationIds
      // (same VM seed across replays) and per-(runId, correlationId)
      // uniqueness in worlds, the storage layer rejects duplicates as
      // EntityConflictError, which we swallow below. This drops one
      // network round-trip per pending hook.
      try {
        const encryptedMetadata =
          typeof hook.metadata === 'undefined'
            ? undefined
            : await encryptSerializedData(hook.metadata, encryptionKey);
        const result = await createEvent(
          {
            eventType: 'hook_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: hook.correlationId,
            eventData: {
              token: hook.token,
              tokenRetentionUntil:
                hook.tokenRetentionUntil === undefined
                  ? undefined
                  : new Date(hook.tokenRetentionUntil),
              metadata: encryptedMetadata,
              // Always include isWebhook explicitly. Worlds default it to
              // `true` when absent, which would break the public webhook
              // endpoint's 404 guard for hooks created via createHook().
              isWebhook: hook.isWebhook,
              // System hooks (AbortController) are exempt from user
              // token namespace conflict checks.
              ...(hook.isSystem ? { isSystem: true } : {}),
              ...(hook.force ? { force: true } : {}),
            } as any,
          },
          hookDeltaCursor !== undefined
            ? { sinceCursor: hookDeltaCursor }
            : undefined
        );

        // A forced creation that took the token over: wake the run it was
        // taken from so its replay reads the hook_disposed the World
        // journaled there. Same contract as the node:vm suspension handler;
        // see `publishForceClaimVictimWake`.
        if (result.hook?.claimedFrom) {
          const outcome = await publishForceClaimVictimWake(
            world,
            runId,
            result.hook
          );
          runtimeLogger.info('Hook token force-claimed from another run', {
            workflowRunId: runId,
            hookId: hook.correlationId,
            victimRunId: result.hook.claimedFrom.runId,
            victimWake: outcome,
          });
        }

        // A token conflict with another run's hook committed a
        // `hook_conflict`, which the workflow has to consume. The inline
        // loop feeds it to the live VM; the caller wakes the run only if
        // the delivery ends before that (see `createdHookConflict`).
        if (result.event?.eventType === 'hook_conflict') {
          createdHookConflict = true;
        }
      } catch (err) {
        // Already created by a concurrent invocation, so fall through
        // to abort processing below (if any) instead of bailing.
        if (!EntityConflictError.is(err)) throw err;
      }
      if (hook.hasGetConflictAwaiter) {
        createdGetConflictHook = true;
      }
    }

    if (hook.abortRequested) {
      // Record the abort durably: a hook_received event carrying
      // the VM-serialized `{ aborted: true, reason }` payload,
      // plus a best-effort stream packet for real-time step
      // propagation. Mirrors the node:vm engine's suspension
      // handler (hooksNeedingAbort).
      const abortPayload =
        hook.abortPayload instanceof Uint8Array
          ? ((await encryptSerializedData(
              hook.abortPayload,
              encryptionKey
            )) as Uint8Array)
          : undefined;
      try {
        await createEvent({
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.correlationId,
          eventData: {
            token: hook.token,
            payload: abortPayload,
          } as any,
        });
      } catch (err) {
        if (!EntityConflictError.is(err)) throw err;
      }
      // streamName is derived from the abort hook token
      // (`abrt_{id}` → `strm_{id}_system_abort`).
      if (hook.token.startsWith('abrt_') && abortPayload) {
        const streamName = `strm_${hook.token.slice('abrt_'.length)}_system_abort`;
        try {
          await world.streams.write(runId, streamName, abortPayload);
          await world.streams.close(runId, streamName);
        } catch {
          // Best-effort: the hook event provides the durable
          // fallback.
          runtimeLogger.debug(
            'QuickJS runtime: failed to write abort stream packet',
            {
              workflowRunId: runId,
              correlationId: hook.correlationId,
            }
          );
        }
      }
      wfdiag('abort_recorded', {
        correlationId: hook.correlationId,
        token: hook.token,
      });
    }
  };

  const processHookDisposeOp = async (
    op: PendingHookDispose
  ): Promise<void> => {
    try {
      await createEvent({
        eventType: 'hook_disposed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: op.correlationId,
        // The hook's token, which the node:vm engine has always sent. A world
        // that keys a hook's token claim separately from the hook itself needs
        // it to release both, and the only alternative is for it to look the
        // token up first. Omitted rather than sent as undefined when the op
        // carries none, so a world that reads it cannot tell the difference
        // between this engine and a client too old to send one.
        ...(op.token === undefined ? {} : { eventData: { token: op.token } }),
      });
    } catch (err) {
      if (EntityConflictError.is(err)) return;
      // Disposing a hook whose entity no longer (or never) exists is an
      // idempotent no-op: the entity may have been torn down by a
      // concurrent run cancellation, or the hook may have lost its
      // token claim to a conflict. There is nothing left to release.
      if (HookNotFoundError.is(err)) return;
      throw err;
    }
  };

  // Hook operations are grouped by token and processed SEQUENTIALLY in
  // code order within each group, mirroring the node:vm suspension
  // handler (hookItemsByToken): a dispose() of an earlier hook must
  // release the token before a later same-token hook's creation is
  // validated by the world: parallel dispatch would otherwise record a
  // spurious hook_conflict against the run's own disposed hook (e.g. a
  // dispose→recreate loop reusing one token). Different tokens have no
  // claim interaction, so token groups run in parallel with each other
  // and with the non-hook ops below.
  const hookOpsByToken = new Map<
    string,
    (PendingHook | PendingHookDispose)[]
  >();
  for (const op of pendingOperations) {
    let key: string | undefined;
    if (
      op.type === 'hook' &&
      (!op.hasCreatedEvent || (op as PendingHook).abortRequested)
    ) {
      key = (op as PendingHook).token;
    } else if (op.type === 'hook_dispose' && !op.hasCreatedEvent) {
      // Per-op fallback group when the token is unknown: no ordering
      // guarantees, matching the previous parallel behavior.
      key = (op as PendingHookDispose).token ?? `__cid:${op.correlationId}`;
    }
    if (key === undefined) continue;
    const group = hookOpsByToken.get(key);
    if (group) {
      group.push(op as PendingHook | PendingHookDispose);
    } else {
      hookOpsByToken.set(key, [op as PendingHook | PendingHookDispose]);
    }
  }
  const runHookGroup = async (
    group: (PendingHook | PendingHookDispose)[]
  ): Promise<void> => {
    for (const op of group) {
      if (op.type === 'hook') {
        await processHookOp(op);
      } else {
        await processHookDisposeOp(op);
      }
    }
  };
  // Token groups run in parallel with every other op, forced creations
  // included. A forced creation publishes its victim's wake before its group's
  // next write, but nothing else waits for it, and nothing needs to: a crash
  // before the wake is repaid by the next replay from the forced
  // `hook_created` itself, which `forcedCreationsOwingWake` finds wherever it
  // sits in the log, so no row written after it can hide the debt.
  for (const group of hookOpsByToken.values()) {
    opsPromises.push(runHookGroup(group));
  }

  for (const op of pendingOperations) {
    if (
      op.type === 'step' &&
      !op.hasCreatedEvent &&
      !skipStepCreation?.has(op.correlationId)
    ) {
      const step = op as PendingStep;
      opsPromises.push(
        (async () => {
          // The step's input refused to serialize while dumping the VM's
          // pending ops (see PendingStep.serializationError). Finalize it
          // as step_created (placeholder input, since the world requires the
          // step entity before a terminal event) + step_failed carrying
          // the SerializationError, so the live-VM feed rejects the
          // step's promise and workflow code can catch it. Never queue an
          // execution message for it. Mirrors the node:vm engine's
          // finalizeUnserializableStep. In the terminal drain
          // (finalizeUnserializableSteps unset), skip entirely: see the
          // param docs.
          if (step.serializationError) {
            if (!params.finalizeUnserializableSteps) {
              return;
            }
            runtimeLogger.warn(
              'Step arguments failed to serialize; failing the step so ' +
                'the workflow can observe the error',
              {
                workflowRunId: runId,
                correlationId: step.correlationId,
                stepName: step.stepId,
                error: step.serializationError.message,
              }
            );
            try {
              await createEvent({
                eventType: 'step_created',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  workflowName: workflowRun.workflowName,
                  // Inline, created by this delivery: if the step_failed
                  // below never lands, the redelivery runs the step inline,
                  // and the executor fails it from the placeholder input.
                  inline: true,
                  ...(creatorMessageId ? { creatorMessageId } : {}),
                  input: (await dehydrateStepArguments(
                    unserializableStepInputPlaceholder(),
                    runId,
                    encryptionKey,
                    globalThis,
                    false,
                    (workflowRun.specVersion ?? 0) >=
                      SPEC_VERSION_SUPPORTS_COMPRESSION
                  )) as Uint8Array,
                },
              });
            } catch (err) {
              // Concurrent invocation hit the same deterministic failure
              // and created it first, or the run already finished.
              if (RunExpiredError.is(err)) return;
              if (!EntityConflictError.is(err)) throw err;
            }
            try {
              await createEvent({
                eventType: 'step_failed',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  // Never started: this is the step's first and only attempt.
                  attempt: 1,
                  error: await dehydrateStepError(
                    step.serializationError,
                    runId,
                    encryptionKey,
                    [],
                    globalThis,
                    (workflowRun.specVersion ?? 0) >=
                      SPEC_VERSION_SUPPORTS_COMPRESSION
                  ),
                },
              });
            } catch (err) {
              // Step already terminal or run already finished.
              if (!EntityConflictError.is(err) && !RunExpiredError.is(err)) {
                throw err;
              }
            }
            failedSerializationStepCids.add(step.correlationId);
            wfdiag('step_serialization_failed', {
              stepId: step.stepId,
              correlationId: step.correlationId,
            });
            return;
          }

          // Create step_created event. `step.input` is the
          // format-prefixed devalue bytes ("devl" + devalue) produced
          // by `globalThis[Symbol.for('workflow-serialize')]({args,
          // closureVars, thisVal})` inside the VM. The VM has no
          // access to the CryptoKey, so encryption is applied here
          // on the host side, matching what
          // `dehydrateStepArguments` does in the node:vm engine.
          const encryptedInput = await encryptSerializedData(
            step.input,
            encryptionKey
          );

          try {
            const created = await createEvent({
              eventType: 'step_created',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: step.correlationId,
              eventData: {
                stepName: step.stepId,
                workflowName: workflowRun.workflowName,
                input: encryptedInput,
                inline: false,
                ...(creatorMessageId ? { creatorMessageId } : {}),
              },
            });
            if (created.event) {
              createdStepEventIds.set(
                step.correlationId,
                created.event.eventId
              );
            }
            if (encryptedInput instanceof Uint8Array) {
              createdStepInputs.set(step.correlationId, encryptedInput);
            }
          } catch (err) {
            if (EntityConflictError.is(err)) return;
            throw err;
          }

          // NOTE: step queueing is otherwise the caller's decision: the
          // inline loop executes fresh steps in the live VM and only
          // queues the overflow / retry / backstop cases (see
          // queueStepMessage).
        })()
      );
    } else if (
      op.type === 'attribute' &&
      !op.hasCreatedEvent &&
      !params.writtenOpIds?.has(op.correlationId)
    ) {
      const attr = op as PendingAttribute;
      params.writtenOpIds?.add(op.correlationId);
      opsPromises.push(
        (async () => {
          try {
            await createEvent({
              eventType: 'attr_set',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: attr.correlationId,
              eventData: {
                changes: attr.changes,
                writer: { type: 'workflow' },
                ...(attr.allowReservedAttributes
                  ? { allowReservedAttributes: true }
                  : {}),
              } as any,
            });
            createdAttributeEvent = true;
          } catch (err) {
            if (EntityConflictError.is(err)) {
              // Event already exists (concurrent invocation), but the
              // replay still needs to consume it, so requeue.
              createdAttributeEvent = true;
              return;
            }
            throw err;
          }
        })()
      );
    } else if (
      op.type === 'wait' &&
      !op.hasCreatedEvent &&
      !params.writtenOpIds?.has(op.correlationId)
    ) {
      const wait = op as PendingWait;
      params.writtenOpIds?.add(op.correlationId);
      opsPromises.push(
        (async () => {
          try {
            await createEvent({
              eventType: 'wait_created',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: wait.correlationId,
              eventData: {
                resumeAt: new Date(wait.resumeAt),
                ...(creatorMessageId ? { creatorMessageId } : {}),
              },
            });
          } catch (err) {
            if (EntityConflictError.is(err)) return;
            throw err;
          }
        })()
      );
    }
  }

  // Per-op dispatch runs in parallel.
  await Promise.all(opsPromises);

  return {
    createdAttributeEvent,
    createdGetConflictHook,
    createdHookConflict,
    queuedStepCids,
    failedSerializationStepCids,
    createdStepEventIds,
    createdStepInputs,
  };
}

/**
 * Run a workflow using the QuickJS WASM VM engine.
 *
 * This replaces the `node:vm` replay path (runWorkflow + EventsConsumer)
 * with a QuickJS VM invocation that performs the same full event replay.
 *
 * Log position on writes. This engine follows the same rule as the node:vm
 * replay loop for which writes tell the World where the writer stood (see the
 * "Who names a position" table above `slotSnapshotParams` in `helpers.ts`):
 *
 * - Writes made from this invocation's view of the log (`step_created`,
 *   `wait_created`, `hook_created`, `hook_disposed`, `attr_set`, the abort
 *   `hook_received`, `wait_completed`, and the `step_created` + `step_failed`
 *   pair for an unserializable input) carry `eventCount`, and the page a
 *   World hands back is queued for the live VM through {@link QuickJSLogView}.
 * - A single inline step's terminal write asks for the inline delta
 *   (`sinceCursor`) through `executeStep`, and so does a lone `hook_created`
 *   (see `dispatchPendingOps.deltaCursor`); the delta is queued the same
 *   way. The step executor's other writes carry nothing: it holds no log.
 * - Run-terminal writes (`run_completed`, `run_failed`) and the terminal drain
 *   of pending ops carry nothing: nothing reads the log afterwards.
 *
 * What differs from the node engine is what "merge into the log" means. The
 * node engine merges a returned page into the array it replays from. This
 * engine holds a live VM that consumes events exactly once, in position
 * order, so a returned page is queued and delivered ahead of the next
 * `events.list`, which then only runs when the queue cannot account for the
 * next position. Both engines fall back to a list for anything a page did
 * not carry.
 */
/**
 * Read a run's event log in order from `cursor` (the start when `null`) to
 * its end. Returns the events, the cursor after the last page (`cursor` when
 * nothing new was read), and how many pages it took.
 */
async function listRunLogFrom(
  world: Awaited<ReturnType<typeof getWorld>>,
  runId: string,
  cursor: string | null
): Promise<{
  events: Event[];
  cursor: string | null;
  pages: number;
  /** Whether every returned event is covered by the returned cursor. */
  covered: boolean;
}> {
  const events: Event[] = [];
  let pages = 0;
  let covered = true;
  let hasMore = true;
  while (hasMore) {
    const response = await world.events.list({
      runId,
      pagination: {
        sortOrder: 'asc',
        cursor: cursor ?? undefined,
        limit: 1000,
      },
      resolveData: REPLAY_RESOLVE_DATA,
    });
    pages++;
    events.push(...response.data);
    // Only move on a page that returned a cursor: the final empty page
    // returns `null`, which would reset the read position.
    if (response.cursor) {
      cursor = response.cursor;
    } else if (response.data.length > 0) {
      covered = false;
    }
    hasMore = response.data.length > 0 && response.cursor != null;
  }
  return { events, cursor, pages, covered };
}

const snapshotWarnings = globalSingleton(
  '@workflow/core//quickjsSnapshotWarnings',
  1,
  () => new Set<string>()
);

/** Log a snapshot-configuration warning once per process per key. */
function warnOnce(key: string, log: () => void): void {
  if (snapshotWarnings.has(key)) return;
  snapshotWarnings.add(key);
  log();
}

export async function runWorkflowWithQuickJS(params: {
  workflowCode: string;
  workflowName: string;
  workflowRun: WorkflowRun;
  /**
   * Events returned inline by `events.create('run_started', ...)` or by
   * the lazy hook fast path's `hook_received` preload. When they indicate
   * a first invocation, or when `preloadedEventsComplete` attests they
   * are the complete log, they are used as the event log instead of
   * fetching via `events.list`, matching the node:vm engine's fast path.
   */
  preloadedEvents?: Event[];
  /**
   * True when the caller has validated that `preloadedEvents` is the run's
   * COMPLETE event log (e.g. the lazy hook fast path's hasMore-false
   * replay preload). The first-invocation heuristic below only recognizes
   * run_created/run_started-only preloads, so without this attestation a
   * hook-resume preload would be discarded and refetched.
   */
  preloadedEventsComplete?: boolean;
  /**
   * The `events.list` cursor positioned after the last of `preloadedEvents`,
   * when the caller has one. Lets this invocation read incrementally from
   * where the preload ended and ask for an inline delta against it. Without
   * it the first read after the preload starts from the top of the log.
   */
  preloadedCursor?: string | null;
  /**
   * Run input carried through the queue message on first delivery. Used
   * as a last-resort fallback for `run_created.eventData.input` when
   * the event log is incomplete.
   */
  runInput?: RunInput;
  /**
   * The parent OTel span (the outer `WORKFLOW {workflowName}` span from
   * `runtime.ts`). When supplied, VM lifecycle attributes are attached
   * to it for end-to-end visibility.
   */
  parentSpan?: Span;
  /**
   * Server-supplied per-run event ceiling from the run_started response
   * (undefined ⇒ no enforcement). Mirrors the node:vm engine's guard:
   * a runaway run is failed once its log reaches the ceiling. The throw
   * propagates to the replay loop's catch in runtime.ts (the QuickJS
   * dispatch runs inside that loop's try), which classifies it and
   * records run_failed with MAX_EVENTS_EXCEEDED.
   */
  maxEventsLimit?: number;
  /**
   * Queue delivery attempt of the message driving this invocation (from
   * the queue handler's metadata; 1 = first delivery). Surfaced in
   * diagnostics; crash recovery itself is driven by the ownership-lease
   * decision table in the loop, not by the attempt count.
   */
  deliveryAttempt?: number;
  /**
   * Epoch ms past which a delivery with nothing left to run does not linger
   * for work done elsewhere (see `getOrchestratorLingerMs`): the invocation's
   * inline deadline. Absent: no lingering.
   */
  lingerDeadlineMs?: number;
  /**
   * Queue message ID of the delivery driving this invocation, stamped as
   * `ownerMessageId` on inline lazy step claims so wake replays defer to
   * the in-flight body instead of requeueing the step.
   */
  ownerMessageId?: string;
  /** Request ID of the queue invocation, when the queue provides one. */
  requestId?: string;
  /**
   * The orchestrator's in-band writer. Every event this engine writes goes
   * through it, so the writes are marked in-band and fenced.
   */
  writer?: InBandWriter;
  /**
   * Queue namespace resolved at route registration (runtime.ts). Must be
   * threaded into every message publish: the builders bake the namespace
   * into generated routes, so consumers listen on `__<ns>_wkf_workflow_*`.
   * A publish without it lands on `__wkf_workflow_*` and is never
   * picked up.
   */
  namespace?: string;
  /**
   * Run-origin trace carrier accessor from runtime.ts
   * (getNextTraceCarrier). In the default `linked` trace mode every
   * invocation must link back to the run's origin (workflow.start) in a
   * star; capturing the current invocation context instead would chain
   * invocations to each other and fragment the run view on async queues.
   */
  nextTraceCarrier?: () => Promise<Record<string, string>>;
  /**
   * The wait this invocation is the delayed continuation for, if it is one
   * (`WorkflowInvokePayload.waitContinuation`). Read only to decide the next
   * continuation's idempotency key: a continuation that finds its own wait
   * still pending has spent its key, so the re-arm has to advance the attempt
   * or the world's dedupe window drops it and the wait loses its only timer.
   */
  waitContinuation?: { correlationId: string; attempt: number };
  /**
   * Turbo mode (the run's first delivery, see `isTurboEnabled`): the caller
   * wrote `run_started` without waiting for it and did not load the log, which
   * holds only the run's creation. The VM starts on an empty log, no snapshot
   * is looked up, and while `optimistic` holds, inline step bodies start
   * before their `step_created`/`step_started` commit, until a suspension has
   * an operation other than a step.
   */
  /**
   * Waits a `run.wakeUp()` asked this delivery to complete whatever their
   * `resumeAt` (`WorkflowInvokePayload.completeWaits`).
   */
  wakeUpWaits?: ReadonlySet<string>;
  turbo?: {
    /** The backgrounded `run_started`, folded into the log view on landing. */
    runStarted: Promise<EventResult>;
    /** Settles once `run_started` landed; rejects if it failed. */
    runReadyBarrier: Promise<void>;
    /** Whether inline bodies may start ahead of their start. */
    optimistic: boolean;
  };
}): Promise<{ timeoutSeconds?: number } | void> {
  const {
    workflowCode,
    workflowName,
    workflowRun,
    preloadedEvents,
    preloadedEventsComplete,
    preloadedCursor,
    runInput,
    parentSpan,
    maxEventsLimit,
    deliveryAttempt,
    ownerMessageId,
    requestId,
    namespace,
    waitContinuation,
    turbo,
  } = params;

  /**
   * Attempt number for the continuation this invocation is about to arm for
   * `correlationId`. One higher than the incoming continuation's when this
   * invocation IS that continuation and the wait is still pending — the only
   * situation in which the previous key is spent. Every other caller, and
   * every other wait, starts at 0 and keys exactly as it did before attempts
   * existed.
   */
  const nextWaitContinuationAttempt = (correlationId: string): number =>
    waitContinuation?.correlationId === correlationId
      ? waitContinuation.attempt + 1
      : 0;
  /**
   * Whether this delivery arms the timer of the wait `correlationId`: only
   * the delivery whose message wrote its `wait_created`, a redelivery of
   * that message, or the wait's own timer delivery (see
   * `schedulesWaitTimer`). Other deliveries leave the timer to them, so
   * timer messages do not pile up across suspensions. Assigned once the
   * log is loaded.
   */
  let armsWaitTimer: (correlationId: string) => boolean = () => true;
  /** A timer wake: delayed, and carrying no idempotency key. */
  const queueWaitTimer = async (
    correlationId: string,
    seconds: number
  ): Promise<void> => {
    const attempt = nextWaitContinuationAttempt(correlationId);
    const { delaySeconds } = getWaitContinuationDispatch(
      seconds,
      correlationId,
      Date.now(),
      attempt
    );
    await queueMessage(
      world,
      getWorkflowQueueName(workflowRun.workflowName, namespace),
      {
        runId,
        traceCarrier: await nextTraceCarrier(),
        requestedAt: new Date(),
        waitContinuation: { correlationId, attempt },
      },
      { delaySeconds }
    );
  };
  // Standalone-caller fallback (tests): without a runtime.ts carrier
  // accessor, fall back to the current invocation context.
  const nextTraceCarrier =
    params.nextTraceCarrier ?? (() => serializeTraceCarrier());
  const world = await getWorld();
  const runId = workflowRun.runId;
  const invocationStart = tick();

  // Strip the inline source map comment before evaluating the bundle in
  // the QuickJS VM. The map is purely host-side metadata for
  // `remapErrorStack` (called below on workflow failures, against the
  // ORIGINAL `workflowCode`). QuickJS retains source text for
  // stack-trace line lookups, so the few-MB base64 comment would bloat
  // the VM heap for no benefit.
  const workflowCodeForVM = stripInlineSourceMap(workflowCode);

  // Per-invocation diagnostic id so debug logs can be correlated even if
  // the same runId is processed by overlapping invocations on different
  // function instances.
  const invocationId = `inv_${Math.random().toString(36).slice(2, 10)}`;

  // Structured per-checkpoint diagnostic helper, grep-friendly by runId.
  const wfdiag = (checkpoint: string, fields: Record<string, unknown>) => {
    try {
      runtimeLogger.debug('QUICKJS_VM_DIAG', {
        checkpoint,
        runId,
        invocationId,
        tElapsedMs: Math.round(tick() - invocationStart),
        ...fields,
      });
    } catch {
      // Diagnostics must not interrupt execution or suppress lifecycle hooks
      // after a terminal event has already been persisted.
    }
  };

  parentSpan?.setAttributes({
    ...Attribute.WorkflowVm('quickjs'),
  });

  wfdiag('enter', {
    workflowName,
    deliveryAttempt,
    hasPreloadedEvents:
      Array.isArray(preloadedEvents) && preloadedEvents.length > 0,
    preloadedEventCount: preloadedEvents?.length ?? 0,
    hasRunInput: !!runInput,
  });

  // The workflowName from the queue topic is already the full workflow ID
  // (e.g. "workflow//./workflows/1_simple//simple")
  const workflowId = workflowName;

  // Resolve the encryption key up front: needed to decrypt event
  // payloads inside the VM and to encrypt event payloads written below.
  // Resolve the FULL capability (symmetric AES key + X25519 keypair), not
  // just `importKey(rawKey)`: a run reading its own event log can encounter
  // sealed (`encp`) hook payloads that a cross-deployment `resumeHook()`
  // wrote to it (sealing is presence-gated on the run's published
  // encryptionPublicKey, which the shared start() path stamps regardless of
  // engine). A bare symmetric key cannot open those and would wedge the run
  // right after hook_received. The node:vm engine resolves the same full
  // capability via memoizeEncryptionKey.
  const rawKey = await world.getEncryptionKeyForRun?.(workflowRun);
  const encryptionKey = rawKey ? await deriveRunPayloadKeys(rawKey) : undefined;

  // VM-memory snapshotting policy for this run. 0 = disabled (pure
  // replay). Enabled by default (DEFAULT_QUICKJS_SNAPSHOT_THRESHOLD);
  // WORKFLOW_SNAPSHOT_THRESHOLD=0 opts out. When enabled, suspensions persist a snapshot once at least
  // `snapshotThreshold` events have been processed since the last one,
  // and resumptions restore the VM and replay only the delta events.
  //
  // Forced to 0 (pure full replay, always correct) when:
  // - the World doesn't provide `experimental_snapshots` (optional);
  // - the run has no encryption key and the handler hasn't opted in with
  //   WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED. A snapshot is executable VM
  //   state holding the run's in-memory data; the key is what keeps it
  //   confidential at rest and authenticates it on restore.
  // An invalid policy value disables snapshotting with a warning rather
  // than failing every invocation (see getSnapshotThresholdForHandler).
  const snapshotsStorage = world.experimental_snapshots;
  let snapshotThreshold = snapshotsStorage
    ? getSnapshotThresholdForHandler(workflowRun, (message) =>
        warnOnce(`snapshot-threshold:${message}`, () =>
          runtimeLogger.warn(
            'QuickJS runtime: invalid snapshot threshold, snapshotting disabled',
            { workflowRunId: runId, message }
          )
        )
      )
    : 0;
  // The configured policy, before the encryption gate below: terminal
  // cleanup keys on it, so snapshots saved while the gate was open are
  // still deleted after it closes.
  const snapshotPolicyThreshold = snapshotThreshold;
  if (
    snapshotThreshold > 0 &&
    !encryptionKey &&
    !isUnencryptedSnapshottingAllowed()
  ) {
    // Only warn when snapshotting was explicitly configured: with the
    // default threshold, worlds without run encryption keys (world-local,
    // world-postgres) would otherwise warn on every QuickJS deployment.
    if (isSnapshotThresholdConfigured(workflowRun)) {
      warnOnce('snapshot-unencrypted', () =>
        runtimeLogger.warn(
          'QuickJS runtime: VM snapshotting is configured but this run has no encryption key; ' +
            'snapshots are disabled. Set WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED=1 to store them unencrypted.',
          { workflowRunId: runId }
        )
      );
    }
    snapshotThreshold = 0;
  }

  // Try to load a persisted snapshot. Skipped on the first invocation
  // (nothing can have been saved yet) and on any load/decode failure —
  // the fresh-boot full replay below is always a correct fallback (the
  // event log remains the source of truth; snapshots are an optimization).
  let existingSnapshot: {
    data: Uint8Array;
    metadata: SnapshotMetadata;
  } | null = null;
  // Why a stored snapshot was not restored, for the invocation span.
  let snapshotFallbackReason: string | undefined;
  // Whether a snapshot for this run may exist in storage: one was found
  // (usable or not) or this invocation saves one. The terminal paths delete
  // whenever this is set, or the log has reached the threshold (see
  // scheduleSnapshotDelete).
  let snapshotStored = false;
  const snapshotLoadStart = tick();
  // A complete preloaded log shorter than the threshold, or this process
  // having just seen the run below it, means no snapshot can exist yet
  // (see runsBelowSnapshotThreshold): skip the guaranteed-miss probe.
  const preloadBelowThreshold =
    preloadedEventsComplete === true &&
    Array.isArray(preloadedEvents) &&
    preloadedEvents.length < snapshotThreshold;
  if (
    snapshotsStorage &&
    snapshotThreshold > 0 &&
    !turbo &&
    !isFirstInvocation(preloadedEvents) &&
    !preloadBelowThreshold &&
    !runsBelowSnapshotThreshold.has(runId)
  ) {
    try {
      const loaded = await snapshotsStorage.load(runId);
      if (loaded) {
        const version = loaded.metadata.formatVersion;
        const outOfBounds = checkSnapshotMetadataBounds(loaded.metadata);
        if (
          version !== SNAPSHOT_FORMAT_VERSION ||
          loaded.metadata.rngDraws === undefined ||
          loaded.metadata.serdeRootPtr === undefined ||
          loaded.metadata.engineVersion !== quickjsWasiVersion
        ) {
          // Unknown/older format (v1 predates the host-side serde and
          // ULID engine, v2 predates the sealed metadata frame), a
          // snapshot without the PRNG draw count (restoring would reset id
          // generation to the base seed and collide with pre-snapshot
          // correlation ids), one without the serde capture-root token
          // (the host serde cannot be rebuilt without executing guest
          // code after user code has run), or one captured by a
          // DIFFERENT quickjs-wasi build (the QJSS heap-image header is
          // identical across builds, so a cross-build restore would pass
          // deserialization and execute as undefined behavior — a live
          // hazard mid-rollout when a deploy bumps quickjs-wasi).
          snapshotFallbackReason = 'format_mismatch';
          runtimeLogger.warn(
            'QuickJS runtime: snapshot format/engine mismatch, falling back to full replay',
            {
              workflowRunId: runId,
              snapshotVersion: version,
              expectedVersion: SNAPSHOT_FORMAT_VERSION,
              snapshotEngine: loaded.metadata.engineVersion,
              expectedEngine: quickjsWasiVersion,
            }
          );
        } else if (outOfBounds) {
          snapshotFallbackReason = 'out_of_bounds';
          runtimeLogger.warn(
            'QuickJS runtime: snapshot metadata out of bounds, falling back to full replay',
            { workflowRunId: runId, message: outOfBounds }
          );
        } else {
          existingSnapshot = {
            data: await openSnapshot({
              runId,
              stored: loaded.data,
              metadata: loaded.metadata,
              encryptionKey,
            }),
            metadata: loaded.metadata,
          };
        }
        // A snapshot exists in storage whether or not it was usable; the
        // terminal paths must delete it either way.
        snapshotStored = true;
      }
    } catch (err) {
      snapshotFallbackReason =
        err instanceof SnapshotRejectedError ? err.reason : 'load_failed';
      runtimeLogger.warn(
        'QuickJS runtime: snapshot load failed, falling back to full replay',
        {
          workflowRunId: runId,
          reason: snapshotFallbackReason,
          message: (err as Error)?.message,
        }
      );
    }
  }
  const snapshotRestoreMs = Math.round(tick() - snapshotLoadStart);
  wfdiag('snapshot_load', {
    threshold: snapshotThreshold,
    restored: !!existingSnapshot,
    eventsCursor: existingSnapshot?.metadata.eventsCursor ?? null,
  });

  // Load the event log. With a restored snapshot only the delta after
  // its cursor is needed — preloads (which are full logs without a
  // cursor) are ignored on that path. Otherwise load the FULL log — on
  // first invocation the preloaded events from the run_started response
  // are the complete log and save the events.list round-trips; a
  // caller-attested complete preload (lazy hook fast path) is trusted
  // the same way. Preload is used even with snapshotting enabled: without
  // a preload cursor, a qualifying suspension before the first listing
  // skips its snapshot save (a save needs an exact log position) and a
  // later one snapshots normally. Short-lived runs keep the zero-overhead
  // fast path either way.
  let events: Event[];
  let eventsFetchedPages = 0;
  // Where a restored snapshot's log position ends: the read below starts
  // after it.
  const snapshotCursor: string | null =
    existingSnapshot?.metadata.eventsCursor ?? null;
  let loadedCovered = true;
  // Where the log was read to: the cursor after the last page below, or the
  // one the caller read the preload to. Seeds the incremental reads and the
  // inline-delta requests that follow.
  let loadedCursor: string | null = null;
  const usePreloaded =
    !existingSnapshot &&
    // Turbo: the log holds only the run's creation, and nothing was loaded.
    (turbo !== undefined ||
      (preloadedEventsComplete === true &&
        Array.isArray(preloadedEvents) &&
        preloadedEvents.length > 0) ||
      isFirstInvocation(preloadedEvents));
  if (usePreloaded) {
    events = preloadedEvents ?? [];
    loadedCursor = preloadedCursor ?? null;
  } else {
    const read = await listRunLogFrom(world, runId, snapshotCursor);
    eventsFetchedPages += read.pages;
    events = read.events;
    loadedCursor = read.cursor;
    loadedCovered = read.covered;
  }

  // This invocation's view of the log, and the queue of events a World has
  // handed back on a write that the VM has not been given yet. Every write
  // made from this view goes through `createEvent` below so it names the
  // position it was decided against and its response is queued here.
  // Same durability contract as the node:vm suspension handler: every
  // recent forced hook creation in the log may still owe its victim a wake,
  // because the invocation that created it may have died before publishing
  // one, so it is republished under the hook's idempotency key (see
  // `forcedCreationsOwingWake`). Once per invocation, on the log as loaded;
  // the forced creations this invocation makes publish their own.
  await republishOwedForceClaimVictimWakes(world, runId, events);

  // How many events `loadedCursor` covers: the snapshot's count plus
  // everything read after its cursor, or the whole preload (which starts at
  // the top of the log).
  const loadedPosition = !loadedCovered
    ? undefined
    : usePreloaded
      ? events.length
      : (existingSnapshot?.metadata.eventCount ?? 0) + events.length;
  const logView = new QuickJSLogView(events, loadedCursor, loadedPosition);
  // Turbo: the backgrounded `run_started` is noted like any write of this
  // invocation, and its skipped-slot report (`run_created`) is queued for
  // the VM.
  void turbo?.runStarted.then(
    (result) => {
      logView.absorb(result, { deliverEvent: deliversOwnEvent('run_started') });
    },
    () => {}
  );
  /**
   * Turbo: whether inline bodies still start ahead of their start. Ends for
   * the rest of the delivery at the first suspension with a hook or a wait,
   * as on the node engine.
   */
  let turboOptimistic = turbo?.optimistic === true;
  armsWaitTimer = (correlationId) =>
    ownerMessageId === undefined ||
    schedulesWaitTimer({
      wait: events.find(
        (event) =>
          event.eventType === 'wait_created' &&
          event.correlationId === correlationId
      ),
      correlationId,
      messageId: ownerMessageId,
      timerFor: waitContinuation?.correlationId,
    });
  const writeEvent: EventCreator = (data, eventParams) =>
    params.writer
      ? params.writer.create(data, eventParams)
      : world.events.create(runId, data, eventParams);
  /**
   * Whether a write's own event is delivered to the VM off its response:
   * `wait_completed` (nothing in it for a VM to resolve), and the run's
   * start, step and hook events when they go through the in-band writer. An
   * inline step then costs no listing: its creation, start and outcome reach
   * the VM from the writes that made them, in position order behind whatever
   * their reports carry, so the VM still consumes its own outcome only after
   * it committed. A hook's creation reaches the VM the same way, so a pass
   * the live feed wakes before any listing sees the hook as created and does
   * not write its `hook_created` a second time (which a World with the token
   * already taken answers with a `hook_conflict`).
   */
  const deliversOwnEvent = (eventType: string): boolean =>
    eventType === 'wait_completed' ||
    (params.writer !== undefined &&
      (eventType === 'run_started' ||
        eventType.startsWith('step_') ||
        eventType.startsWith('hook_')));
  const createEvent: EventCreator = async (data, eventParams) => {
    const result = await writeEvent(data, {
      // Returned replay events only feed the log; read them the way replay
      // reads the log.
      resolveData: REPLAY_RESOLVE_DATA,
      ...eventParams,
      ...logView.snapshotParams(),
    });
    if (
      typeof eventParams?.sinceCursor === 'string' &&
      result.events !== undefined
    ) {
      // The write asked for the inline delta and got one: everything after
      // the cursor, this write included, read with refs resolved. Taken
      // through the delta path so the cursor moves with it when that is
      // safe; the created event's position is noted either way.
      logView.absorb({ event: result.event });
      const advanced = logView.absorbDelta(eventParams.sinceCursor, {
        events: result.events,
        cursor: result.cursor ?? null,
        hasMore: result.hasMore ?? false,
      });
      wfdiag('inline_delta_absorbed', {
        eventType: data.eventType,
        events: result.events.length,
        hasMore: result.hasMore ?? false,
        cursorAdvanced: advanced,
      });
      return result;
    }
    // The created event is delivered off the response only when it carries
    // no payload a VM reads, or when it went through the in-band writer,
    // which hands back a fresh write's event with the payload it sent (see
    // `withWrittenEventData`). Every other write waits for a page or a
    // listing, which return it with its refs resolved. See QuickJSLogView.
    const absorbed = logView.absorb(result, {
      deliverEvent: deliversOwnEvent(data.eventType),
    });
    if (absorbed.truncated) {
      runtimeLogger.debug(
        'QuickJS runtime: dropped a truncated skipped-slot report',
        {
          workflowRunId: runId,
          eventType: data.eventType,
          eventId: result.event?.eventId,
          offered: result.events?.length ?? 0,
        }
      );
    }
    return result;
  };
  /**
   * The create for writes that end the run (`run_completed`, `run_failed`,
   * and the terminal drain of leftover ops): no position named and no page
   * asked for, because nothing replays a finished run's log. The node
   * engine's `deltaRequestCursor` makes the same exclusion for `sinceCursor`.
   */
  const terminalCreateEvent: EventCreator = (data, eventParams) =>
    writeEvent(data, eventParams);

  // Event-limit guard: fail a runaway run once its log reaches the
  // server-supplied ceiling. With a restored snapshot `events` is only
  // the delta after the snapshot cursor, so the guard compares the TOTAL
  // (pre-snapshot count persisted in the metadata + delta) — otherwise a
  // run that keeps snapshotting would never accumulate enough delta to
  // trip the ceiling it exists to enforce.
  //
  // `let`, not `const`: the restore-failure fallback below refetches the
  // FULL log, and from that point `events`/`seenEventIds` cover the
  // whole run — keeping the pre-snapshot count would double-count every
  // pre-snapshot event against the ceiling (tripping
  // MaxEventsExceededError below the real limit) and stamp the inflated
  // total into the next save's `eventCount`, compounding.
  let restoredEventCount = existingSnapshot?.metadata.eventCount ?? 0;
  if (
    maxEventsLimit !== undefined &&
    restoredEventCount + events.length >= maxEventsLimit
  ) {
    throw new MaxEventsExceededError(
      restoredEventCount + events.length,
      maxEventsLimit
    );
  }

  parentSpan?.setAttributes({
    ...Attribute.QuickJSEventsPreloaded(usePreloaded),
    ...Attribute.QuickJSEventsFetchedCount(events.length),
    ...Attribute.QuickJSEventsFetchedPages(eventsFetchedPages),
  });

  wfdiag('events_fetched', {
    eventCount: events.length,
    eventsFetchedPages,
    usePreloaded,
    eventTypes: events.reduce<Record<string, number>>((acc, e) => {
      acc[e.eventType] = (acc[e.eventType] ?? 0) + 1;
      return acc;
    }, {}),
  });

  // Check for elapsed waits
  const now = Date.now();
  const completedWaitIds = new Set(
    events
      .filter((e) => e.eventType === 'wait_completed')
      .map((e) => e.correlationId)
  );
  for (const event of events) {
    if (
      event.eventType === 'wait_created' &&
      event.correlationId &&
      !completedWaitIds.has(event.correlationId)
    ) {
      const eventData =
        'eventData' in event
          ? (event.eventData as Record<string, unknown>)
          : undefined;
      const resumeAt = eventData?.resumeAt;
      if (
        resumeAt &&
        (now >= new Date(resumeAt as string).getTime() ||
          params.wakeUpWaits?.has(event.correlationId))
      ) {
        try {
          const result = await createEvent({
            eventType: 'wait_completed',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: event.correlationId,
            eventData: { resumeAt: new Date(resumeAt as string) },
          });
          if (!logView.tracking && result.event) {
            // No positions to order by (see QuickJSLogView), so the event
            // joins the initial log directly, as it always has.
            events.push(result.event);
          }
        } catch (err) {
          if (EntityConflictError.is(err)) continue;
          throw err;
        }
      }
    }
  }
  // The VM has not started, so whatever those writes handed back (each
  // wait_completed, plus anything another writer appended that they skipped
  // over) joins the initial log instead of waiting for a feed.
  events.push(...logView.takeContiguous());

  // Resolve the workflow server port so `getWorkflowMetadata().url` inside
  // the VM matches what the step-side handler reports. Skipped on Vercel:
  // the VM reads VERCEL_URL directly in that environment.
  const isVercel = process.env.VERCEL_URL !== undefined;
  const port = isVercel ? undefined : await getPortLazy();

  // Run the workflow in the QuickJS VM
  runtimeLogger.debug('QuickJS runtime: invoking VM', {
    workflowRunId: runId,
    workflowId,
    eventCount: events.length,
  });

  let session: Awaited<ReturnType<typeof startQuickJSWorkflow>>;
  try {
    session = await startQuickJSWorkflow({
      // Pass the STRIPPED bundle to the VM so the inline source map
      // doesn't end up in the QuickJS heap. The original (unstripped)
      // `workflowCode` is still kept in this host-side scope and is used
      // by `remapErrorStack` on workflow failures below.
      workflowCode: workflowCodeForVM,
      workflowId,
      workflowRun,
      events,
      existingSnapshot,
      worldCapabilities: world.capabilities,
      encryptionKey,
      port,
      runInput,
    });
  } catch (err) {
    if (!existingSnapshot) throw err;
    // Snapshot restore failed (corrupt bytes, incompatible quickjs-wasi
    // build across a redeploy without version-skew protection, ...).
    // Fall back to a fresh boot + full event replay — always correct,
    // since the event log is the source of truth.
    runtimeLogger.warn(
      'QuickJS runtime: snapshot restore failed, falling back to full replay',
      { workflowRunId: runId, message: (err as Error)?.message }
    );
    wfdiag('snapshot_restore_failed', { message: (err as Error)?.message });
    snapshotFallbackReason = 'restore_failed';
    // `snapshotStored` stays set: the unusable snapshot is still in
    // storage, and the terminal paths must delete it.
    existingSnapshot = null;
    // The refetched log below is the WHOLE run — the pre-snapshot count
    // no longer describes anything not already in events/seenEventIds.
    restoredEventCount = 0;
    // Refetch the FULL log (the earlier fetch started at the snapshot's
    // cursor), and tell the log view the VM is now fed all of it.
    const read = await listRunLogFrom(world, runId, null);
    eventsFetchedPages += read.pages;
    events = read.events;
    logView.markFed(events);
    if (read.covered) logView.setPosition(read.cursor, events.length);
    else logView.advanceCursor(read.cursor);
    session = await startQuickJSWorkflow({
      workflowCode: workflowCodeForVM,
      workflowId,
      workflowRun,
      events,
      worldCapabilities: world.capabilities,
      encryptionKey,
      port,
      runInput,
    });
  }
  let result = session.result;

  if (existingSnapshot) {
    runtimeLogger.info('QuickJS runtime: restored VM snapshot', {
      workflowRunId: runId,
      deltaEvents: events.length,
      restoreMs: snapshotRestoreMs,
    });
  }
  if (snapshotThreshold > 0) {
    parentSpan?.setAttributes({
      ...Attribute.QuickJSSnapshotRestored(!!existingSnapshot),
      ...(existingSnapshot
        ? {
            ...Attribute.QuickJSSnapshotDeltaEvents(events.length),
            ...Attribute.QuickJSSnapshotRestoreMs(snapshotRestoreMs),
          }
        : {}),
      ...(snapshotFallbackReason
        ? Attribute.QuickJSSnapshotFallbackReason(snapshotFallbackReason)
        : {}),
    });
  }

  runtimeLogger.debug('QuickJS runtime: VM returned', {
    workflowRunId: runId,
    completed: !!result.completed,
    suspended: !!result.suspended,
    failed: !!result.failed,
    pendingOpsCount: result.suspended?.pendingOperations?.length,
  });

  wfdiag('vm_returned', {
    outcome: result.completed
      ? 'completed'
      : result.suspended
        ? 'suspended'
        : result.failed
          ? 'failed'
          : 'unknown',
    pendingOpsCount: result.suspended?.pendingOperations?.length ?? 0,
    pendingOpSummary: result.suspended?.pendingOperations?.map((p) => ({
      type: p.type,
      correlationId: p.correlationId,
      hasCreatedEvent: p.hasCreatedEvent,
      ...(p.type === 'step' ? { stepId: (p as PendingStep).stepId } : {}),
    })),
    failureMessage: result.failed?.message,
    failureName: result.failed?.name,
  });

  // ---- Inline continuation loop ----
  //
  // While the workflow is suspended, this loop keeps the VM alive and
  // makes as much forward progress as possible within one invocation:
  //
  //   1. Dispatch durable side effects for the suspension's pending ops
  //      (step_created / hook_created / attr_set / wait_created /
  //      hook_received for aborts) and complete elapsed waits.
  //   2. Feed all newly recorded events (attr_set, hook_created, elapsed
  //      wait_completed, terminals written by concurrent invocations, ...)
  //      into the LIVE VM via session.continueWithEvents, resuming
  //      execution exactly where it left off, no fresh-VM re-replay.
  //      Cheap progress is fed BEFORE running step bodies so promise
  //      chains that are not gated on steps (hook.getConflict(),
  //      setAttributes(), racing sleeps) advance first and can surface
  //      additional pending steps for the same inline batch.
  //   3. Once no cheap progress remains, execute up to
  //      getMaxInlineSteps() steps created by THIS invocation inline (no
  //      queue round-trip), in parallel, with the replay budget paused
  //      during step bodies, mirroring the node:vm engine's inline
  //      replay loop. Overflow and retry/throttled steps are queued for
  //      background execution. A delayed wait-continuation message is
  //      enqueued for the soonest pending wait first, so racing timers
  //      fire on time (in a separate invocation) while step bodies block
  //      this one.
  //
  // The loop exits when the workflow settles, no forward progress is
  // possible in-process, the replay budget is exhausted, or the run is
  // gone.
  const seenEventIds = new Set<string>();
  for (const e of events) {
    if (e.eventId) seenEventIds.add(e.eventId);
  }
  // Events processed since the restored snapshot (or since run start when
  // booting fresh) — compared against snapshotThreshold at suspension
  // exit to decide whether to persist a new snapshot.
  let eventsProcessedSinceSnapshot = events.length;
  // Step cids already executed inline by this invocation.
  const executedStepIds = new Set<string>();
  // Waits and attribute writes this invocation committed (see
  // `dispatchPendingOps.writtenOpIds`).
  const writtenOpIds = new Set<string>();
  // Step cids whose `step_created` this invocation wrote on the inline path.
  // The VM only learns of those events from a later listing, so until then
  // its pending op still reads as uncreated; dispatch must not write the
  // event a second time.
  const inlineCreatedStepIds = new Set<string>();
  // Steps for which THIS invocation already sent a queue message.
  const queuedStepIds = new Set<string>();
  // Aborts THIS invocation already recorded (hook_received written).
  // Guards against re-recording when the VM-side flag has not been
  // cleared yet within the same iteration.
  const recordedAbortIds = new Set<string>();
  // Waits for which THIS invocation already completed/scheduled work.
  const completedWaitIds2 = new Set<string>();
  // Inline-ownership state per step correlationId, derived from every
  // event this invocation observes (initial log + every feed): the
  // quickjs analog of the replay-derived ownership on the node engine's
  // StepInvocationQueueItem (see step-ownership.ts). Latest-wins:
  // events arrive in log order, so a later step_started overwrites the
  // stamp; a step_retrying lapses ownership permanently for the id.
  const stepOwnership = new Map<
    string,
    { owner?: string; startedAtMs?: number; sawRetrying: boolean }
  >();
  const observeEventsForOwnership = (observed: Event[]): void => {
    for (const e of observed) {
      if (e.correlationId === undefined) continue;
      if (e.eventType === 'step_started') {
        const owner =
          'eventData' in e &&
          e.eventData &&
          'ownerMessageId' in e.eventData &&
          typeof e.eventData.ownerMessageId === 'string'
            ? e.eventData.ownerMessageId
            : undefined;
        const prior = stepOwnership.get(e.correlationId);
        stepOwnership.set(e.correlationId, {
          owner,
          startedAtMs: e.createdAt ? +new Date(e.createdAt) : undefined,
          sawRetrying: prior?.sawRetrying ?? false,
        });
      } else if (e.eventType === 'step_retrying') {
        const prior = stepOwnership.get(e.correlationId);
        stepOwnership.set(e.correlationId, {
          ...(prior ?? {}),
          sawRetrying: true,
        });
      }
    }
  };
  observeEventsForOwnership(events);
  const scheduledWaitContinuations = new Set<string>();
  const maxInlineSteps = getMaxInlineSteps();
  const budget = new ReplayBudget();
  const workflowStartedAt = workflowRun.startedAt
    ? +workflowRun.startedAt
    : Date.now();
  const rootRunId =
    (workflowRun.attributes as Record<string, string> | undefined)?.[
      ROOT_RUN_ID_ATTRIBUTE
    ] ?? runId;
  let inlineStepsExecuted = 0;
  let runGone = false;
  // Set when this invocation wrote an event the workflow must consume to
  // make progress (attr_set, getConflict-awaited hook_created) and the
  // loop has not yet read it back, since eventually-consistent listings can
  // return 0 new events right after a write. If it is still set when the
  // loop exits suspended, the entrypoint requeues immediately instead of
  // exiting awaiting_external with the unblocking event already written
  // and nothing scheduled to read it.
  let pendingRequeueSignal = false;
  // Snapshot captured at suspension exit (threshold met), persisted
  // after the VM is disposed.
  let capturedSnapshot:
    | {
        data: Uint8Array;
        rngDraws: number;
        lastUlid: string | undefined;
        serdeRootPtr: number;
        clockMs: number;
        engineVersion: string;
        /** The log position the heap has consumed through. */
        eventsCursor: string;
        eventsThroughCursor: number;
      }
    | undefined;
  // Set when an inline step's lazy claim came back `throttled`: the exit
  // defers a fresh orchestrator invocation by this many seconds (the longest
  // backoff in the batch) instead of handing the step to the queue.
  let throttledReplaySeconds: number | undefined;

  /**
   * Fetch all events not yet processed by the live VM (log order), reading
   * from where the log was last read to. A World's cursor never passes a
   * position whose writer is still in flight, so reading forward from it
   * cannot skip an event; the id set is what makes a re-read of the same
   * span (after a queued page or a delta moved the view ahead of the cursor)
   * harmless.
   */
  const fetchUnseenEvents = async (): Promise<Event[]> => {
    const unseen: Event[] = [];
    let cursor: string | null = logView.logCursor;
    // Every event listed from the view's cursor (seen or not) is covered
    // by the cursor this read ends at.
    let listed = 0;
    let listedWithoutCursor = false;
    let hasMore = true;
    while (hasMore) {
      const response = await world.events.list({
        runId,
        pagination: {
          sortOrder: 'asc',
          cursor: cursor ?? undefined,
          limit: 1000,
        },
        resolveData: REPLAY_RESOLVE_DATA,
      });
      for (const e of response.data) {
        if (e.eventId && seenEventIds.has(e.eventId)) continue;
        if (e.eventId) seenEventIds.add(e.eventId);
        unseen.push(e);
      }
      if (response.cursor) {
        cursor = response.cursor;
        listed += response.data.length;
      } else if (response.data.length > 0) {
        // Events with no cursor after them: how many events the cursor
        // covers is no longer known (snapshot saves stop for this
        // invocation).
        listedWithoutCursor = true;
      }
      hasMore = response.data.length > 0 && response.cursor != null;
    }
    logView.advanceCursor(cursor, listedWithoutCursor ? undefined : listed);
    logView.markFed(unseen);
    observeEventsForOwnership(unseen);
    return unseen;
  };

  /**
   * Events a World handed back on this invocation's writes that the VM can
   * take now: the contiguous run above what it has (see
   * `QuickJSLogView.takeContiguous`). Delivered ahead of `fetchUnseenEvents`
   * so a write's response, not a listing, is what usually carries the log
   * forward, which is the round-trip the page exists to save. Empty when
   * nothing is queued or the next position is not in hand, and the caller
   * lists.
   */
  const takeQueuedEvents = (): Event[] => {
    const queued = logView.takeContiguous();
    for (const e of queued) {
      if (e.eventId) seenEventIds.add(e.eventId);
    }
    observeEventsForOwnership(queued);
    return queued;
  };

  // Inline steps run as background work of this delivery, so the live VM
  // keeps advancing while a body runs: a due timer completes its wait, a hook
  // payload or an abort reaches the workflow, a sibling's outcome resolves.
  // Events reach the VM only between turns of the loop below, in log order,
  // through the view. Every body settles before the delivery returns.
  type InlineSettled = {
    step: PendingStep;
    outcome: PromiseSettledResult<StepExecutionResult>;
  };
  const inFlightInline = new Map<string, Promise<void>>();
  const settledInline: InlineSettled[] = [];
  let inlineFeed: LiveLogFeed | undefined;
  /** Events the live feed delivered so far in this invocation. */
  let fedEventCount = 0;
  /**
   * Starts the live feed once: events other writers commit (a background
   * step's outcome, a hook payload, a cancellation) are pushed or polled into
   * the view and wake the loop.
   */
  const ensureInlineFeed = (): void => {
    if (inlineFeed || !logView.tracking) return;
    inlineFeed = new LiveLogFeed(world, runId, {
      // From what this invocation already knows, its own writes included: a
      // feed started late would otherwise wait on positions it never hears
      // of again, and drop everything after them until a poll fills in.
      afterSlot: Math.max(
        maxEventSlot(events) ?? 0,
        logView.highestKnownSlot ?? 0
      ),
      cursor: logView.logCursor,
      pollIntervalMs: getOrchestratorPollIntervalMs(),
      onEvents: (fed) => {
        fedEventCount += fed.length;
        logView.absorb({ events: fed });
        notifyProgress();
      },
    });
    inlineFeed.start();
  };
  let progressDirty = false;
  let progressWaiter: (() => void) | undefined;
  const notifyProgress = (): void => {
    progressDirty = true;
    const waiter = progressWaiter;
    progressWaiter = undefined;
    waiter?.();
  };
  /**
   * Inline steps an earlier delivery created and did not finish: their start
   * was refused for load, or the delivery that started them died before the
   * outcome. This orchestrator runs them inline again (attempt = their
   * `step_started` count + 1). Read from the delivery's full log, since a
   * restored snapshot's log holds only the suffix after it.
   */
  const fullLog = (): Event[] => {
    const byId = new Map<string, Event>();
    for (const e of params.preloadedEventsComplete
      ? (params.preloadedEvents ?? [])
      : []) {
      byId.set(e.eventId, e);
    }
    for (const e of events) byId.set(e.eventId, e);
    return [...byId.values()].sort((a, b) =>
      a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
    );
  };
  const logStepStates = (): Map<string, LogStepState> =>
    new Map(analyzeLogSteps(fullLog()).map((s) => [s.correlationId, s]));
  let loggedSteps: Map<string, LogStepState> | undefined;
  const stepInputFromLog = async (
    state: LogStepState
  ): Promise<SerializedData> => {
    const created =
      events.find((e) => e.eventId === state.createdEventId) ??
      params.preloadedEvents?.find((e) => e.eventId === state.createdEventId);
    if (
      created?.eventType === 'step_created' &&
      created.eventData.input !== undefined
    ) {
      return created.eventData.input;
    }
    // A World may leave step inputs out of replay loads; read it back.
    const read = await world.events.get(runId, state.createdEventId, {
      resolveData: 'all',
    });
    if (read.eventType !== 'step_created') {
      throw new WorkflowRuntimeError(
        `Event "${state.createdEventId}" is not a step_created`
      );
    }
    return read.eventData.input;
  };

  /**
   * Writes a new inline step's `step_created`, and with it the first
   * attempt's `step_started` when the World takes batch writes: two plain
   * appends in one fenced write. Resolves with the start when it committed;
   * otherwise the executor writes it. Mirrors the node engine's creation
   * batch (`planStepsAndWaits` with `startInlineSteps`).
   */
  const createInlineStep = async (
    step: PendingStep,
    input: SerializedData
  ): Promise<CallerStart | undefined> => {
    const created: CreateEventRequest = {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: step.correlationId,
      eventData: {
        stepName: step.stepId,
        workflowName: workflowRun.workflowName,
        input,
        inline: true,
        ...(ownerMessageId ? { creatorMessageId: ownerMessageId } : {}),
      },
    };
    const writer = params.writer;
    if (!writer?.supportsBatch) {
      await createEvent(created);
      return undefined;
    }
    const postSentAtMs = Date.now();
    const batch = await writer.createBatch(
      [
        { event: created },
        {
          event: {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: step.correlationId,
            eventData: {
              stepName: step.stepId,
              attempt: 1,
              startReason: 'first',
            },
          },
          computeInstanceId: COMPUTE_INSTANCE_ID,
        },
      ],
      {
        ...(requestId ? { requestId } : {}),
        ...logView.snapshotParams(),
      }
    );
    const completedAtMs = Date.now();
    const [createdItem, startedItem] = batch.results;
    // Positions of both writes, and the report of what landed below them.
    let first = true;
    for (const item of batch.results) {
      if (item.error !== undefined) continue;
      logView.absorb(
        first
          ? { event: item.event, events: batch.events }
          : { event: item.event },
        { deliverEvent: deliversOwnEvent(item.event.eventType) }
      );
      first = false;
    }
    if (createdItem?.error !== undefined) {
      // The batch is not atomic on a single-orchestrator run; a refused
      // creation fails this delivery the way a single write would.
      const message = `Inline step creation failed with ${createdItem?.status}: ${createdItem?.message}`;
      if (createdItem?.status === 429) throw new ThrottleError(message);
      if (createdItem?.status === 410) throw new RunExpiredError(message);
      throw new WorkflowWorldError(message, {
        status: createdItem?.status ?? 500,
      });
    }
    if (!startedItem) return undefined;
    if (startedItem.error !== undefined) {
      // Created, not started. A throttle or a finished run is the start's
      // refusal; anything else leaves the start to the executor.
      const message = `Inline step start failed with ${startedItem.status}: ${startedItem.message}`;
      if (startedItem.status === 429) throw new ThrottleError(message);
      if (startedItem.status === 410) throw new RunExpiredError(message);
      return undefined;
    }
    return {
      startedAt: new Date(startedItem.event.createdAt),
      postSentAtMs,
      completedAtMs,
    };
  };

  /**
   * Starts one inline step's body; never awaited here. `optimistic` (turbo)
   * starts it before its `step_created` and `step_started` commit.
   */
  const launchInline = (
    step: PendingStep,
    resume?: LogStepState,
    optimistic = false
  ): void => {
    // A step this delivery started inline never runs inline again in it.
    executedStepIds.add(step.correlationId);
    inlineStepsExecuted++;
    // The replay budget covers orchestration, not step bodies: it stays
    // paused while any body runs.
    if (inFlightInline.size === 0) budget.pause();
    ensureInlineFeed();
    const run = runStepSingleFlight(
      runId,
      step.correlationId,
      async () => {
        let input: SerializedData;
        let startAfter: Promise<unknown> | undefined;
        if (resume) {
          // Created inline by an earlier delivery: its `step_created` (and
          // the input on it) is already in the log.
          input = await stepInputFromLog(resume);
        } else {
          input = await encryptSerializedData(step.input, encryptionKey);
          // The step's execution mode is fixed here: inline, run by this
          // orchestrator. `step_created` commits before the body starts,
          // except under turbo's optimistic start, where the body starts
          // now and its `step_started` follows this commit.
          inlineCreatedStepIds.add(step.correlationId);
          // The executor waits for it before the start (and, unless
          // optimistic, before the body), and reads a refusal as its start's.
          startAfter = createInlineStep(step, input);
          startAfter.catch(() => {});
        }
        return executeStep({
          world,
          createEvent: async (data, eventParams) => {
            const written = await writeEvent(data, {
              ...eventParams,
              ...logView.snapshotParams(),
            });
            logView.absorb(written, {
              deliverEvent: deliversOwnEvent(data.eventType),
            });
            return written;
          },
          workflowRunId: runId,
          workflowDeploymentId: workflowRun.deploymentId,
          workflowName: workflowRun.workflowName,
          workflowStartedAt,
          requestId,
          rootRunId,
          stepId: step.correlationId,
          stepName: step.stepId,
          encryptionKey,
          runSpecVersion: workflowRun.specVersion,
          attempt: resume ? resume.starts + 1 : 1,
          startReason: resume && resume.starts > 0 ? 'redelivery' : 'first',
          ...(resume?.firstStartedAt
            ? { firstStartedAt: resume.firstStartedAt }
            : {}),
          input,
          forceOptimisticStart: optimistic && !resume,
          ...(turbo ? { runReadyBarrier: turbo.runReadyBarrier } : {}),
          ...(startAfter
            ? { startAfter: startAfter as Promise<CallerStart | undefined> }
            : {}),
          beforeBody: () => params.writer?.assertActive(),
        });
      },
      'debug'
    )
      .then(
        (value) => {
          settledInline.push({ step, outcome: { status: 'fulfilled', value } });
        },
        (reason: unknown) => {
          settledInline.push({ step, outcome: { status: 'rejected', reason } });
        }
      )
      .finally(() => {
        inFlightInline.delete(step.correlationId);
        if (inFlightInline.size === 0) budget.resume();
        notifyProgress();
      });
    inFlightInline.set(step.correlationId, run);
  };
  /** Lets every running inline body settle, and stops the live feed. */
  const drainInline = async (): Promise<void> => {
    while (inFlightInline.size > 0) {
      await Promise.allSettled([...inFlightInline.values()]);
    }
    inlineFeed?.stop();
    inlineFeed = undefined;
  };
  /**
   * Acts on the inline bodies that settled since the last turn. A body that
   * threw (a superseded writer, a transport error) ends the delivery once
   * every other body has settled.
   */
  const processSettledInline = async (): Promise<void> => {
    const settled = settledInline.splice(0);
    let failure: { reason: unknown } | undefined;
    for (const { step, outcome } of settled) {
      if (outcome.status === 'rejected') {
        if (
          failure === undefined ||
          OrchestratorSupersededError.is(outcome.reason)
        ) {
          failure = { reason: outcome.reason };
        }
        continue;
      }
      const result = outcome.value;
      if (result.type === 'throttled') {
        // The start was refused for load: defer a fresh orchestrator
        // invocation by the backoff, whose replay runs the step inline again.
        throttledReplaySeconds = Math.max(
          throttledReplaySeconds ?? 0,
          result.timeoutSeconds
        );
      } else if (result.type === 'retry') {
        // The retry moves to the background: this is the step's first
        // message, and it carries the next attempt.
        queuedStepIds.add(step.correlationId);
        await queueStepMessage({
          world,
          runId,
          workflowRun,
          step,
          delaySeconds: result.timeoutSeconds,
          namespace,
          nextTraceCarrier,
          purpose: 'dispatch',
          stepAttempt: 2,
          wfdiag,
        });
      } else if (result.type === 'gone') {
        runGone = true;
      } else {
        // A terminal outcome the VM has not been fed yet. Until a feed
        // delivers it, exiting must hand the run to a fresh invocation:
        // an inline step has no queue message of its own.
        pendingRequeueSignal = true;
      }
    }
    if (settled.length > 0) {
      wfdiag('inline_steps_settled', {
        count: settled.length,
        outcomes: settled.map(({ outcome }) =>
          outcome.status === 'fulfilled' ? outcome.value.type : 'rejected'
        ),
      });
    }
    if (failure !== undefined) {
      await drainInline();
      throw failure.reason;
    }
  };
  /**
   * Waits for a body to settle, a live-feed event, or the earliest open
   * wait's deadline, whichever comes first.
   */
  const waitForInlineProgress = async (
    pendingOperations: PendingOperation[]
  ): Promise<void> => {
    if (progressDirty) {
      progressDirty = false;
      return;
    }
    let dueMs: number | undefined;
    for (const op of pendingOperations) {
      if (op.type !== 'wait') continue;
      const wait = op as PendingWait;
      if (completedWaitIds2.has(wait.correlationId)) continue;
      const at = new Date(wait.resumeAt).getTime();
      if (dueMs === undefined || at < dueMs) dueMs = at;
    }
    let handle: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      progressWaiter = resolve;
      if (dueMs !== undefined) {
        handle = setTimeout(resolve, Math.max(0, dueMs - Date.now()));
      }
    });
    if (handle) clearTimeout(handle);
    progressWaiter = undefined;
    progressDirty = false;
  };

  /**
   * Keeps this delivery live while the run waits on work done elsewhere (see
   * `getOrchestratorLingerMs`). `true` once the feed delivered an event or a
   * wait fell due, so the loop takes another turn; `false` when the time ran
   * out without either.
   */
  const lingerForExternalWork = async (
    awaitsExternal: boolean,
    pendingOperations: PendingOperation[]
  ): Promise<boolean> => {
    const lingerMs = getOrchestratorLingerMs();
    if (
      !awaitsExternal ||
      lingerMs <= 0 ||
      params.lingerDeadlineMs === undefined ||
      !world.events.subscribe ||
      !logView.tracking
    ) {
      return false;
    }
    const untilMs = Math.min(Date.now() + lingerMs, params.lingerDeadlineMs);
    if (untilMs <= Date.now()) return false;
    ensureInlineFeed();
    const fedBefore = fedEventCount;
    const startedAtMs = Date.now();
    budget.pause();
    try {
      while (Date.now() < untilMs) {
        let handle: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          waitForInlineProgress(pendingOperations),
          new Promise<void>((resolve) => {
            handle = setTimeout(resolve, untilMs - Date.now());
          }),
        ]);
        clearTimeout(handle);
        progressWaiter = undefined;
        const waitDue = pendingOperations.some(
          (op) =>
            op.type === 'wait' &&
            !completedWaitIds2.has(op.correlationId) &&
            new Date((op as PendingWait).resumeAt).getTime() <= Date.now()
        );
        if (fedEventCount > fedBefore || waitDue) {
          wfdiag('linger', {
            outcome: 'resumed',
            lingeredMs: Date.now() - startedAtMs,
          });
          return true;
        }
      }
    } finally {
      budget.resume();
    }
    wfdiag('linger', {
      outcome: 'idle',
      lingeredMs: Date.now() - startedAtMs,
    });
    return false;
  };

  try {
    let iteration = 0;
    while (result.suspended && !runGone && !budget.isExhausted()) {
      iteration++;
      // Re-check the event ceiling every turn: the loop appends events on
      // each continueWithEvents, so a single invocation can otherwise grow
      // the log arbitrarily far past the operator's limit (the node engine
      // re-checks per replay for the same reason). `seenEventIds` counts
      // every event this invocation has observed: initial log + all
      // feeds.
      if (
        maxEventsLimit !== undefined &&
        restoredEventCount + seenEventIds.size >= maxEventsLimit
      ) {
        throw new MaxEventsExceededError(
          restoredEventCount + seenEventIds.size,
          maxEventsLimit
        );
      }
      await processSettledInline();
      if (throttledReplaySeconds !== undefined || runGone) break;
      const pendingOperations = result.suspended.pendingOperations;
      if (
        turboOptimistic &&
        pendingOperations.some(
          (op) => op.type !== 'step' && op.type !== 'attribute'
        )
      ) {
        turboOptimistic = false;
      }

      // Select this turn's inline candidates BEFORE dispatch: fresh steps
      // (no step_created yet) that this invocation hasn't already handled.
      // Their step_created is deliberately NOT written by dispatch: the
      // inline claim below is a lazy step_started carrying the input,
      // which the world applies as an atomic create-claim. A concurrent
      // invocation racing on the same fresh step loses that claim with
      // EntityConflictError and skips, so step bodies cannot double-run
      // (previously both invocations bare-started the step after one lost
      // the swallowed step_created race).
      const freshSteps = pendingOperations.filter(
        (op): op is PendingStep =>
          op.type === 'step' &&
          !op.hasCreatedEvent &&
          !executedStepIds.has(op.correlationId) &&
          !queuedStepIds.has(op.correlationId)
      );
      // Steps whose input refused to serialize (see
      // PendingStep.serializationError) never execute: they must not be
      // inline-claimed (a lazy step_started would need the input that
      // failed) nor queued. Dispatch below finalizes them as step_created
      // + step_failed instead; only healthy steps compete for inline
      // slots and overflow.
      const healthySteps = freshSteps.filter(
        (step) => !step.serializationError
      );
      // Inline steps an earlier delivery created and left open run inline
      // again here (once per delivery), ahead of fresh steps for the inline
      // slots. A placeholder-input step (its arguments refused to serialize)
      // is among them: the executor fails it from the placeholder.
      loggedSteps ??= logStepStates();
      const resumedInline = pendingOperations.flatMap(
        (op): { step: PendingStep; state: LogStepState }[] => {
          if (op.type !== 'step' || !op.hasCreatedEvent) return [];
          if (executedStepIds.has(op.correlationId)) return [];
          if (queuedStepIds.has(op.correlationId)) return [];
          const state = loggedSteps?.get(op.correlationId);
          if (!state?.runnableInline) return [];
          return [{ step: op as PendingStep, state }];
        }
      );
      const inlineCandidates =
        maxInlineSteps <= 0
          ? []
          : healthySteps.slice(
              0,
              Math.max(0, maxInlineSteps - resumedInline.length)
            );
      const inlineClaimCids = new Set(
        inlineCandidates.map((step) => step.correlationId)
      );

      // 1. Durable side effects for this suspension's pending ops.
      const opsToDispatch = pendingOperations.map((op) =>
        op.type === 'hook' &&
        (op as PendingHook).abortRequested &&
        recordedAbortIds.has(op.correlationId)
          ? ({ ...op, abortRequested: false } as PendingOperation)
          : op
      );
      for (const op of pendingOperations) {
        if (op.type === 'hook' && (op as PendingHook).abortRequested) {
          recordedAbortIds.add(op.correlationId);
        }
      }
      // Steps beyond the inline cap are handed to the queue in the same
      // turn their step_created is written. Where eligible, the dispatch
      // below parallelizes each overflow step's step_created write with
      // its queue publish (resilient step dispatch: the message carries
      // `stepInput` so the consumer can re-ensure the event); the rest
      // are queued right after, in parallel. This must all happen BEFORE
      // the event feed below: the feed always observes those
      // step_created writes as unseen events and `continue`s, so a
      // handoff placed after it is unreachable on the only iteration
      // that still classifies these steps as fresh: next turn they carry
      // hasCreatedEvent and would never be queued at all (the wedge behind
      // promiseRaceStressTestWorkflow hanging in the quickjs CI legs). The
      // step-identity-scoped idempotency key makes repeats harmless.
      const overflowSteps = healthySteps.slice(inlineCandidates.length);
      const dispatched = await dispatchPendingOps({
        world,
        runId,
        workflowRun,
        encryptionKey,
        namespace,
        nextTraceCarrier,
        createEvent,
        ...(logView.tracking && typeof logView.logCursor === 'string'
          ? { deltaCursor: logView.logCursor }
          : {}),
        pendingOperations: opsToDispatch,
        // Every step whose `step_created` this invocation already wrote,
        // whether or not the VM has been fed it yet: a World that keeps no
        // step rows would append a second one.
        skipStepCreation: new Set([
          ...inlineClaimCids,
          ...inlineCreatedStepIds,
          ...queuedStepIds,
          ...executedStepIds,
        ]),
        writtenOpIds,
        creatorMessageId: ownerMessageId,
        queueStepCids: new Set(overflowSteps.map((s) => s.correlationId)),
        finalizeUnserializableSteps: true,
        wfdiag,
      });
      if (
        dispatched.createdAttributeEvent ||
        dispatched.createdGetConflictHook ||
        dispatched.createdHookConflict
      ) {
        pendingRequeueSignal = true;
      }
      // A finalized unserializable step has terminal events durably
      // written but no execution message anywhere: if the feed below
      // doesn't surface them (eventually-consistent listing) and the loop
      // exits, nothing would ever re-invoke the run to observe the
      // failure. Raise the requeue signal (same mechanism as inline
      // terminals) and mark the steps handled so later turns don't
      // re-finalize or backstop-queue them.
      if (dispatched.failedSerializationStepCids.size > 0) {
        pendingRequeueSignal = true;
        for (const cid of dispatched.failedSerializationStepCids) {
          executedStepIds.add(cid);
        }
      }

      for (const cid of dispatched.queuedStepCids) {
        queuedStepIds.add(cid);
      }
      await Promise.all(
        overflowSteps
          .filter((step) => !dispatched.queuedStepCids.has(step.correlationId))
          .map((step) => {
            queuedStepIds.add(step.correlationId);
            const createdEventId = dispatched.createdStepEventIds.get(
              step.correlationId
            );
            const input = dispatched.createdStepInputs.get(step.correlationId);
            return queueStepMessage({
              world,
              runId,
              workflowRun,
              step,
              namespace,
              nextTraceCarrier,
              purpose: 'dispatch',
              ...(createdEventId ? { stepCreatedEventId: createdEventId } : {}),
              ...(input &&
              input.byteLength <= MAX_STEP_MESSAGE_INPUT_BYTES &&
              (workflowRun.specVersion ?? 0) >=
                SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
                ? { stepInput: input }
                : {}),
              wfdiag,
            });
          })
      );

      // Complete elapsed waits so their wait_completed events are picked
      // up by the feed below (instead of a queue re-invocation).
      const waitCompletePromises: Promise<void>[] = [];
      for (const op of pendingOperations) {
        if (op.type !== 'wait') continue;
        const wait = op as PendingWait;
        if (completedWaitIds2.has(wait.correlationId)) continue;
        if (
          new Date(wait.resumeAt).getTime() - Date.now() > 0 &&
          !params.wakeUpWaits?.has(wait.correlationId)
        ) {
          continue;
        }
        completedWaitIds2.add(wait.correlationId);
        waitCompletePromises.push(
          (async () => {
            try {
              await createEvent({
                eventType: 'wait_completed',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: wait.correlationId,
                eventData: { resumeAt: new Date(wait.resumeAt) },
              });
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      }
      if (waitCompletePromises.length > 0) {
        await Promise.all(waitCompletePromises);
      }

      // 2. Cheap progress first: feed newly recorded events into the live
      // VM before blocking on step bodies. What the writes above handed back
      // is delivered first, and a listing runs when the queue does not reach
      // the next position. A report changes what is fed first, not whether
      // this listing happens: after a queued page is fed, this branch
      // `continue`s, and the next iteration finds the queue empty and lists
      // from a cursor a report does not advance (re-reading the reported
      // span, deduped on `seenEventIds`). Only the inline delta below, which
      // does advance the cursor, saves a listing outright. Same shape as the
      // node engine.
      {
        // A listing only when the VM is short of a position this invocation
        // knows of (see `QuickJSLogView.behind`): a turn that wrote nothing,
        // or whose writes came back on their responses, has nothing to read.
        const queued = takeQueuedEvents();
        const newEvents =
          queued.length > 0
            ? queued
            : logView.behind
              ? await fetchUnseenEvents()
              : [];
        if (newEvents.length > 0) {
          // The listing caught up with this invocation's writes, so any
          // attr_set / getConflict hook_created has been (or is being)
          // consumed by the live VM, so no external requeue is needed.
          pendingRequeueSignal = false;
          eventsProcessedSinceSnapshot += newEvents.length;
          result = await session.continueWithEvents(newEvents);
          wfdiag('inline_iteration', {
            iteration,
            phase: 'feed',
            fedEvents: newEvents.length,
            fedFrom: queued.length > 0 ? 'write-response' : 'list',
            outcome: result.completed
              ? 'completed'
              : result.failed
                ? 'failed'
                : 'suspended',
          });
          continue;
        }
      }

      // 3. No cheap progress left, so execute steps inline.
      const stepOps = pendingOperations.filter(
        (op): op is PendingStep => op.type === 'step'
      );
      // Steps created by an earlier invocation that are still pending are
      // enqueued again only by a redelivery of the message that created
      // them, and only while they have no `step_started` (see
      // `stepsToReenqueue`). Any broader rule would send a second message
      // for a step whose first one is still retrying, which is a second
      // owner of its body.
      const reenqueue = new Set(
        stepsToReenqueue({
          events,
          messageId: ownerMessageId ?? '',
          deliveryCount: deliveryAttempt,
        })
      );
      for (const step of stepOps) {
        if (!step.hasCreatedEvent) continue;
        if (executedStepIds.has(step.correlationId)) continue;
        if (queuedStepIds.has(step.correlationId)) continue;
        if (!reenqueue.has(step.correlationId)) continue;
        queuedStepIds.add(step.correlationId);
        await queueStepMessage({
          world,
          runId,
          workflowRun,
          step,
          namespace,
          nextTraceCarrier,
          purpose: 'dispatch',
          wfdiag,
        });
      }

      if (
        inlineCandidates.length === 0 &&
        resumedInline.length === 0 &&
        inFlightInline.size === 0
      ) {
        // Outcomes of bodies that just settled are acted on first.
        if (settledInline.length > 0) continue;
        // No in-process progress possible: the run awaits an external
        // stimulus (hook payload, queued step, wait timer). While it waits
        // on a hook or a step running from its own message, stay live for
        // it instead of leaving it to a queued wake.
        if (
          await lingerForExternalWork(
            pendingOperations.some(
              (op) =>
                op.type === 'hook' ||
                (op.type === 'step' &&
                  // Running from its own message: queued by this delivery
                  // (its retry included), or created by an earlier one and
                  // not run here.
                  (queuedStepIds.has(op.correlationId) ||
                    ((op as PendingStep).hasCreatedEvent &&
                      !executedStepIds.has(op.correlationId))))
            ) || awaitsExternalWork(fullLog()),
            pendingOperations
          )
        ) {
          continue;
        }
        break;
      }

      // A timer for the soonest pending wait, armed once per wait while
      // bodies run, so the wait still completes if this invocation dies
      // mid-body. While it lives, the loop completes the wait itself when it
      // falls due (see `waitForInlineProgress`).
      let soonestWait: { correlationId: string; seconds: number } | undefined;
      for (const op of pendingOperations) {
        if (op.type !== 'wait') continue;
        const wait = op as PendingWait;
        if (scheduledWaitContinuations.has(wait.correlationId)) continue;
        if (!armsWaitTimer(wait.correlationId)) continue;
        // Completed by this invocation already; the event just has not been
        // fed back into the VM yet.
        if (completedWaitIds2.has(wait.correlationId)) continue;
        const resumeMs = new Date(wait.resumeAt).getTime() - Date.now();
        // An elapsed wait still gets a continuation (clamped to 1s): one
        // whose deadline fell between the elapsed-wait pass above and this
        // sweep would otherwise get neither a wait_completed nor a timer.
        const seconds = Math.max(1, Math.ceil(resumeMs / 1000));
        if (!soonestWait || seconds < soonestWait.seconds) {
          soonestWait = { correlationId: wait.correlationId, seconds };
        }
      }
      if (soonestWait) {
        scheduledWaitContinuations.add(soonestWait.correlationId);
        await queueWaitTimer(soonestWait.correlationId, soonestWait.seconds);
        wfdiag('wait_continuation_scheduled', {
          correlationId: soonestWait.correlationId,
          delaySeconds: soonestWait.seconds,
        });
      }

      for (const { step, state } of resumedInline) launchInline(step, state);
      for (const step of inlineCandidates) {
        launchInline(step, undefined, turboOptimistic);
      }
      wfdiag('inline_iteration', {
        iteration,
        phase: 'steps',
        launched: inlineCandidates.length + resumedInline.length,
        inFlight: inFlightInline.size,
      });
      await waitForInlineProgress(pendingOperations);
    }
    // Every inline body settles before the delivery returns, including when
    // the workflow finished while one still ran.
    await drainInline();
    await processSettledInline();
    if (snapshotThreshold > 0 && result.suspended) {
      // Remember whether a snapshot can exist for this run yet, so the
      // next invocation in this process can skip a guaranteed-miss load.
      noteSnapshotThresholdProgress(
        runId,
        !existingSnapshot &&
          restoredEventCount + seenEventIds.size < snapshotThreshold
      );
    }
    // Capture the VM memory for persistence while the session is still
    // alive. The (compress → encrypt → save) pipeline runs after the VM
    // is disposed — only the byte capture needs the live session.
    // The saved log position is the view's read cursor and the number of
    // events it covers. Every event up to that cursor must already be in
    // the heap: nothing may still be queued for delivery (an inline delta
    // can move the cursor past events the VM hasn't been given yet), and
    // the count must be known. Events fed beyond the cursor are fine: a
    // restore re-feeds them, which is harmless, and counts them once.
    const positionCursor = logView.logCursor;
    const positionCount = logView.eventsThroughCursor;
    if (
      snapshotThreshold > 0 &&
      result.suspended &&
      !runGone &&
      eventsProcessedSinceSnapshot >= snapshotThreshold &&
      positionCursor !== null &&
      positionCount !== undefined &&
      logView.bufferedCount === 0 &&
      // Once oversized, always oversized (linear memory never shrinks):
      // skip BEFORE the capture, which costs two full heap copies.
      !oversizedSnapshotRuns.has(runId)
    ) {
      try {
        capturedSnapshot = {
          ...session.snapshot(),
          eventsCursor: positionCursor,
          eventsThroughCursor: positionCount,
        };
        if (capturedSnapshot.data.byteLength > MAX_SNAPSHOT_PLAINTEXT_BYTES) {
          // A heap this large costs more to store/decompress than the
          // replay it saves — skip the save (full replay remains correct)
          // and make the skip visible. Latch so later suspensions of
          // this run skip the capture itself.
          latchOversizedSnapshotRun(runId);
          runtimeLogger.warn(
            'QuickJS runtime: snapshot exceeds the size ceiling, skipping persist for the rest of this run',
            {
              workflowRunId: runId,
              plaintextBytes: capturedSnapshot.data.byteLength,
              maxBytes: MAX_SNAPSHOT_PLAINTEXT_BYTES,
            }
          );
          capturedSnapshot = undefined;
        }
      } catch (err) {
        runtimeLogger.warn('QuickJS runtime: snapshot capture failed', {
          workflowRunId: runId,
          message: (err as Error)?.message,
        });
      }
    }
  } finally {
    session.dispose();
  }

  if (capturedSnapshot && snapshotsStorage) {
    // Persist: seal (frame with the restore-relevant metadata) →
    // compress (QuickJS heaps compress ~4x) → encrypt → save. Failures
    // are non-fatal — the run still makes progress via full replay; the
    // next qualifying suspension retries. Moved off the response path via
    // waitUntil: only the byte capture needed the live session; the
    // pipeline runs post-response so a multi-MB heap doesn't delay the
    // next step's pickup. (The capture above is skipped when the log
    // position isn't exact yet; the next qualifying suspension retries.)
    const snapshot = capturedSnapshot;
    const metadata: SnapshotMetadata = {
      eventsCursor: snapshot.eventsCursor,
      createdAt: new Date(),
      eventCount: snapshot.eventsThroughCursor,
      rngDraws: snapshot.rngDraws,
      lastUlid: snapshot.lastUlid,
      serdeRootPtr: snapshot.serdeRootPtr,
      clockMs: snapshot.clockMs,
      engineVersion: snapshot.engineVersion,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
    };
    snapshotStored = true;
    safeWaitUntil(
      trace('workflow.quickjs.snapshot.save', async (span) => {
        // Yield PAST the current tick before touching the bytes: this
        // runs synchronously up to its first real await, and the point of
        // waitUntil here is to let the response flush first. (The seal's
        // compression uses the async zstd path, so the compression itself
        // doesn't block the event loop either.)
        await new Promise((resolve) => setImmediate(resolve));
        const t0 = tick();
        const toStore = await sealSnapshot({
          runId,
          heap: snapshot.data,
          metadata,
          encryptionKey,
        });
        await snapshotsStorage.save(runId, toStore, metadata);
        // A concurrent invocation may have finished the run while this
        // save was in flight, after its own terminal cleanup ran: a
        // snapshot saved for a finished run is never read or deleted
        // again. The terminal paths write the run's terminal event before
        // they delete, so a save that lands after that delete sees the
        // terminal status here and removes itself.
        const status = await world.runs
          .get(runId, { resolveData: 'none' })
          .then((run) => run.status)
          .catch(() => undefined);
        const finished =
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled';
        if (finished) await snapshotsStorage.delete(runId);
        const saveMs = Math.round(tick() - t0);
        span?.setAttributes({
          ...Attribute.WorkflowRunId(runId),
          ...Attribute.QuickJSSnapshotSaveMs(saveMs),
          ...Attribute.QuickJSSnapshotPlaintextBytes(snapshot.data.byteLength),
          ...Attribute.QuickJSSnapshotStoredBytes(toStore.byteLength),
        });
        wfdiag('snapshot_saved', {
          plaintextBytes: snapshot.data.byteLength,
          storedBytes: toStore.byteLength,
          eventsCursor: snapshot.eventsCursor,
          eventsProcessedSinceSnapshot,
          rngDraws: snapshot.rngDraws,
          durationMs: saveMs,
          deletedForFinishedRun: finished,
        });
      }),
      (err) => {
        runtimeLogger.warn('QuickJS runtime: snapshot save failed', {
          workflowRunId: runId,
          message: (err as Error)?.message,
        });
      }
    );
  }

  parentSpan?.setAttributes({
    ...Attribute.QuickJSInlineSteps(inlineStepsExecuted),
  });

  // The run reached a terminal state: its snapshot (if any) is dead
  // weight, so delete it best-effort, off the response path (after the
  // terminal event is written; see the save pipeline for why that order
  // matters). A snapshot can exist when one was found or saved by this
  // invocation, or when the log has reached the threshold, since any
  // invocation may have saved one from then on (including a concurrent
  // one whose save hasn't landed yet, which checks the run's status after
  // it lands). Runs whose log never reached the threshold pay nothing.
  // Runs that end with no invocation observing it (cancelled externally)
  // are left to the World: storage-side retention is the backstop there.
  const scheduleSnapshotDelete = (): void => {
    if (!snapshotsStorage) return;
    const mayExist =
      snapshotStored ||
      (snapshotPolicyThreshold > 0 &&
        restoredEventCount + seenEventIds.size >= snapshotPolicyThreshold);
    if (!mayExist) return;
    safeWaitUntil(
      Promise.resolve().then(() => snapshotsStorage.delete(runId)),
      (err) => {
        runtimeLogger.debug('QuickJS runtime: snapshot delete failed', {
          workflowRunId: runId,
          message: (err as Error)?.message,
        });
      }
    );
  };

  if (result.completed) {
    // Workflow completed
    runtimeLogger.info('QuickJS runtime: workflow completed', {
      workflowRunId: runId,
    });
    parentSpan?.setAttributes({
      ...Attribute.QuickJSOutcome('completed'),
    });

    // Flush leftover pending side effects (abort recordings, system-hook
    // disposals, fire-and-forget attribute/hook events) BEFORE writing
    // run_completed. Mirrors the node:vm engine's drainPendingQueueItems.
    // Drain failures are swallowed: the workflow's own outcome is the
    // source of truth.
    if (result.completed.drainOperations?.length) {
      try {
        await dispatchPendingOps({
          world,
          runId,
          workflowRun,
          encryptionKey,
          namespace,
          nextTraceCarrier,
          // Plain create: the run is ending, nothing replays its log, so a
          // page handed back here would be read by no one.
          createEvent: terminalCreateEvent,
          skipStepCreation: new Set([
            ...inlineCreatedStepIds,
            ...queuedStepIds,
            ...executedStepIds,
          ]),
          writtenOpIds,
          pendingOperations: result.completed.drainOperations,
          wfdiag,
        });
      } catch (err) {
        runtimeLogger.warn('QuickJS runtime: terminal drain failed', {
          workflowRunId: runId,
          message: (err as Error)?.message,
        });
      }
    }

    // Create run_completed event.
    // The VM serializes the workflow result as format-prefixed devalue bytes
    // ("devl" + devalue) with no encryption (the VM has no access to the
    // CryptoKey). Host-side encryption is applied here so that `run_completed`
    // events have the same `encr`-prefixed payload shape that the node:vm
    // engine's `dehydrateWorkflowReturnValue` produces.
    try {
      await terminalCreateEvent({
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          output: await encryptSerializedData(
            result.completed.result,
            encryptionKey
          ),
        },
      });
      wfdiag('exit_completed', { result: 'run_completed_written' });
      scheduleSnapshotDelete();
    } catch (err) {
      if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
        runtimeLogger.warn(
          'Workflow already finished, skipping run_completed',
          { workflowRunId: runId }
        );
        wfdiag('exit_completed', { result: 'already_finished' });
        scheduleSnapshotDelete();
        return;
      }
      wfdiag('exit_completed_error', {
        errorName: (err as Error)?.name,
        errorMessage: (err as Error)?.message,
      });
      throw err;
    }
    dispatchRunCompletedHooks(runId, workflowName);
  } else if (result.suspended) {
    // Workflow still suspended after the inline loop. All durable side
    // effects for the final suspension state were already dispatched by
    // the loop; what remains is deciding how the run gets re-invoked.
    const { pendingOperations } = result.suspended;

    runtimeLogger.info('QuickJS runtime: workflow suspended', {
      workflowRunId: runId,
      inlineStepsExecuted,
      pendingSteps: pendingOperations.filter((p) => p.type === 'step').length,
      pendingWaits: pendingOperations.filter((p) => p.type === 'wait').length,
      pendingOps: pendingOperations.map((p) => ({
        type: p.type,
        correlationId: p.correlationId,
        hasCreatedEvent: p.hasCreatedEvent,
        ...(p.type === 'step' ? { stepId: (p as PendingStep).stepId } : {}),
      })),
    });

    parentSpan?.setAttributes({
      ...Attribute.QuickJSOutcome('suspended'),
      ...Attribute.QuickJSPendingOpsCount(pendingOperations.length),
    });

    if (runGone) {
      // The run no longer exists (expired / cancelled / deleted) —
      // nothing to drive, and its snapshot is dead weight.
      scheduleSnapshotDelete();
      wfdiag('exit_suspended', { action: 'run_gone' });
      return;
    }

    if (throttledReplaySeconds !== undefined) {
      // A throttled lazy inline claim: replay after the backoff (a
      // fresh message, for the reasons given below) so the step
      // re-runs inline with its input. Checked before the immediate-requeue
      // exits, which would retry the throttled write with no backoff. Waits
      // are covered: the loop armed the soonest wait's continuation before
      // running the batch.
      wfdiag('exit_suspended', {
        action: 'throttled_step_deferred_replay',
        timeoutSeconds: throttledReplaySeconds,
      });
      await queueMessage(
        world,
        getWorkflowQueueName(workflowRun.workflowName, namespace),
        {
          runId,
          traceCarrier: await nextTraceCarrier(),
          requestedAt: new Date(),
        },
        { delaySeconds: throttledReplaySeconds }
      );
      return;
    }

    // Exit requeues are FRESH messages, never a `{ timeoutSeconds }`
    // visibility-redelivery of the current message. Redelivering the
    // CURRENT message is a trap: a hook-resume delivery carries
    // `hookInput`, and its redelivery re-runs the lazy-resume re-ensure
    // in the handler prologue: if the workflow disposed that hook
    // during this invocation (dispose → sleep), a world that rejects
    // the re-ensure would ack the message as "nothing left to resume"
    // and the continuation it carried is silently lost. A fresh message
    // carries only `runId`, so its delivery always reaches replay (and
    // under turbo a reschedule would re-engage turbo against a stale
    // preloaded log: see the reinvoke() docs in runtime.ts).
    const requeueImmediately = async (): Promise<void> => {
      await queueMessage(
        world,
        getWorkflowQueueName(workflowRun.workflowName, namespace),
        {
          runId,
          traceCarrier: await nextTraceCarrier(),
          requestedAt: new Date(),
        }
      );
    };

    if (budget.isExhausted()) {
      // The loop stopped on the replay budget with progress still
      // possible, so continue in a fresh invocation.
      wfdiag('exit_suspended', { action: 'budget_exhausted_requeue' });
      await requeueImmediately();
      return;
    }

    // Exit wait sweep. A wait that elapsed in the window since the
    // loop's last check requeues immediately (its wait_completed is
    // written by the next invocation's elapsed-wait pass); pending waits
    // whose continuation the loop already enqueued are skipped.
    let soonestWait: { seconds: number; correlationId: string } | undefined;
    let hasElapsedWait = false;
    for (const op of pendingOperations) {
      if (op.type !== 'wait') continue;
      const wait = op as PendingWait;
      const resumeMs = new Date(wait.resumeAt).getTime() - Date.now();
      if (resumeMs <= 0) {
        hasElapsedWait = true;
      } else if (
        !scheduledWaitContinuations.has(wait.correlationId) &&
        armsWaitTimer(wait.correlationId)
      ) {
        const timeoutSeconds = Math.max(1, Math.ceil(resumeMs / 1000));
        if (!soonestWait || timeoutSeconds < soonestWait.seconds) {
          soonestWait = {
            seconds: timeoutSeconds,
            correlationId: wait.correlationId,
          };
        }
      }
    }

    if (hasElapsedWait) {
      wfdiag('exit_suspended', { action: 'wait_elapsed_requeue' });
      await requeueImmediately();
      return;
    }

    if (pendingRequeueSignal) {
      // This invocation wrote events the workflow needs to consume
      // (attr_set / getConflict-awaited hook_created / inline step
      // terminals) but the eventually-consistent listing never returned
      // them before the loop exited. Without a requeue the run would
      // park awaiting_external with its unblocking events already
      // durably written and no future invocation coming, so requeue
      // immediately so a fresh read picks them up. In the common case
      // the loop's own feed observes the writes and clears this flag, so
      // this only fires when the read actually lagged.
      wfdiag('exit_suspended', { action: 'unread_self_write_requeue' });
      await requeueImmediately();
      return;
    }

    if (soonestWait) {
      // Delayed continuation for the soonest pending wait the loop has
      // not already scheduled. The dispatch helper handles delay
      // clamping (long waits chain across hops) and idempotency-key
      // dedup of re-observations of the same pending wait. See
      // runtime/wait-continuation.ts.
      wfdiag('exit_suspended', {
        action: 'schedule_wait_timeout',
        timeoutSeconds: soonestWait.seconds,
        waitCorrelationId: soonestWait.correlationId,
      });
      scheduledWaitContinuations.add(soonestWait.correlationId);
      await queueWaitTimer(soonestWait.correlationId, soonestWait.seconds);
      return;
    }

    wfdiag('exit_suspended', {
      action: 'awaiting_external',
      pendingOpsCount: pendingOperations.length,
    });
  } else if (result.failed) {
    // Workflow failed, so remap stack trace using inline source maps.
    // Frames carry the run's workflowId as their filename on the fresh
    // path, but the workflow-independent BASELINE_BUNDLE_FILENAME on the
    // snapshot path (the name is baked into the shared baseline's
    // compiled code at hydrate), so remap against both. remapErrorStack
    // early-exits on a cheap includes() when a filename has no frames.
    let errorStack = result.failed.stack;
    if (errorStack) {
      const parsedName = parseWorkflowName(workflowName);
      const filename = parsedName?.moduleSpecifier || workflowName;
      errorStack = remapErrorStack(errorStack, filename, workflowCode);
      errorStack = remapErrorStack(
        errorStack,
        BASELINE_BUNDLE_FILENAME,
        workflowCode
      );
    }

    // Classify the error so consumers (`run.returnValue`, observability)
    // get `USER_ERROR` / `RUNTIME_ERROR` on `error.cause.code`, matching
    // what the node:vm engine already does in runtime.ts.
    //
    // The VM serializes errors as `{ name, message, stack }`, so we
    // reconstruct a host-side Error of the correct class based on the
    // VM-side `name`: specific WorkflowRuntimeError subclasses need
    // to be preserved so classifyRunError() tags them as RUNTIME_ERROR.
    const reconstructed: Error =
      result.failed.name === 'WorkflowNotRegisteredError'
        ? new WorkflowNotRegisteredError(workflowName)
        : result.failed.name === 'Error'
          ? new Error(result.failed.message)
          : Object.assign(new Error(result.failed.message), {
              name: result.failed.name,
            });
    const errorCode = classifyRunError(reconstructed);

    runtimeLogger.error('QuickJS runtime: workflow failed', {
      workflowRunId: runId,
      errorName: result.failed.name,
      errorMessage: result.failed.message,
      errorStack,
      errorCode,
    });
    parentSpan?.setAttributes({
      ...Attribute.QuickJSOutcome('failed'),
    });

    // Flush leftover pending side effects before writing run_failed,
    // same drain semantics as the completed branch.
    if (result.failed.drainOperations?.length) {
      try {
        await dispatchPendingOps({
          world,
          runId,
          workflowRun,
          encryptionKey,
          namespace,
          nextTraceCarrier,
          createEvent: terminalCreateEvent,
          skipStepCreation: new Set([
            ...inlineCreatedStepIds,
            ...queuedStepIds,
            ...executedStepIds,
          ]),
          writtenOpIds,
          pendingOperations: result.failed.drainOperations,
          wfdiag,
        });
      } catch (err) {
        runtimeLogger.warn('QuickJS runtime: terminal drain failed', {
          workflowRunId: runId,
          message: (err as Error)?.message,
        });
      }
    }

    // Create run_failed event. Serialize the error through the
    // first-class dehydration pipeline so consumers (CLI, observability,
    // run.returnValue) get the same hydrated value shape as the node:vm
    // engine emits. Two paths:
    //   * Modern (valueBytes present): the VM-side rejection handler
    //     serialized the original thrown value (Error subclass with
    //     cause chain, plain object, primitive, etc.) using the VM's
    //     workflow-serialize. Pass those bytes through directly so
    //     type identity, cause chains, and non-Error throws survive.
    //     Apply encryption if configured (the VM's
    //     serializer doesn't have access to the encryption key).
    //   * Legacy fallback: reconstruct an Error from the host-visible
    //     {name, message, stack} fields and run it through
    //     `dehydrateRunError`. Used when valueBytes is absent (e.g.
    //     extractError pseudo-failures from VM bootstrap).
    let dehydratedError: Uint8Array;
    if (result.failed.valueBytes) {
      // Hydrate the VM-side bytes, remap the error stack with the
      // host-side source map (the VM can't do this: it lacks both the
      // source map and `remapErrorStack`), and re-dehydrate. This
      // preserves the original value's type identity / cause chain
      // while fixing up frames to point at the user's source files.
      try {
        const hydrated = await hydrateRunError(
          result.failed.valueBytes,
          runId,
          undefined // VM bytes are unencrypted
        );
        if (
          hydrated &&
          typeof hydrated === 'object' &&
          'stack' in (hydrated as object) &&
          typeof (hydrated as { stack?: unknown }).stack === 'string'
        ) {
          const parsedName = parseWorkflowName(workflowName);
          const filename = parsedName?.moduleSpecifier || workflowName;
          // Both filename spaces. See the failed-branch comment above.
          (hydrated as { stack?: string }).stack = remapErrorStack(
            remapErrorStack(
              (hydrated as { stack: string }).stack,
              filename,
              workflowCode
            ),
            BASELINE_BUNDLE_FILENAME,
            workflowCode
          );
        }
        // Walk the cause chain and remap nested stacks too.
        const seen = new WeakSet<object>();
        let node = (hydrated as { cause?: unknown })?.cause;
        while (node && typeof node === 'object' && !seen.has(node as object)) {
          seen.add(node as object);
          const nodeStack = (node as { stack?: unknown }).stack;
          if (typeof nodeStack === 'string') {
            const parsedName = parseWorkflowName(workflowName);
            const filename = parsedName?.moduleSpecifier || workflowName;
            // Both filename spaces. See the failed-branch comment above.
            (node as { stack?: string }).stack = remapErrorStack(
              remapErrorStack(nodeStack, filename, workflowCode),
              BASELINE_BUNDLE_FILENAME,
              workflowCode
            );
          }
          node = (node as { cause?: unknown }).cause;
        }
        dehydratedError = await dehydrateRunError(
          hydrated,
          runId,
          encryptionKey
        );
      } catch (rehydrateErr) {
        // If hydration / re-dehydration fails for any reason, fall
        // back to passing through the original VM bytes (applying
        // encryption if configured). Better to lose source-mapped
        // frames than to lose the error entirely.
        runtimeLogger.warn(
          'QuickJS runtime: failed to remap workflow error stack, passing VM bytes through',
          {
            workflowRunId: runId,
            message: (rehydrateErr as Error)?.message,
          }
        );
        dehydratedError = (await maybeEncrypt(
          result.failed.valueBytes,
          encryptionKey
        )) as Uint8Array;
      }
    } else {
      if (errorStack) {
        reconstructed.stack = errorStack;
      }
      try {
        dehydratedError = await dehydrateRunError(
          reconstructed,
          runId,
          encryptionKey
        );
      } catch (serErr) {
        // Fall back to a minimal payload so the run still terminates
        // even when the error itself contains unserializable values.
        runtimeLogger.warn(
          'QuickJS runtime: failed to dehydrate run error, falling back to bare Error',
          { workflowRunId: runId, message: (serErr as Error)?.message }
        );
        dehydratedError = await dehydrateRunError(
          Object.assign(new Error(result.failed.message), {
            name: result.failed.name,
          }),
          runId,
          encryptionKey
        );
      }
    }
    try {
      await terminalCreateEvent({
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          error: dehydratedError,
          errorCode,
        },
      });
      scheduleSnapshotDelete();
    } catch (err) {
      if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
        runtimeLogger.warn('Workflow already finished, skipping run_failed', {
          workflowRunId: runId,
        });
        wfdiag('exit_failed', { result: 'already_finished' });
        scheduleSnapshotDelete();
        return;
      }
      wfdiag('exit_failed_error', {
        errorName: (err as Error)?.name,
        errorMessage: (err as Error)?.message,
      });
      throw err;
    }
    dispatchRunFailedHooks(
      runId,
      workflowName,
      dehydratedError,
      encryptionKey,
      errorCode
    );
    wfdiag('exit_failed', { result: 'run_failed_written' });
  }
}
