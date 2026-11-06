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
  MaxEventsExceededError,
  RunExpiredError,
  WorkflowNotRegisteredError,
  WorkflowRuntimeError,
} from '@workflow/errors';

import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type EventBatchResult,
  type EventResult,
  eventIdToSlot,
  ROOT_RUN_ID_ATTRIBUTE,
  type RunInput,
  type SerializedData,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotMetadata,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { classifyRunError } from '../../classify-error.js';
import type { QueueItem } from '../../global.js';
import { runtimeLogger } from '../../logger.js';
import { getStepFunction } from '../../private.js';
import {
  deriveRunPayloadKeys,
  encrypt as encryptSerializedData,
} from '../../serialization/encryption.js';
import {
  dehydrateRunError,
  hydrateRunError,
  maybeEncrypt,
} from '../../serialization.js';
import { remapErrorStack, stripInlineSourceMap } from '../../source-map.js';
import * as Attribute from '../../telemetry/semantic-conventions.js';
import { serializeTraceCarrier, trace } from '../../telemetry.js';
import { afterRunCompleted, afterRunFailed } from '../after-terminal-write.js';
import { COMPUTE_INSTANCE_ID } from '../compute-instance.js';
import {
  DEFAULT_STEP_MAX_RETRIES,
  getMaxInlineSteps,
  getOpenWaitClockSkewMs,
  isOptimisticInlineStartExplicitlyDisabled,
  MAX_BATCH_EVENTS,
  MAX_IN_BAND_CREATION_BATCH_BYTES,
} from '../constants.js';
import { maybeWarnApproachingEventLimit } from '../event-limit-warning.js';
import { getPortLazy } from '../get-port-lazy.js';
import {
  getWorkflowQueueName,
  maxEventSlot,
  queueMessage,
  REPLAY_RESOLVE_DATA,
} from '../helpers.js';
import { republishOwedForceClaimVictimWakes } from '../hook-wake.js';
import { observeOutOfBandWriters } from '../out-of-band-observation.js';
import { quickjsWasiVersion } from '../quickjs-assets.generated.js';
import {
  type EventCreator,
  isFirstInvocation,
  latchOversizedSnapshotRun,
  listRunLogFrom,
  noteSnapshotThresholdProgress,
  oversizedSnapshotRuns,
  runsBelowSnapshotThreshold,
  tick,
  warnOnce,
} from '../quickjs-delivery-shared.js';
import { QuickJSLogView } from '../quickjs-log-view.js';
import {
  type CreationBatches,
  dispatchPendingOps,
} from '../quickjs-pending-ops.js';
import {
  BASELINE_BUNDLE_FILENAME,
  type PendingHook,
  type PendingOperation,
  type PendingStep,
  type PendingWait,
  type QuickJSOpenHook,
  startQuickJSWorkflow,
} from '../quickjs-runtime.js';
import {
  checkSnapshotMetadataBounds,
  MAX_SNAPSHOT_PLAINTEXT_BYTES,
  openSnapshot,
  SnapshotRejectedError,
  sealSnapshot,
} from '../quickjs-snapshot-codec.js';
import { ReplayBudget } from '../replay-budget.js';
import {
  getSnapshotThresholdForHandler,
  isSnapshotThresholdConfigured,
  isUnencryptedSnapshottingAllowed,
} from '../vm-mode.js';
import { getNearDueWaitWindowSeconds } from '../wait-continuation.js';
import { safeWaitUntil } from '../wait-until.js';
import { getWorld } from '../world.js';
import {
  chainTimersBeforeCompletion,
  ownedWaitChains,
  schedulesWaitTimer,
  stepsToReenqueue,
  waitCreatorMessageId,
  waitTimersToArm,
  withRetryCreator,
} from './creator-rules.js';
import {
  getInlineStepDeadlineMarginMs,
  mayStartInlineStep,
} from './deadline.js';
import {
  type InBandWriter,
  OrchestratorSupersededError,
} from './in-band-writer.js';
import {
  getOrchestratorFeedPollIntervalMs,
  getOrchestratorLingerMsFor,
  getOrchestratorPollIntervalMs,
  LiveLogFeed,
} from './live-feed.js';
import {
  analyzeLogSteps,
  type ExternalWork,
  externalWorkOf,
  type LogStepState,
  MAX_STEP_MESSAGE_INPUT_BYTES,
  openWaits,
  type StepMessageSpec,
  stepCreationOf,
} from './log-state.js';
import {
  getOrchestratorReadTimeoutMs,
  readWithDeadline,
} from './read-deadline.js';
import {
  disableRunAheadFor,
  type RunAheadContext,
  RunAheadStopError,
  runAheadContextFor,
  runAheadHazard,
} from './run-ahead.js';
import {
  type CallerStart,
  executeStep,
  mayRunBeforeItsStart,
  type StepExecutionResult,
} from './step-executor.js';
import {
  sendStepDispatchMessages,
  stepDispatchMessage,
} from './step-message.js';
import {
  retryOutlivesMessage,
  stepMessageRetentionSeconds,
} from './step-retention.js';
import { runStepSingleFlight } from './step-single-flight.js';
import { creationBatchBytes } from './step-wait-creation.js';
import {
  nearDueTimerIdempotencyKey,
  rearmsCoalescableTimer,
  sendNearDueTimerOnce,
  waitTimerMessage,
} from './wait-timer.js';

/** A QuickJS pending step as the shared step message's spec. */
function stepMessageSpecOf(
  step: PendingStep,
  fields: {
    stepInput?: Uint8Array;
    stepAttempt?: number;
    stepCreatedEventId?: string;
    stepCreatedAt?: Date;
    resent?: boolean;
  }
): StepMessageSpec {
  return {
    correlationId: step.correlationId,
    stepName: step.stepId,
    ...(fields.resent ? { resent: true } : {}),
    ...(fields.stepInput !== undefined ? { input: fields.stepInput } : {}),
    ...(fields.stepAttempt !== undefined
      ? { stepAttempt: fields.stepAttempt }
      : {}),
    ...(fields.stepCreatedEventId
      ? { stepCreatedEventId: fields.stepCreatedEventId }
      : {}),
    ...(fields.stepCreatedAt ? { stepCreatedAt: fields.stepCreatedAt } : {}),
  };
}

/**
 * Sends the messages of `steps` as the node engine dispatches a pass's steps
 * (see `sendStepDispatchMessages`). Rejects if any message failed to go out;
 * the ones that did are reported through `onSent`.
 */
async function queueStepMessages(params: {
  world: Awaited<ReturnType<typeof getWorld>>;
  workflowRun: WorkflowRun;
  steps: readonly {
    step: PendingStep;
    stepAttempt?: number;
    stepCreatedAt?: Date;
    resent?: boolean;
  }[];
  namespace: string | undefined;
  nextTraceCarrier: () => Promise<Record<string, string>>;
  onSent?: (correlationId: string) => void;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<void> {
  const { world, workflowRun, steps, namespace, wfdiag } = params;
  if (steps.length === 0) return;
  const traceCarrier = await params.nextTraceCarrier();
  await sendStepDispatchMessages(
    world,
    getWorkflowQueueName(workflowRun.workflowName, namespace),
    steps,
    ({ step, stepAttempt, stepCreatedAt, resent }) =>
      stepDispatchMessage({
        run: workflowRun,
        step: stepMessageSpecOf(step, { stepAttempt, stepCreatedAt, resent }),
        traceCarrier,
      }),
    (batch) => {
      for (const { step } of batch) {
        params.onSent?.(step.correlationId);
        wfdiag('step_queued', {
          stepId: step.stepId,
          correlationId: step.correlationId,
          purpose: 'dispatch',
          delaySeconds: 0,
        });
      }
    }
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
  workflowRun: WorkflowRun;
  step: PendingStep;
  delaySeconds?: number;
  /** Queue namespace for the publish (see runtime.ts). */
  namespace: string | undefined;
  /** Run-origin trace carrier accessor (see runWorkflowWithQuickJS). */
  nextTraceCarrier: () => Promise<Record<string, string>>;
  /**
   * The serialized (possibly encrypted) step input to carry on the message
   * as `stepInput`, so the step handler need not read its `step_created`
   * back. Only set on `dispatch` publishes of a step whose `step_created`
   * this invocation already committed.
   */
  stepInput?: Uint8Array;
  /** The attempt the message starts with, when above 1. */
  stepAttempt?: number;
  /** Event id of the step's `step_created`, for reading its input back. */
  stepCreatedEventId?: string;
  /** `createdAt` of the step's `step_created`, carried on a first-attempt
   *  message as `stepCreatedAt` (see `stepCreatedAtField`). */
  stepCreatedAt?: Date;
  /** Called once the message went out. */
  onSent?: (correlationId: string) => void;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<void> {
  const {
    world,
    workflowRun,
    step,
    delaySeconds,
    namespace,
    nextTraceCarrier,
    stepInput,
    wfdiag,
  } = params;
  const traceCarrier = await nextTraceCarrier();
  await sendStepDispatchMessages(
    world,
    getWorkflowQueueName(workflowRun.workflowName, namespace),
    [step],
    () =>
      stepDispatchMessage({
        run: workflowRun,
        step: stepMessageSpecOf(step, {
          stepInput,
          stepAttempt: params.stepAttempt,
          stepCreatedEventId: params.stepCreatedEventId,
          stepCreatedAt: params.stepCreatedAt,
        }),
        traceCarrier,
        delaySeconds,
      })
  );
  params.onSent?.(step.correlationId);
  wfdiag('step_queued', {
    stepId: step.stepId,
    correlationId: step.correlationId,
    purpose: 'dispatch',
    delaySeconds: delaySeconds ?? 0,
  });
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
   * the queue handler's metadata; 1 = first delivery). A redelivery may own
   * wait chains a crashed delivery left (see `ownedWaitChains`), and the
   * step re-send rule reads it.
   */
  deliveryAttempt?: number;
  /**
   * Whether this delivery may hold an orchestrator message the queue
   * coalesced into it (any delivery but its message's first), and so arms
   * the near-due waits of chains it does not own on exit (see
   * `armNearDueTimers` in `delivery.ts`). Absent: it may.
   */
  armsNearDueWaits?: boolean;
  /**
   * Epoch ms of the invocation's inline deadline: its start plus its inline
   * window (`WORKFLOW_V2_TIMEOUT_MS`), as on the node engine. A turn that
   * begins at or past it starts nothing more and continues the run in the
   * next delivery (`continueInNextDelivery`). Within the inline-start margin
   * before it (`WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS`), new steps are
   * background steps instead of inline ones, and a delivery with nothing
   * left to run does not linger for work done elsewhere (see
   * `getOrchestratorLingerMsFor`). Absent (standalone callers): no deadline
   * and no lingering.
   */
  inlineDeadlineMs?: number;
  /**
   * Continues the run in a fresh delivery once this one ends: a handoff of
   * the delivery's message (`{ timeoutSeconds: 0 }`). Absent (standalone
   * callers): a new orchestrator message.
   */
  continueInNextDelivery?: () => Promise<void>;
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
   * Run-ahead depth for this delivery (`WORKFLOW_RUN_AHEAD_DEPTH`, or 0 when
   * run-ahead is off for it; see `runtime/out-of-band-observation.ts`): at an
   * inert boundary, at most this many inline step outcomes reach the VM
   * before their writes commit. Absent or 0, or without a `writer`: off.
   */
  runAheadDepth?: number;
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
  /**
   * Called once a step's message went out, with the step's correlation id.
   * The delivery keeps what its committed writes still owe the queue, and
   * sends that itself if it ends early (a fence refusal).
   */
  onStepMessageSent?: (correlationId: string) => void;
  /** Called once a wait's timer message went out, with the wait's id. */
  onWaitTimerSent?: (correlationId: string) => void;
  /**
   * The steps of a log whose message this delivery sends again (see
   * `stepsToReenqueue`), once per invocation. Absent (standalone callers):
   * the re-send rule applied to `deliveryAttempt` on every pass.
   */
  stepResends?: (events: readonly Event[]) => ReadonlySet<string>;
  /** Called for each step whose message this delivery sends again. */
  onStepResent?: (correlationId: string) => void;
  /**
   * A delivery of a message the World sent after it lost its queue: every
   * open wait's chain is this delivery's to arm (see `stepsToReenqueue` for
   * the steps).
   */
  recovery?: boolean;
  /**
   * Waits whose `wait_completed` this delivery committed, filled by the
   * delivery from its writer's accepted events; this engine adds its own
   * completions too. Their chains are this delivery's to arm (see
   * `ownedWaitChains`).
   */
  completedWaits?: Set<string>;
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
    armsNearDueWaits = true,
    ownerMessageId,
    requestId,
    namespace,
    waitContinuation,
    turbo,
  } = params;
  /** See `stepResends` in the params. */
  const stepResends =
    params.stepResends ??
    ((events: readonly Event[]) =>
      new Set(
        stepsToReenqueue({
          events,
          deliveryCount: deliveryAttempt,
          nowMs: Date.now(),
        }).resend
      ));

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
   * Whether this delivery may arm the timer of the wait `correlationId`: it
   * is in a wait chain this delivery owns, this delivery is about to write
   * it, or this is the wait's own timer delivery (see `ownedWaitChains` and
   * `schedulesWaitTimer`). Other deliveries leave the timer alone, so timer
   * messages do not pile up across suspensions. Assigned once the log is
   * loaded.
   */
  let armsWaitTimer: (correlationId: string) => boolean = () => true;
  /** The chain a wait is in: its creator, or this delivery's own message. */
  let waitChainEvent: (correlationId: string) => Event | undefined = () =>
    undefined;
  /** Waits whose `wait_completed` this delivery committed. */
  const completedWaits = params.completedWaits ?? new Set<string>();
  /** Waits whose timer this invocation sent. */
  const scheduledWaitContinuations = new Set<string>();
  /**
   * A timer wake: delayed, and keyed by its hop (`waitTimerMessage`), or, a
   * near-due re-arm, by the sender's second (`nearDueTimerIdempotencyKey`).
   */
  const queueWaitTimer = async (
    correlationId: string,
    seconds: number,
    resumeAtMs: number,
    options: { nearDue?: boolean } = {}
  ): Promise<void> => {
    const nowMs = Date.now();
    const attempt = nextWaitContinuationAttempt(correlationId);
    const timer = waitTimerMessage({
      correlationId,
      resumeAtMs,
      seconds,
      nowMs,
      attempt,
    });
    const send = async (idempotencyKey: string) =>
      queueMessage(
        world,
        getWorkflowQueueName(workflowRun.workflowName, namespace),
        {
          runId,
          traceCarrier: await nextTraceCarrier(),
          requestedAt: new Date(),
          waitContinuation: timer.waitContinuation,
        },
        {
          specVersion: workflowRun.specVersion,
          delaySeconds: timer.delaySeconds,
          idempotencyKey,
        }
      );
    if (
      options.nearDue ||
      rearmsCoalescableTimer({
        mayHoldCoalescedTimer: armsNearDueWaits,
        intermediate: timer.waitContinuation.resumeAtMs !== undefined,
        attempt,
      })
    ) {
      const key = nearDueTimerIdempotencyKey({
        correlationId,
        resumeAtMs,
        nowMs,
      });
      await sendNearDueTimerOnce(key, () => send(key));
    } else {
      await send(timer.idempotencyKey);
    }
    params.onWaitTimerSent?.(correlationId);
  };
  /**
   * Arms the timer of each candidate `waitTimersToArm` picks (the earliest
   * open wait of each chain, and the wait a timer delivery is for) that
   * this delivery has not armed yet.
   */
  const armWaitTimers = async (
    candidates: readonly {
      correlationId: string;
      resumeAtMs: number;
      seconds: number;
    }[]
  ): Promise<void> => {
    // The earliest of each chain is picked before the waits this delivery
    // armed are left out: a chain whose earliest wait has its timer needs no
    // other.
    const owned = candidates
      .filter(
        (wait) =>
          !completedWaits.has(wait.correlationId) &&
          armsWaitTimer(wait.correlationId)
      )
      .map((wait) => ({ ...wait, event: waitChainEvent(wait.correlationId) }));
    for (const wait of waitTimersToArm(
      owned,
      ownerMessageId ?? '',
      waitContinuation?.correlationId
    )) {
      if (scheduledWaitContinuations.has(wait.correlationId)) continue;
      scheduledWaitContinuations.add(wait.correlationId);
      await queueWaitTimer(wait.correlationId, wait.seconds, wait.resumeAtMs);
      wfdiag('wait_continuation_scheduled', {
        correlationId: wait.correlationId,
        delaySeconds: wait.seconds,
      });
    }
  };
  /**
   * Arms the next timer of each wait chain of another message whose wait
   * this delivery completed, right after the completion: the delivery may
   * end in a handoff before any later sweep, and the next delivery does not
   * know which waits this one completed.
   */
  const armCompletedChains = async (log: readonly Event[]): Promise<void> => {
    const now = Date.now();
    await armWaitTimers(
      openWaits(log)
        .filter((wait) => {
          const creator = waitCreatorMessageId(wait.event);
          return creator !== undefined && creator !== ownerMessageId;
        })
        .map((wait) => ({
          correlationId: wait.correlationId,
          resumeAtMs: wait.resumeAtMs,
          seconds: Math.max(1, Math.ceil((wait.resumeAtMs - now) / 1000)),
        }))
    );
  };
  /**
   * Sends, before this delivery commits the `wait_completed` of each wait in
   * `completing`, the next timer of each of their chains
   * (`chainTimersBeforeCompletion`): a failure after the commit would leave
   * the redelivery not knowing this delivery completed the wait.
   */
  const armChainsBeforeCompletion = async (
    log: readonly Event[],
    completing: readonly string[]
  ): Promise<void> => {
    if (completing.length === 0) return;
    const now = Date.now();
    for (const wait of chainTimersBeforeCompletion({
      openWaits: openWaits(log),
      completing,
    })) {
      if (scheduledWaitContinuations.has(wait.correlationId)) continue;
      scheduledWaitContinuations.add(wait.correlationId);
      const seconds = Math.max(1, Math.ceil((wait.resumeAtMs - now) / 1000));
      try {
        await queueWaitTimer(wait.correlationId, seconds, wait.resumeAtMs);
      } catch (err) {
        scheduledWaitContinuations.delete(wait.correlationId);
        throw err;
      }
      wfdiag('wait_continuation_scheduled', {
        correlationId: wait.correlationId,
        delaySeconds: seconds,
        beforeCompletion: true,
      });
    }
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
    const read = await listRunLogFrom(
      world,
      runId,
      snapshotCursor,
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
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
  /**
   * Checks the events a World handed back on a write before they are
   * absorbed. Run-ahead sets it once its state exists (see
   * `checkRunAheadHazard`); no write before that runs ahead of anything.
   */
  let screenWrittenEvents: (
    events: readonly Event[] | undefined,
    source: string
  ) => void = () => {};
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
  waitChainEvent = (correlationId) =>
    events.find(
      (event) =>
        event.eventType === 'wait_created' &&
        event.correlationId === correlationId
    );
  armsWaitTimer = (correlationId) =>
    ownerMessageId === undefined ||
    params.recovery === true ||
    schedulesWaitTimer({
      wait: waitChainEvent(correlationId),
      correlationId,
      timerFor: waitContinuation?.correlationId,
      ownedChains: ownedWaitChains({
        events,
        messageId: ownerMessageId,
        completedWaits,
        timerFor: waitContinuation?.correlationId,
        redelivery: deliveryAttempt !== 1,
      }),
    });
  /**
   * A new inline step's creation: its first attempt's `step_started`,
   * carrying what a `step_created` carries (see `createInlineStep`).
   */
  const inlineCreationEvent = (
    step: PendingStep,
    input: SerializedData
  ): CreateEventRequest => ({
    eventType: 'step_started',
    specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    correlationId: step.correlationId,
    eventData: {
      stepName: step.stepId,
      workflowName: workflowRun.workflowName,
      input,
      inline: true,
      attempt: 1,
    },
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
      screenWrittenEvents(result.events, 'inline delta');
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
    screenWrittenEvents(result.events, 'skipped-slot report');
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
  /**
   * Sends one creation batch of a pass (see `CreationBatches`) through the
   * in-band writer and folds it into the log view as {@link createEvent}
   * folds a single write: the batch's skipped-slot report, then each
   * committed creation. Absent without a writer or a World `createBatch`.
   */
  const writeCreationBatch = params.writer?.supportsBatch
    ? async (events: CreateEventRequest[]) => {
        const written = await params.writer!.createBatch(
          events.map((event) => ({ event })),
          {
            ...(requestId ? { requestId } : {}),
            ...logView.snapshotParams(),
          }
        );
        screenWrittenEvents(written.events, 'skipped-slot report');
        const report = logView.absorb({
          events: written.events,
          hasMore: written.hasMore,
        });
        if (report.truncated) {
          runtimeLogger.debug(
            'QuickJS runtime: dropped a truncated skipped-slot report',
            {
              workflowRunId: runId,
              eventType: 'creation_batch',
              offered: written.events?.length ?? 0,
            }
          );
        }
        for (const item of written.results) {
          if (item.error !== undefined) continue;
          logView.absorb(
            { event: item.event },
            { deliverEvent: deliversOwnEvent(item.event.eventType) }
          );
        }
        return written;
      }
    : undefined;

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
  maybeWarnApproachingEventLimit({
    runId,
    workflowName,
    eventCount: restoredEventCount + events.length,
    limit: maxEventsLimit,
    isQuickJS: true,
  });

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
  const isElapsedWait = (event: Event): boolean => {
    if (
      event.eventType !== 'wait_created' ||
      !event.correlationId ||
      completedWaitIds.has(event.correlationId)
    ) {
      return false;
    }
    const resumeAt = (event.eventData as Record<string, unknown> | undefined)
      ?.resumeAt;
    return (
      !!resumeAt &&
      (now >= new Date(resumeAt as string).getTime() ||
        params.wakeUpWaits?.has(event.correlationId) === true)
    );
  };
  await armChainsBeforeCompletion(
    events,
    events.filter(isElapsedWait).map((event) => event.correlationId!)
  );
  for (const event of events) {
    if (!isElapsedWait(event) || event.eventType !== 'wait_created') continue;
    const correlationId = event.correlationId!;
    try {
      const result = await createEvent({
        eventType: 'wait_completed',
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        correlationId,
        eventData: { resumeAt: new Date(event.eventData.resumeAt) },
      });
      completedWaits.add(correlationId);
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
  // The VM has not started, so whatever those writes handed back (each
  // wait_completed, plus anything another writer appended that they skipped
  // over) joins the initial log instead of waiting for a feed.
  events.push(...logView.takeContiguous());
  if (completedWaits.size > 0) await armCompletedChains(events);

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
    const read = await listRunLogFrom(
      world,
      runId,
      null,
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
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
  const maxInlineSteps = getMaxInlineSteps();
  const inlineMarginMs = getInlineStepDeadlineMarginMs();
  /** Whether an inline step may still start (see `inlineDeadlineMs`). */
  const mayInlineNow = (): boolean =>
    mayStartInlineStep({
      nowMs: Date.now(),
      deadlineMs: params.inlineDeadlineMs,
      marginMs: inlineMarginMs,
    });
  // Set when a turn began at or past the invocation's inline deadline: the
  // run continues in the next delivery.
  let deadlineReached = false;
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
   * Steps whose outcome the VM has been fed. Under run-ahead an outcome can
   * reach the VM before its body's settlement is acted on, and that
   * settlement must not then ask for a fresh read of it.
   */
  const fedOutcomeStepIds = new Set<string>();
  const noteFedOutcomes = (fed: readonly Event[]): void => {
    for (const e of fed) {
      if (
        (e.eventType === 'step_completed' || e.eventType === 'step_failed') &&
        e.correlationId
      ) {
        fedOutcomeStepIds.add(e.correlationId);
      }
    }
  };
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
      // Under the orchestrator's read deadline, for the reason
      // `loadAfter` in delivery.ts gives: a held read would hold the run.
      const pageCursor = cursor ?? undefined;
      const response = await readWithDeadline(
        (signal) =>
          world.events.list({
            runId,
            pagination: {
              sortOrder: 'asc',
              cursor: pageCursor,
              limit: 1000,
            },
            resolveData: REPLAY_RESOLVE_DATA,
            specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
            ...(signal ? { signal } : {}),
          }),
        {
          timeoutMs: getOrchestratorReadTimeoutMs(),
          label: 'Event log read',
          runId,
        }
      );
      for (const e of response.data) {
        // Before the id check: the event at a speculative position has the
        // id the speculative one was given.
        logView.screen(e);
        screenWrittenEvents([e], 'listing');
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
    noteFedOutcomes(unseen);
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
    noteFedOutcomes(queued);
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
      feedPollIntervalMs: getOrchestratorFeedPollIntervalMs(),
      onEvents: (fed) => {
        fedEventCount += fed.length;
        // The writer is not told of these positions: the feed can echo a
        // write of this delivery before its response, and a position counted
        // twice would push the next run-ahead prediction past the slot it
        // takes. A prediction another writer made stale is refused by the
        // view instead (`queueSpeculative`), and that write is awaited.
        screenWrittenEvents(fed, 'live feed');
        logView.absorb({ events: fed });
        notifyProgress();
      },
      // Ends a linger waiting on a push that will not come.
      onFeedDown: () => notifyProgress(),
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

  // ---- Run-ahead (runtime/out-of-band-observation.ts) ----
  //
  // At a boundary the classification calls inert, an inline step's outcome
  // reaches the VM as soon as its body returns, while its `step_completed` or
  // `step_failed` is still in flight, and the new inline steps of the next
  // boundary start while their creation-bearing `step_started` batch is in
  // flight, so consecutive steps overlap their writes. Every write still
  // goes through the in-band writer, in decision order, as a required write:
  // any failure stops the writer, so nothing is written from a speculative
  // state after it. A speculative event is placed at the position the writer
  // predicts for it and fed to the VM in position order like any other
  // (`QuickJSLogView.queueSpeculative`). At most `runAheadDepth` outcomes are
  // unconfirmed at once.
  //
  // The node engine repairs a speculative write another writer displaced in
  // place. The live VM here cannot take back an event it consumed, so a
  // displacement ends the pass in a `RunAheadStopError` once the writes in
  // flight settled, and `delivery.ts` restarts the delivery in place from a
  // fresh load, with run-ahead off for the rest of it. An event that could
  // change the workflow's path found below a speculative write also stops
  // the writer's further decisions first, as on the node engine.
  const writer = params.writer;
  const runAheadDepth = writer ? Math.max(0, params.runAheadDepth ?? 0) : 0;
  type Speculation = { event: Event; settled: Promise<void> };
  /** Speculative writes in flight, by the position each event holds. */
  const speculationsBySlot = new Map<number, Speculation>();
  /** Speculative events by predicted position, until confirmed there. */
  const placedBySlot = new Map<number, Event>();
  /** Set when a speculative write failed; the pass stops with it. */
  let runAheadFailure: unknown;
  /** Set once a speculative write was displaced; the pass restarts. */
  let runAheadDisplaced: string | undefined;
  /** The classifications under which speculative writes are in flight. */
  const runAheadContexts = new Set<RunAheadContext>();
  /** Steps whose `step_started` is durable (see `mayStillWriteAfterHazard`). */
  const committedStarts = new Set<string>();
  /** Inline steps whose retry moved to their own message. */
  const retriedInBackground = new Set<string>();
  /** Ids of the events this delivery's writes committed. */
  const ownEventIds = new Set<string>();
  /** Whether the latest boundary was classified inert. */
  let boundaryInert = false;
  /**
   * Set when code in the VM read the clock while the VM held a speculative
   * event no write had confirmed at its position. This engine advances its
   * clock to every event it reads, an unread hook payload or an `attr_set`
   * included (`processEvents`, `quickjs-runtime.ts`), so another writer's
   * event landing below a speculative one gives a replay a later
   * `Date.now()` after it than the workflow read. A decision made without
   * reading the clock cannot tell where such an event landed: its payload is
   * buffered, or, for an attribute, invisible to workflow code. One made
   * after a read can, so a boundary that follows one decides only once the
   * speculative events are confirmed (see `classifyBoundary`'s caller), and
   * a displaced one restarts the delivery before anything is decided from
   * it. Cleared once no unconfirmed speculative event is in the VM.
   */
  let clockReadOnSpeculation = false;
  /** Whether the VM holds a speculative event not yet confirmed there. */
  const vmHoldsUnconfirmedSpeculation = (): boolean => {
    const fed = logView.fedThroughSlot;
    if (fed === undefined) return false;
    for (const slot of placedBySlot.keys()) {
      if (slot <= fed) return true;
    }
    return false;
  };
  /**
   * Set once this delivery has seen the run end (another writer's
   * `run_cancelled`, say): nothing more runs ahead, so no body starts ahead
   * of a start the World will refuse. The node engine stops before its next
   * pass on the same event.
   */
  let runEndSeen = false;
  /**
   * Turbo: whether the backgrounded `run_started` has committed. A body
   * started from a creation run-ahead sent does not wait for it the way an
   * optimistic body's writes do (see `StepExecutorParams.runReadyBarrier`),
   * so no creation runs ahead before it.
   */
  let runStartedLanded = turbo === undefined;
  void turbo?.runReadyBarrier.then(
    () => {
      runStartedLanded = true;
    },
    () => {}
  );
  const noteRunEnd = (seen: readonly Event[] | undefined): void => {
    if (
      seen?.some(
        (event) =>
          event.eventType === 'run_cancelled' ||
          event.eventType === 'run_completed' ||
          event.eventType === 'run_failed'
      )
    ) {
      runEndSeen = true;
    }
  };
  noteRunEnd(events);
  const runAheadStats = {
    boundaries: 0,
    drained: 0,
    clockDrained: 0,
    depthCap: 0,
    failureStops: 0,
    hazardStops: 0,
    displaced: 0,
  };
  const recordRunAheadSpan = (): void => {
    if (runAheadDepth <= 0) return;
    parentSpan?.setAttributes({
      'workflow.run_ahead.depth': runAheadDepth,
      'workflow.run_ahead.boundaries': runAheadStats.boundaries,
      'workflow.run_ahead.drained_boundaries': runAheadStats.drained,
      'workflow.run_ahead.clock_drained_boundaries': runAheadStats.clockDrained,
      'workflow.run_ahead.depth_cap_steps': runAheadStats.depthCap,
      'workflow.run_ahead.failure_stops': runAheadStats.failureStops,
      'workflow.run_ahead.hazard_stops': runAheadStats.hazardStops,
      // Displaced speculative writes: repaired in place on the node engine,
      // a restart in place here.
      'workflow.run_ahead.repairs': runAheadStats.displaced,
    });
  };
  const previousOnAccepted = writer?.onAccepted;
  if (writer && runAheadDepth > 0) {
    writer.onAccepted = (event) => {
      ownEventIds.add(event.eventId);
      previousOnAccepted?.(event);
    };
  }
  /** Steps only this delivery writes the events of. */
  const selfWrittenStepIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const id of executedStepIds) {
      if (!retriedInBackground.has(id)) ids.add(id);
    }
    for (const context of runAheadContexts) {
      for (const id of context.selfStepIds) {
        if (!retriedInBackground.has(id)) ids.add(id);
      }
    }
    return ids;
  };
  /**
   * Whether `event` is this delivery's own write, or one the VM already
   * has. At a speculative position only the event placed there is.
   */
  const isOwnOrKnownEvent = (event: Event): boolean => {
    if (ownEventIds.has(event.eventId)) return true;
    const slot = eventIdToSlot(event.eventId);
    const placed = slot === null ? undefined : placedBySlot.get(slot);
    if (placed) {
      return (
        placed.eventType === event.eventType &&
        placed.correlationId === event.correlationId
      );
    }
    return seenEventIds.has(event.eventId);
  };
  /**
   * What a delivery stopped by a hazard may still write: the outcome of a
   * step whose start committed. Anything else is a decision made from the
   * speculative view.
   */
  const mayStillWriteAfterHazard = (
    events: readonly CreateEventRequest[]
  ): boolean =>
    events.every(
      (event) =>
        (event.eventType === 'step_completed' ||
          event.eventType === 'step_failed' ||
          event.eventType === 'step_retrying') &&
        event.correlationId !== undefined &&
        committedStarts.has(event.correlationId)
    );
  const stopRunAhead = (reason: string, fields: Record<string, unknown>) => {
    runAheadStats.hazardStops++;
    recordRunAheadSpan();
    const stop = new RunAheadStopError(reason);
    writer?.stopDecisions(stop, mayStillWriteAfterHazard);
    runAheadFailure ??= stop;
    wfdiag('run_ahead_stop', { reason, ...fields });
    notifyProgress();
  };
  /**
   * Events already found to be hazards: a report, the feed and a listing can
   * each hand back the same one.
   */
  const hazardEventIds = new Set<string>();
  /**
   * Stops the delivery's further decisions on an event another writer placed
   * below a speculative write that would have made the boundary it ran ahead
   * of path-changing. The classification and the in-band fence rule this
   * out, so it detects a classification gap rather than recovering from one,
   * and it is loud. Events above every speculative position are fed after
   * them in log order, as a cold replay reads them, and are not checked.
   */
  const checkRunAheadHazard = (event: Event, source: string): void => {
    if (placedBySlot.size === 0) return;
    if (hazardEventIds.has(event.eventId)) return;
    const slot = eventIdToSlot(event.eventId);
    if (slot === null || slot > Math.max(...placedBySlot.keys())) return;
    const sensitiveHookIds = new Set<string>();
    for (const context of runAheadContexts) {
      for (const id of context.sensitiveHookIds) sensitiveHookIds.add(id);
    }
    const selfStepIds = selfWrittenStepIds();
    const reason = runAheadHazard(
      event,
      { sensitiveHookIds, selfStepIds },
      (below) =>
        isOwnOrKnownEvent(below) ||
        (below.eventType.startsWith('step_') &&
          below.correlationId !== undefined &&
          selfStepIds.has(below.correlationId))
    );
    if (!reason) return;
    hazardEventIds.add(event.eventId);
    // An error, not a warning: see the node engine's `checkRunAheadHazard`.
    runtimeLogger.error(
      'Run-ahead stopped: an event that could change the workflow landed below a speculative write',
      {
        workflowRunId: runId,
        possibleLogCorruption: true,
        reason,
        source,
        eventType: event.eventType,
        eventId: event.eventId,
        correlationId: event.correlationId,
        speculativeSlots: [...placedBySlot.keys()],
      }
    );
    stopRunAhead(reason, { source, eventType: event.eventType });
  };
  /** Records a speculative write another writer displaced. */
  const markDisplaced = (why: string): void => {
    if (runAheadDisplaced !== undefined) return;
    runAheadDisplaced = why;
    runAheadStats.displaced++;
    recordRunAheadSpan();
    wfdiag('run_ahead_displaced', { why });
    notifyProgress();
  };
  logView.onDisplaced = (event, placed) => {
    checkRunAheadHazard(event, 'displacing event');
    markDisplaced(
      `the speculative ${placed.eventType} placed at ${placed.eventId} was displaced by a ${event.eventType}`
    );
  };
  /** Checks what a World handed back on a write before it is absorbed. */
  const screenWritten = (
    events: readonly Event[] | undefined,
    source: string
  ): void => {
    noteRunEnd(events);
    for (const event of events ?? []) checkRunAheadHazard(event, source);
  };
  screenWrittenEvents = screenWritten;
  /** Steps whose speculative outcome is in flight. */
  const unconfirmedOutcomes = (): Set<string> => {
    const steps = new Set<string>();
    for (const { event } of speculationsBySlot.values()) {
      if (
        (event.eventType === 'step_completed' ||
          event.eventType === 'step_failed') &&
        event.correlationId
      ) {
        steps.add(event.correlationId);
      }
    }
    return steps;
  };
  /**
   * Whether the delivery may run ahead: of the outcomes of `stepIds` within
   * the depth, or (without ids) start new steps ahead of their creation's
   * commit while the outcomes in flight are within it.
   */
  const withinRunAheadDepth = (stepIds: readonly string[] = []): boolean => {
    if (
      runAheadDepth <= 0 ||
      runEndSeen ||
      runAheadDisplaced !== undefined ||
      runAheadFailure !== undefined ||
      writer === undefined ||
      writer.isStopped
    ) {
      return false;
    }
    const steps = unconfirmedOutcomes();
    for (const id of stepIds) steps.add(id);
    return steps.size <= runAheadDepth;
  };
  /** Waits for every speculative write in flight to settle. */
  const settleRunAhead = async (): Promise<void> => {
    while (speculationsBySlot.size > 0) {
      await Promise.allSettled(
        [...speculationsBySlot.values()].map((s) => s.settled)
      );
    }
  };
  /** Throws what stopped run-ahead, once its writes in flight settled. */
  const throwIfRunAheadStopped = async (): Promise<void> => {
    const displaced = runAheadDisplaced;
    if (runAheadFailure === undefined && displaced === undefined) return;
    await settleRunAhead();
    if (runAheadFailure !== undefined) throw runAheadFailure;
    throw new RunAheadStopError(
      displaced ?? 'a speculative write was displaced'
    );
  };
  const noteRunAheadContext = (context: RunAheadContext): void => {
    runAheadContexts.add(context);
  };
  /** Tracks a speculative write until it settles. */
  const trackSpeculation = (
    events: readonly Event[],
    commit: Promise<unknown>
  ): void => {
    const placed = events.flatMap((event) => {
      const slot = eventIdToSlot(event.eventId);
      return slot === null ? [] : [{ slot, event }];
    });
    const slots = placed.map(({ slot }) => slot);
    const settled = commit.then(
      () => {
        for (const slot of slots) speculationsBySlot.delete(slot);
        if (speculationsBySlot.size === 0) runAheadContexts.clear();
        notifyProgress();
      },
      (error: unknown) => {
        for (const slot of slots) speculationsBySlot.delete(slot);
        if (runAheadFailure === undefined) {
          runAheadStats.failureStops++;
          recordRunAheadSpan();
        }
        runAheadFailure ??= error;
        notifyProgress();
      }
    );
    for (const { slot, event } of placed) {
      speculationsBySlot.set(slot, { event, settled });
    }
  };
  /**
   * Folds a speculative write's committed event into the view, and checks it
   * took the position the VM consumed it at.
   */
  const confirmPlaced = (committed: Event, placed: Event): void => {
    const slot = eventIdToSlot(placed.eventId);
    logView.absorb({ event: committed }, { deliverEvent: true });
    if (slot !== null && eventIdToSlot(committed.eventId) === slot) {
      placedBySlot.delete(slot);
    } else {
      markDisplaced(
        `the speculative ${placed.eventType} placed at ${placed.eventId} committed at ${committed.eventId}`
      );
    }
  };
  /**
   * Writes an inline step's outcome ahead: returns at once with the event,
   * which the VM is fed at the position the write takes unless another writer
   * appends first, stamped with the time the World records for it
   * (`occurredAt`). The commit is checked before any later write is sent.
   * `undefined` when the writer's prediction is one the view already knows
   * of: the caller writes the outcome on the awaited path.
   */
  const writeOutcomeAhead = (
    data: CreateEventRequest,
    eventParams: CreateEventParams | undefined,
    context: RunAheadContext
  ): EventResult | undefined => {
    if (!writer) return undefined;
    const occurredAt = new Date();
    const slot = writer.predictNextSlot();
    const placed = {
      ...data,
      runId,
      eventId: slotToEventId(slot),
      createdAt: occurredAt,
    } as Event;
    if (!logView.queueSpeculative([placed])) return undefined;
    placedBySlot.set(slot, placed);
    noteRunAheadContext(context);
    const commit = writer.createAhead(
      data,
      {
        ...eventParams,
        ...logView.snapshotParams(),
        resolveData: REPLAY_RESOLVE_DATA,
        occurredAt,
      },
      (result) => {
        screenWritten(result.events, 'skipped-slot report');
        logView.absorb({ events: result.events, hasMore: result.hasMore });
        const committed = result.event;
        if (!committed || +new Date(committed.createdAt) !== +occurredAt) {
          // The World keeps its own time for in-band writes, so the
          // workflow read a different `Date.now()` than replay will. Never
          // again in this process for this World.
          disableRunAheadFor(world);
          throw new RunAheadStopError(
            'the World does not record an in-band write at its occurredAt'
          );
        }
        if (eventIdToSlot(committed.eventId) !== slot && result.hasMore) {
          stopRunAhead(
            'a speculative write was displaced by events the World did not report',
            { eventType: data.eventType }
          );
        }
        confirmPlaced(committed, placed);
      }
    );
    trackSpeculation([placed], commit);
    return { event: placed };
  };
  /**
   * Writes a boundary's new inline steps' creations (each one's first,
   * creation-bearing `step_started`, as {@link createInlineStep} writes it,
   * in one batch) ahead: the VM is fed them at the positions they take
   * unless another writer appends first, and the bodies start at once. The
   * commit is checked as an outcome's is (see {@link writeOutcomeAhead}).
   * `undefined` when the prediction is stale; the caller then creates the
   * steps on the awaited path.
   */
  const writeCreationAhead = (
    creations: readonly { step: PendingStep; input: SerializedData }[],
    context: RunAheadContext
  ): Map<string, CallerStart> | undefined => {
    if (!writer || !withinRunAheadDepth()) return undefined;
    const events = creations.map(({ step, input }) =>
      inlineCreationEvent(step, input)
    );
    const occurredAt = new Date();
    const first = writer.predictNextSlot();
    const placed = events.map(
      (data, index) =>
        ({
          ...data,
          runId,
          eventId: slotToEventId(first + index),
          createdAt: occurredAt,
        }) as Event
    );
    if (!logView.queueSpeculative(placed)) return undefined;
    placed.forEach((event, index) => {
      placedBySlot.set(first + index, event);
    });
    noteRunAheadContext(context);
    const postSentAtMs = Date.now();
    const commit = writer.createBatchAhead(
      events.map((event) => ({
        event,
        occurredAt,
        computeInstanceId: COMPUTE_INSTANCE_ID,
      })),
      {
        ...logView.snapshotParams(),
        ...(requestId ? { requestId } : {}),
      },
      (result: EventBatchResult) => {
        screenWritten(result.events, 'skipped-slot report');
        logView.absorb({ events: result.events, hasMore: result.hasMore });
        let refusal: RunAheadStopError | undefined;
        result.results.forEach((item, index) => {
          if (item.error !== undefined) {
            refusal ??= new RunAheadStopError(
              `a speculative ${events[index]?.eventType} was refused (${item.status}: ${item.message})`
            );
            return;
          }
          if (+new Date(item.event.createdAt) !== +occurredAt) {
            disableRunAheadFor(world);
            refusal ??= new RunAheadStopError(
              'the World does not record an in-band write at its occurredAt'
            );
          }
          if (item.event.correlationId) {
            committedStarts.add(item.event.correlationId);
          }
          if (
            eventIdToSlot(item.event.eventId) !== first + index &&
            result.hasMore
          ) {
            stopRunAhead(
              'a speculative write was displaced by events the World did not report',
              { eventType: 'step_started' }
            );
          }
          const placedEvent = placed[index];
          if (placedEvent) confirmPlaced(item.event, placedEvent);
        });
        if (refusal) throw refusal;
      }
    );
    trackSpeculation(placed, commit);
    const starts = new Map<string, CallerStart>();
    for (const { step } of creations) {
      starts.set(step.correlationId, {
        startedAt: occurredAt,
        postSentAtMs,
        completedAtMs: postSentAtMs,
      });
    }
    return starts;
  };
  /**
   * Classifies a boundary for run-ahead (see `observeOutOfBandWriters`):
   * `selfStepIds` are the steps this delivery runs inline, the ones it is
   * about to start included.
   */
  const classifyBoundary = (
    pendingOperations: readonly PendingOperation[],
    selfStepIds: ReadonlySet<string>
  ): RunAheadContext | undefined => {
    const hooks: QuickJSOpenHook[] = session.openHooks();
    const observedHookIds = new Set(
      hooks.filter((hook) => hook.observed).map((hook) => hook.correlationId)
    );
    const waitWindowEndMs =
      params.inlineDeadlineMs === undefined
        ? Number.POSITIVE_INFINITY
        : params.inlineDeadlineMs + getOpenWaitClockSkewMs();
    const items: QueueItem[] = [];
    let waitDue = false;
    for (const op of pendingOperations) {
      if (op.type === 'step') {
        items.push({
          type: 'step',
          correlationId: op.correlationId,
          stepName: (op as PendingStep).stepId,
          args: [],
        });
      } else if (op.type === 'wait') {
        // A wait this delivery completed is its own write.
        if (completedWaitIds2.has(op.correlationId)) continue;
        const resumeAtMs = new Date((op as PendingWait).resumeAt).getTime();
        if (
          resumeAtMs <= waitWindowEndMs ||
          params.wakeUpWaits?.has(op.correlationId) === true
        ) {
          waitDue = true;
        }
      }
    }
    for (const hook of hooks) {
      items.push({
        type: 'hook',
        correlationId: hook.correlationId,
        token: hook.token,
        ...(hook.isSystem ? { isSystem: true } : {}),
        ...(hook.disposed ? { disposed: true } : {}),
      });
    }
    const observation = observeOutOfBandWriters({
      items,
      observedHookIds,
      selfExecutedStepIds: selfStepIds,
      waitDue,
    });
    wfdiag('run_ahead_boundary', {
      inert: observation.inert,
      observedHooks: observation.observedHookCount,
      abortSignalHooks: observation.abortSignalHookCount,
      externalSteps: observation.externalStepCount,
      waitDue: observation.waitDue,
    });
    if (!observation.inert) return undefined;
    return runAheadContextFor({
      observation,
      hookItems: hooks,
      observedHookIds,
      selfStepIds,
    });
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
    // The creation is a `step_created`, or the first `step_started` of a
    // step created inline.
    if (
      (created?.eventType === 'step_created' ||
        created?.eventType === 'step_started') &&
      created.eventData?.input !== undefined
    ) {
      return created.eventData.input;
    }
    // A World may leave step inputs out of replay loads; read it back.
    const read = await world.events.get(runId, state.createdEventId, {
      resolveData: 'all',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    const input =
      read.eventType === 'step_created' ||
      (read.eventType === 'step_started' && stepCreationOf(read) !== undefined)
        ? read.eventData?.input
        : undefined;
    if (input === undefined) {
      throw new WorkflowRuntimeError(
        `Event "${state.createdEventId}" is not a step's creation`
      );
    }
    return input;
  };

  /**
   * Writes a new inline step's creation: the first attempt's `step_started`,
   * carrying what a `step_created` carries (stepName, workflowName, input,
   * `inline: true`) but no `creatorMessageId`, which only a background step's
   * creation needs. A single-orchestrator run records an
   * inline step by that start alone, so the executor writes no start of its
   * own. A refusal is the start's refusal (a throttle defers the delivery, a
   * finished run ends the attempt). Mirrors the node engine's creation batch
   * (`planStepsAndWaits`).
   */
  const createInlineStep = async (
    step: PendingStep,
    input: SerializedData
  ): Promise<CallerStart> => {
    const postSentAtMs = Date.now();
    const written = await createEvent(inlineCreationEvent(step, input), {
      computeInstanceId: COMPUTE_INSTANCE_ID,
      ...(requestId ? { requestId } : {}),
    });
    return {
      startedAt: written.event
        ? new Date(written.event.createdAt)
        : new Date(postSentAtMs),
      postSentAtMs,
      completedAtMs: Date.now(),
    };
  };

  /**
   * Starts one inline step's body; never awaited here. `optimistic` (turbo)
   * starts it before its `step_created` and `step_started` commit. `ahead`
   * is the step's creation run-ahead already sent, whose body starts at once
   * (see {@link writeCreationAhead}); `runAhead` lets the step's outcome run
   * ahead of its write at a boundary that is still inert when it settles.
   */
  const launchInline = (
    step: PendingStep,
    options: {
      resume?: LogStepState;
      optimistic?: boolean;
      ahead?: { started: CallerStart; input: SerializedData };
      runAhead?: RunAheadContext;
    } = {}
  ): void => {
    const { resume, optimistic = false, ahead, runAhead } = options;
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
          // the input on it) is already in the log. This attempt's start is
          // the executor's own write (see `createEvent` below).
          input = await stepInputFromLog(resume);
        } else if (ahead) {
          // Run-ahead sent the creation already; the body starts now.
          inlineCreatedStepIds.add(step.correlationId);
          input = ahead.input;
        } else {
          input = await encryptSerializedData(step.input, encryptionKey);
          // The step's execution mode is fixed here: inline, run by this
          // orchestrator. `step_created` commits before the body starts,
          // except under turbo's optimistic start, where the body starts
          // now and its `step_started` follows this commit.
          inlineCreatedStepIds.add(step.correlationId);
          // The executor waits for it before the start (and, unless
          // optimistic, before the body), and reads a refusal as its start's.
          startAfter = createInlineStep(step, input).then((start) => {
            committedStarts.add(step.correlationId);
            return start;
          });
          startAfter.catch(() => {});
        }
        return executeStep({
          world,
          createEvent: async (data, eventParams) => {
            if (data.eventType === 'step_retrying') {
              // From here on the step's own message runs it: its later
              // events are another writer's.
              retriedInBackground.add(step.correlationId);
            }
            if (
              runAhead &&
              (data.eventType === 'step_completed' ||
                data.eventType === 'step_failed')
            ) {
              if (boundaryInert && !withinRunAheadDepth([step.correlationId])) {
                // At the cap, wait for an earlier speculative write to
                // settle, which frees a place, and run this outcome ahead
                // too: an awaited write of its own would leave the next
                // creation nothing to share a round trip with.
                runAheadStats.depthCap++;
                recordRunAheadSpan();
                while (
                  boundaryInert &&
                  !withinRunAheadDepth([step.correlationId]) &&
                  runAheadDisplaced === undefined &&
                  runAheadFailure === undefined &&
                  !writer?.isStopped &&
                  speculationsBySlot.size > 0
                ) {
                  await Promise.race(
                    [...speculationsBySlot.values()].map((s) => s.settled)
                  );
                }
              }
              // Only while the latest boundary is still inert: one where
              // the workflow waits on something another writer may deliver
              // drains run-ahead before it decides.
              if (boundaryInert && withinRunAheadDepth([step.correlationId])) {
                const written = writeOutcomeAhead(data, eventParams, runAhead);
                if (written) return written;
              }
            }
            const written = await writeEvent(
              withRetryCreator(data, ownerMessageId),
              {
                ...eventParams,
                ...logView.snapshotParams(),
              }
            );
            screenWritten(written.events, 'skipped-slot report');
            logView.absorb(written, {
              deliverEvent: deliversOwnEvent(data.eventType),
            });
            if (data.eventType === 'step_started') {
              committedStarts.add(step.correlationId);
            }
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
          ...(resume?.firstStartedAt
            ? { firstStartedAt: resume.firstStartedAt }
            : {}),
          input,
          ...(ahead ? { started: ahead.started } : {}),
          forceOptimisticStart: optimistic && !resume,
          ...(turbo ? { runReadyBarrier: turbo.runReadyBarrier } : {}),
          ...(startAfter
            ? { startAfter: startAfter as Promise<CallerStart | undefined> }
            : {}),
          beforeBody: () => params.writer?.assertActive(),
          // A retry moves the step to a message of its own, sent once the
          // retry is written, with a step message's retention: a retry that
          // would land after it expires fails the step, as it does for a
          // background step.
          retryOutlivesMessage: (retryAtMs) =>
            retryOutlivesMessage({
              messageCreatedAt: new Date(),
              retentionSeconds: stepMessageRetentionSeconds(
                getStepFunction(step.stepId)?.maxRetries ??
                  DEFAULT_STEP_MAX_RETRIES
              ),
              retryAtMs,
            }),
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
    // Speculative writes settle before the delivery ends, whichever way it
    // ends.
    await settleRunAhead();
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
          workflowRun,
          step,
          delaySeconds: result.timeoutSeconds,
          namespace,
          nextTraceCarrier,
          onSent: params.onStepMessageSent,
          stepAttempt: 2,
          wfdiag,
        });
      } else if (result.type === 'gone') {
        runGone = true;
      } else {
        // A terminal outcome the VM has not been fed yet. Until a feed
        // delivers it, exiting must hand the run to a fresh invocation:
        // an inline step has no queue message of its own.
        if (!fedOutcomeStepIds.has(step.correlationId)) {
          pendingRequeueSignal = true;
        }
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
   * What this pass's run waits on outside the orchestrator (see
   * `externalWorkOf`): `'step'` for a step running from its own message
   * (queued by this delivery, its retry included, or created by an earlier
   * one and not run here), else `'hook'` for an open hook.
   */
  const externalWorkOfPass = (
    pendingOperations: PendingOperation[]
  ): ExternalWork | undefined => {
    if (
      pendingOperations.some(
        (op) =>
          op.type === 'step' &&
          (queuedStepIds.has(op.correlationId) ||
            ((op as PendingStep).hasCreatedEvent &&
              !executedStepIds.has(op.correlationId)))
      )
    ) {
      return 'step';
    }
    const logged = externalWorkOf(fullLog());
    if (logged !== undefined) return logged;
    if (pendingOperations.some((op) => op.type === 'hook')) return 'hook';
    return undefined;
  };

  /**
   * Keeps this delivery live while the run waits on work done elsewhere (see
   * `getOrchestratorLingerMsFor`: the full window for a background step, the
   * hook window for open hooks alone). `true` once the feed delivered an
   * event or a wait fell due, so the loop takes another turn; `false` when
   * the time ran out without either, or the live feed is not (or stops being)
   * live.
   */
  const lingerForExternalWork = async (
    external: ExternalWork | undefined,
    pendingOperations: PendingOperation[]
  ): Promise<boolean> => {
    const lingerMs = getOrchestratorLingerMsFor(external);
    if (
      lingerMs <= 0 ||
      params.inlineDeadlineMs === undefined ||
      !world.events.subscribe ||
      !logView.tracking
    ) {
      return false;
    }
    const untilMs = Math.min(
      Date.now() + lingerMs,
      params.inlineDeadlineMs - inlineMarginMs
    );
    if (untilMs <= Date.now()) return false;
    ensureInlineFeed();
    if (!inlineFeed?.isLive) {
      wfdiag('linger', { outcome: 'feed-down', lingeredMs: 0 });
      return false;
    }
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
        if (!inlineFeed?.isLive) {
          wfdiag('linger', {
            outcome: 'feed-down',
            lingeredMs: Date.now() - startedAtMs,
          });
          return false;
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
      // Hand off before the function's deadline, as the node engine does: a
      // turn that begins past it starts nothing more, the bodies still
      // running settle, and the next delivery continues from the log.
      if (
        params.inlineDeadlineMs !== undefined &&
        Date.now() >= params.inlineDeadlineMs
      ) {
        deadlineReached = true;
        wfdiag('inline_iteration', {
          iteration,
          phase: 'deadline',
          inFlight: inFlightInline.size,
        });
        break;
      }
      await processSettledInline();
      // A speculative write that failed or was displaced ends the pass
      // before anything else is decided (see the run-ahead state above).
      await throwIfRunAheadStopped();
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
      // Within the inline-start margin, fresh steps go to the background, as
      // on the node engine, so no body starts that the function's deadline
      // would cut off.
      const inlineCandidates =
        maxInlineSteps <= 0 || !mayInlineNow()
          ? []
          : healthySteps.slice(
              0,
              Math.max(0, maxInlineSteps - resumedInline.length)
            );
      const inlineClaimCids = new Set(
        inlineCandidates.map((step) => step.correlationId)
      );

      // Run-ahead: classify this boundary before it decides anything. One
      // that is not inert decides only from a confirmed log: the
      // speculative writes in flight settle first, and whatever they bring
      // back reaches the VM before it decides.
      let boundaryRunAhead: RunAheadContext | undefined;
      if (runAheadDepth > 0) {
        if (clockReadOnSpeculation && !vmHoldsUnconfirmedSpeculation()) {
          clockReadOnSpeculation = false;
        }
        // Code that read the clock past an unconfirmed speculative event
        // decides only from a confirmed log (see `clockReadOnSpeculation`).
        const clockGated = clockReadOnSpeculation;
        if (clockGated) runAheadStats.clockDrained++;
        boundaryRunAhead =
          runEndSeen || clockGated
            ? undefined
            : classifyBoundary(
                pendingOperations,
                new Set([
                  ...selfWrittenStepIds(),
                  ...inlineCandidates.map((step) => step.correlationId),
                  ...resumedInline.map(({ step }) => step.correlationId),
                ])
              );
        boundaryInert = boundaryRunAhead !== undefined;
        if (boundaryInert) runAheadStats.boundaries++;
        if (!boundaryInert && speculationsBySlot.size > 0) {
          runAheadStats.drained++;
          recordRunAheadSpan();
          await settleRunAhead();
          await throwIfRunAheadStopped();
          continue;
        }
        recordRunAheadSpan();
      }

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
      // turn their step_created is written: the dispatch below writes it,
      // and they are queued right after, in parallel. This must all happen BEFORE
      // the event feed below: the feed always observes those
      // step_created writes as unseen events and `continue`s, so a
      // handoff placed after it is unreachable on the only iteration
      // that still classifies these steps as fresh: next turn they carry
      // hasCreatedEvent and would never be queued at all (the wedge behind
      // promiseRaceStressTestWorkflow hanging in the quickjs CI legs). The
      // step-identity-scoped idempotency key makes repeats harmless.
      const overflowSteps = healthySteps.slice(inlineCandidates.length);
      const overflowCids = new Set(
        overflowSteps.map((step) => step.correlationId)
      );
      const sendOverflowStep = (
        step: PendingStep,
        createdEventId: string | undefined,
        createdAt: Date | undefined,
        input: Uint8Array | undefined
      ): Promise<void> => {
        queuedStepIds.add(step.correlationId);
        return queueStepMessage({
          world,
          workflowRun,
          step,
          namespace,
          nextTraceCarrier,
          onSent: params.onStepMessageSent,
          ...(createdEventId ? { stepCreatedEventId: createdEventId } : {}),
          ...(createdAt ? { stepCreatedAt: createdAt } : {}),
          ...(input &&
          input.byteLength <= MAX_STEP_MESSAGE_INPUT_BYTES &&
          (workflowRun.specVersion ?? 0) >=
            SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
            ? { stepInput: input }
            : {}),
          wfdiag,
        });
      };
      // A fan-out's creations go out as creation batches, as on the node
      // engine, and each batch's overflow steps are sent as soon as it
      // committed, while the batches behind it go out.
      const creationBatches: CreationBatches | undefined = writeCreationBatch
        ? {
            write: writeCreationBatch,
            onStepsCreated: async (created) => {
              await Promise.all(
                created.flatMap(({ step, eventId, createdAt, input }) =>
                  overflowCids.has(step.correlationId) &&
                  !queuedStepIds.has(step.correlationId)
                    ? [sendOverflowStep(step, eventId, createdAt, input)]
                    : []
                )
              );
            },
          }
        : undefined;
      // A new wait's timer goes out before its `wait_created` commits: the
      // earliest open wait of each chain this delivery arms, when the pass
      // creates waits (see `armWaitsBeforeCreation` in `delivery.ts`). A
      // wait already due gets none; this delivery completes it below.
      if (
        opsToDispatch.some(
          (op) =>
            op.type === 'wait' &&
            !op.hasCreatedEvent &&
            !writtenOpIds.has(op.correlationId)
        )
      ) {
        const now = Date.now();
        await armWaitTimers(
          opsToDispatch.flatMap((op) => {
            if (op.type !== 'wait') return [];
            if (completedWaitIds2.has(op.correlationId)) return [];
            const resumeAtMs = new Date((op as PendingWait).resumeAt).getTime();
            if (resumeAtMs <= now) return [];
            return [
              {
                correlationId: op.correlationId,
                resumeAtMs,
                seconds: Math.max(1, Math.ceil((resumeAtMs - now) / 1000)),
              },
            ];
          })
        );
      }
      const dispatched = await dispatchPendingOps({
        eventSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        stampCreations: true,
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
        finalizeUnserializableSteps: true,
        ...(creationBatches ? { creationBatches } : {}),
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
      // re-finalize or queue them.
      if (dispatched.failedSerializationStepCids.size > 0) {
        pendingRequeueSignal = true;
        for (const cid of dispatched.failedSerializationStepCids) {
          executedStepIds.add(cid);
        }
      }

      // The overflow steps no creation batch sent: every one written as a
      // single write, and any whose creation already existed.
      await Promise.all(
        overflowSteps.flatMap((step) =>
          dispatched.reportedStepCids.has(step.correlationId)
            ? []
            : [
                sendOverflowStep(
                  step,
                  dispatched.createdStepEventIds.get(step.correlationId),
                  dispatched.createdStepCreatedAts.get(step.correlationId),
                  dispatched.createdStepInputs.get(step.correlationId)
                ),
              ]
        )
      );

      // Complete elapsed waits so their wait_completed events are picked
      // up by the feed below (instead of a queue re-invocation).
      const waitCompletePromises: Promise<void>[] = [];
      const elapsedWaits = pendingOperations.filter(
        (op): op is PendingWait =>
          op.type === 'wait' &&
          !completedWaitIds2.has(op.correlationId) &&
          (new Date((op as PendingWait).resumeAt).getTime() - Date.now() <= 0 ||
            params.wakeUpWaits?.has(op.correlationId) === true)
      );
      await armChainsBeforeCompletion(
        fullLog(),
        elapsedWaits.map((wait) => wait.correlationId)
      );
      for (const wait of elapsedWaits) {
        completedWaitIds2.add(wait.correlationId);
        waitCompletePromises.push(
          (async () => {
            try {
              await createEvent({
                eventType: 'wait_completed',
                specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
                correlationId: wait.correlationId,
                eventData: { resumeAt: new Date(wait.resumeAt) },
              });
              completedWaits.add(wait.correlationId);
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      }
      if (waitCompletePromises.length > 0) {
        await Promise.all(waitCompletePromises);
        await armCompletedChains(fullLog());
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
          const clockReadsBefore = runAheadDepth > 0 ? session.clockReads() : 0;
          result = await session.continueWithEvents(newEvents);
          if (
            runAheadDepth > 0 &&
            session.clockReads() > clockReadsBefore &&
            vmHoldsUnconfirmedSpeculation()
          ) {
            clockReadOnSpeculation = true;
          }
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
      // Steps that may have lost their message (a delivery that died between
      // a step's `step_created` and its send) are sent again by a delivery
      // that is not its message's first, once per invocation and in
      // batches, under each step's stable key (see `stepsToReenqueue`).
      const reenqueue = stepResends(events);
      const resend: {
        step: PendingStep;
        stepAttempt?: number;
        stepCreatedAt?: Date;
        resent: true;
      }[] = [];
      let starts: Map<string, number> | undefined;
      for (const step of stepOps) {
        if (!step.hasCreatedEvent) continue;
        if (executedStepIds.has(step.correlationId)) continue;
        if (queuedStepIds.has(step.correlationId)) continue;
        if (!reenqueue.has(step.correlationId)) continue;
        queuedStepIds.add(step.correlationId);
        params.onStepResent?.(step.correlationId);
        starts ??= new Map(
          analyzeLogSteps(events).map((logStep) => [
            logStep.correlationId,
            logStep.starts,
          ])
        );
        const started = starts.get(step.correlationId) ?? 0;
        // A step that started carries its next attempt, so its handler reads
        // the log before it runs the body.
        // A re-send carries the creation's time, not its own.
        const created = events.find(
          (event) =>
            event.correlationId === step.correlationId &&
            event.eventType === 'step_created'
        );
        resend.push({
          step,
          resent: true,
          ...(started > 0 ? { stepAttempt: started + 1 } : {}),
          ...(created ? { stepCreatedAt: new Date(created.createdAt) } : {}),
        });
      }
      await queueStepMessages({
        world,
        workflowRun,
        steps: resend,
        namespace,
        nextTraceCarrier,
        onSent: params.onStepMessageSent,
        wfdiag,
      });

      if (
        inlineCandidates.length === 0 &&
        resumedInline.length === 0 &&
        inFlightInline.size === 0
      ) {
        // Outcomes of bodies that just settled are acted on first.
        if (settledInline.length > 0) continue;
        // A delivery that ran ahead parks only on a confirmed log, so
        // whatever landed below its speculative writes is acted on now.
        if (speculationsBySlot.size > 0) {
          await settleRunAhead();
          continue;
        }
        // No in-process progress possible: the run awaits an external
        // stimulus (hook payload, queued step, wait timer). While it waits
        // on a hook or a step running from its own message, stay live for
        // it instead of leaving it to a queued wake.
        if (
          await lingerForExternalWork(
            externalWorkOfPass(pendingOperations),
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
      const sweep: {
        correlationId: string;
        resumeAtMs: number;
        seconds: number;
      }[] = [];
      for (const op of pendingOperations) {
        if (op.type !== 'wait') continue;
        const wait = op as PendingWait;
        // Completed by this invocation already; the event just has not been
        // fed back into the VM yet.
        if (completedWaitIds2.has(wait.correlationId)) continue;
        const resumeAtMs = new Date(wait.resumeAt).getTime();
        // An elapsed wait still gets a continuation (clamped to 1s): one
        // whose deadline fell between the elapsed-wait pass above and this
        // sweep would otherwise get neither a wait_completed nor a timer.
        const seconds = Math.max(
          1,
          Math.ceil((resumeAtMs - Date.now()) / 1000)
        );
        sweep.push({ correlationId: wait.correlationId, resumeAtMs, seconds });
      }
      await armWaitTimers(sweep);

      for (const { step, state } of resumedInline) {
        launchInline(step, { resume: state, runAhead: boundaryRunAhead });
      }
      // Run-ahead: a boundary of only new inline steps sends their
      // creations ahead, as one batch, when the World takes them as one and
      // the depth allows. Every body of the batch starts before it commits,
      // and a stop that refuses it runs each of them again, so its steps
      // count against the depth (the first is the one a sequential loop runs
      // ahead with). A step that allows no retries starts only on a durable
      // `step_started` (see `mayRunBeforeItsStart`), so a boundary with one
      // commits first, as does an explicit `WORKFLOW_OPTIMISTIC_INLINE_START=0`.
      let aheadStarts: Map<string, CallerStart> | undefined;
      let aheadInputs: Map<string, SerializedData> | undefined;
      if (
        boundaryRunAhead !== undefined &&
        runStartedLanded &&
        resumedInline.length === 0 &&
        inlineCandidates.length > 0 &&
        inlineCandidates.length <= MAX_BATCH_EVENTS &&
        params.writer?.supportsBatch === true &&
        !isOptimisticInlineStartExplicitlyDisabled() &&
        inlineCandidates.every((step) => mayRunBeforeItsStart(step.stepId)) &&
        withinRunAheadDepth(
          inlineCandidates.slice(1).map((step) => step.correlationId)
        )
      ) {
        const creations = await Promise.all(
          inlineCandidates.map(async (step) => ({
            step,
            input: await encryptSerializedData(step.input, encryptionKey),
          }))
        );
        const bytes = creations.reduce(
          (sum, { step, input }) =>
            sum + creationBatchBytes(inlineCreationEvent(step, input)),
          0
        );
        if (bytes <= MAX_IN_BAND_CREATION_BATCH_BYTES) {
          aheadStarts = writeCreationAhead(creations, boundaryRunAhead);
          if (aheadStarts) {
            aheadInputs = new Map(
              creations.map(({ step, input }) => [step.correlationId, input])
            );
          }
        }
      }
      for (const step of inlineCandidates) {
        const started = aheadStarts?.get(step.correlationId);
        const input = aheadInputs?.get(step.correlationId);
        // A step whose creation run-ahead did not send starts as without
        // it: once its start committed, except under turbo. Only the batch
        // above counts against the depth.
        launchInline(step, {
          optimistic: turboOptimistic,
          runAhead: boundaryRunAhead,
          ...(started && input !== undefined
            ? { ahead: { started, input } }
            : {}),
        });
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
    // Nothing is decided past a speculative write that failed or was
    // displaced: the run's terminal write included.
    await throwIfRunAheadStopped();
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
      // A heap that consumed a speculative event only once its write
      // confirmed it there.
      logView.speculativeCount === 0 &&
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
    // Every exit, a throw included, lets running inline bodies settle and
    // stops the live feed before the VM goes away; otherwise the feed keeps
    // polling and holds its subscription for as long as the process lives.
    await drainInline();
    session.dispose();
    if (writer && runAheadDepth > 0) writer.onAccepted = previousOnAccepted;
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

    // Flush leftover pending side effects (abort recordings and fire-and-forget
    // attribute/hook events) BEFORE writing run_completed. Mirrors the node:vm
    // engine's drainPendingQueueItems.
    // Drain failures are swallowed: the workflow's own outcome is the
    // source of truth.
    if (result.completed.drainOperations?.length) {
      try {
        await dispatchPendingOps({
          eventSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          stampCreations: true,
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
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
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
    await afterRunCompleted(world, workflowRun, workflowName);
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
        {
          specVersion: workflowRun.specVersion,
          delaySeconds: throttledReplaySeconds,
        }
      );
      return;
    }

    // Exit requeues continue the run in a fresh delivery, never a
    // `{ timeoutSeconds }` visibility-redelivery of the current message,
    // which would count as a failed attempt. Where the World hands off
    // (`continueInNextDelivery`), the same message is redelivered without
    // counting one: its redelivery has `deliveryCount` above 1, so turbo
    // stays off, and a spec-9 message carries no legacy `hookInput` whose
    // re-ensure could ack it away. Otherwise a FRESH message carries only
    // `runId`, so its delivery always reaches replay.
    const requeueImmediately = async (): Promise<void> => {
      if (params.continueInNextDelivery) {
        await params.continueInNextDelivery();
        return;
      }
      await queueMessage(
        world,
        getWorkflowQueueName(workflowRun.workflowName, namespace),
        {
          runId,
          traceCarrier: await nextTraceCarrier(),
          requestedAt: new Date(),
        },
        { specVersion: workflowRun.specVersion }
      );
    };

    if (deadlineReached) {
      // The loop stopped at the invocation's inline deadline: continue in
      // the next delivery, which gets a fresh inline window.
      runtimeLogger.info(
        'Invocation deadline reached, handing the run to the next delivery',
        { workflowRunId: runId, inlineStepsExecuted }
      );
      wfdiag('exit_suspended', { action: 'deadline_handoff' });
      await requeueImmediately();
      return;
    }

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
    const exitSweep: {
      correlationId: string;
      resumeAtMs: number;
      seconds: number;
    }[] = [];
    let hasElapsedWait = false;
    for (const op of pendingOperations) {
      if (op.type !== 'wait') continue;
      const wait = op as PendingWait;
      const resumeAtMs = new Date(wait.resumeAt).getTime();
      const resumeMs = resumeAtMs - Date.now();
      if (resumeMs <= 0) {
        hasElapsedWait = true;
      } else {
        exitSweep.push({
          correlationId: wait.correlationId,
          resumeAtMs,
          seconds: Math.max(1, Math.ceil(resumeMs / 1000)),
        });
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

    // On a delivery that may hold a timer the queue coalesced into it a
    // little before its wait was due (`armsNearDueWaits`), every wait due
    // within the near-due window gets a timer whatever chain it is in (see
    // `getNearDueWaitWindowSeconds`), keyed so that the re-arms of one wait
    // within a second are one message. The first delivery of a message
    // (a wake that brought nothing new included) holds none.
    const nearDueHorizonMs = armsNearDueWaits
      ? Date.now() + getNearDueWaitWindowSeconds() * 1000
      : Number.NEGATIVE_INFINITY;
    for (const wait of exitSweep) {
      if (wait.resumeAtMs > nearDueHorizonMs) continue;
      if (scheduledWaitContinuations.has(wait.correlationId)) continue;
      scheduledWaitContinuations.add(wait.correlationId);
      await queueWaitTimer(wait.correlationId, wait.seconds, wait.resumeAtMs, {
        nearDue: true,
      });
      wfdiag('wait_continuation_scheduled', {
        correlationId: wait.correlationId,
        delaySeconds: wait.seconds,
        nearDue: true,
      });
    }

    if (
      exitSweep.some(
        (wait) =>
          !scheduledWaitContinuations.has(wait.correlationId) &&
          armsWaitTimer(wait.correlationId)
      )
    ) {
      // Delayed continuations for the soonest pending wait of each chain
      // this delivery owns that the loop has not already scheduled. A wait
      // longer than one queue delay is reached in hops (see
      // `waitTimerMessage`).
      wfdiag('exit_suspended', {
        action: 'schedule_wait_timeout',
        waits: exitSweep.length,
      });
      await armWaitTimers(exitSweep);
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
          eventSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          stampCreations: true,
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
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
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
    await afterRunFailed(
      world,
      workflowRun,
      workflowName,
      dehydratedError,
      encryptionKey,
      errorCode
    );
    wfdiag('exit_failed', { result: 'run_failed_written' });
  }
}
