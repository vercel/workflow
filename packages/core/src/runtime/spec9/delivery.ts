/**
 * The spec 9 (single-orchestrator) delivery: one writer per run, enforced by
 * the World's in-band fence. See `../delivery.ts`.
 */
import assert from 'node:assert/strict';
import { types } from 'node:util';
import {
  CorruptedEventLogError,
  EntityConflictError,
  FatalError,
  HookNotFoundError,
  MaxEventsExceededError,
  ReplayDivergenceError,
  RUN_ERROR_CODES,
  RunExpiredError,
  WorkflowRunNotFoundError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { once } from '@workflow/utils';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type EventBatchResult,
  type EventResult,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  type HookResumeTiming,
  IN_BAND_SEQ_AT_RUN_CREATION,
  isSealedNoopEvent,
  isTerminalWorkflowRunStatus,
  type RunInput,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  slotToEventId,
  type WorkflowInvokePayload,
  type WorkflowRun,
} from '@workflow/world';

import { decodeTime } from 'ulid';
import {
  classifyRunError,
  isRetryableWorldError,
  isWorldContractError,
} from '../../classify-error.js';

import type { WorkflowSuspension } from '../../global.js';
import { runtimeLogger } from '../../logger.js';
import { getStepFunction } from '../../private.js';
import { ReplayPayloadCache } from '../../replay-payload-cache.js';
import { GUEST_CODE_EXECUTION_SAMPLE_LIMIT } from '../../serialization/hardened.js';
import { dehydrateRunError, type PayloadKey } from '../../serialization.js';
import { setErrorStack } from '../../set-error-stack.js';
import { remapErrorStack } from '../../source-map.js';
import * as Attribute from '../../telemetry/semantic-conventions.js';
import { bindActiveTraceContext } from '../../telemetry.js';
import {
  formatErrorCauseChain,
  getErrorName,
  getErrorStack,
  normalizeUnknownError,
} from '../../types.js';
import { buildWorkflowSuspensionMessage } from '../../util.js';
import {
  compileDynamicWorkflowBundle,
  compileWorkflowBundle,
  replayWorkflow,
  resumeWorkflow,
  type WorkflowResumeResult,
  type WorkflowSession,
  type WorkflowSessionRebase,
} from '../../workflow.js';
import { COMPUTE_INSTANCE_ID } from '../compute-instance.js';
import {
  DEFAULT_STEP_MAX_RETRIES,
  getMaxInlineSteps,
  getOpenWaitClockSkewMs,
  getReplayDivergenceMaxRetries,
  getRunAheadDepth,
  isOptimisticInlineStartExplicitlyDisabled,
  isTurboEnabled,
  MAX_BATCH_EVENTS,
  MAX_RUN_AHEAD_RESTARTS,
  STEP_DISPATCH_QUEUE_BATCH_SIZE,
} from '../constants.js';
import {
  clampMaxEvents,
  type DeliveryResult,
  getMaxInlineDurationMs,
  getRetentionDecision,
  getWorkflowSetupErrorCode,
  hasRecordedTerminalRunEvent,
  type Orchestrator,
  type ResolvedWorkflowCode,
  recordFatalRunError,
  resolveWorkflowCodeForRun,
  serializationBlockerLogMetadata,
  type WorkflowDelivery,
} from '../delivery.js';
import {
  type DeploymentAffinityOutcome,
  guardDeploymentAffinity,
  type ReenqueueArgs,
} from '../deployment-guard.js';
import { readDynamicWorkflowMetadata } from '../dynamic-workflow.js';
import { maybeWarnApproachingEventLimit } from '../event-limit-warning.js';
import {
  type EventCreator,
  findEventSlotGap,
  getWorkflowQueueName,
  isQueueSendFailure,
  isSlotGapCheckEnabled,
  type LoadedEventLog,
  loadWorkflowRunEvents,
  maxEventSlot,
  mergeReportedEvents,
  queueMessage,
  queueMessages,
  REPLAY_RESOLVE_DATA,
  resolveRunEncryptionKey,
  rootRunIdFrom,
  runDispatchContext,
  type SlotSnapshotParams,
  settleEventSlotGap,
  slotSnapshotParams,
  stepDispatchIdempotencyKey,
} from '../helpers.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
} from '../lifecycle-hooks.js';
import { observeOutOfBandWriters } from '../out-of-band-observation.js';
import { handleReplayBudgetExhausted } from '../replay-budget.js';
import { ReplayRecoveryReporter } from '../replay-recovery-reporter.js';
import { resumeTimingForMessage } from '../resume-latency.js';
import { runIdCreatedAt } from '../run-id-time.js';
import {
  ackRefusedStartHookCandidate,
  admitsTurboStart,
  retriesRunlessRunStarted,
} from '../start-hook-delivery.js';
import { computeStepLatencyTracking } from '../step-latency.js';
import { useQuickJSVm } from '../vm-mode.js';
import { consumeOwnResolvingWrite } from './consume-after-commit.js';
import {
  forgetConsumedPosition,
  hasConsumedPosition,
  isNoopDelivery,
  recordConsumedPosition,
} from './consumed-position.js';
import {
  ownedWaitChains,
  schedulesWaitTimer,
  stepsToReenqueue,
  waitCreatorMessageId,
  waitTimersToArm,
} from './creator-rules.js';
import {
  getInlineStepDeadlineMarginMs,
  mayStartInlineStep,
} from './deadline.js';
import {
  InBandWriter,
  OrchestratorSupersededError,
  RESILIENT_START_SNAPSHOT,
  requireLoadSnapshot,
} from './in-band-writer.js';
import {
  getOrchestratorLingerMs,
  getOrchestratorPollIntervalMs,
  LiveLogFeed,
} from './live-feed.js';
import {
  analyzeLogSteps,
  awaitsExternalWork,
  dueWaits,
  type InlineStepSpec,
  MAX_STEP_MESSAGE_INPUT_BYTES,
  nextTimerAt,
  openWaits,
  type StepMessageSpec,
  stepCreationOf,
} from './log-state.js';
import {
  admitBelowSpeculation,
  disableRunAheadFor,
  isRunAheadDisabledFor,
  type RunAheadContext,
  RunAheadStopError,
  runAheadContextFor,
  runAheadHazard,
} from './run-ahead.js';
import { executeStep, mayRunBeforeItsStart } from './step-executor.js';
import { handleStepMessage } from './step-handler.js';
import { stepMessageRetentionSeconds } from './step-retention.js';
import { runStepSingleFlight } from './step-single-flight.js';
import {
  type CreatedStep,
  planStepsAndWaits,
  type StartedInBatch,
} from './step-wait-creation.js';
import { handleSuspension, pendingQueueDrain } from './suspension-handler.js';
import { waitTimerMessage } from './wait-timer.js';

/**
 * Apply the optional client-side event-limit override.
 * `WORKFLOW_MAX_EVENTS_OVERRIDE`, when set to a positive integer, clamps the
 * server-supplied per-run event ceiling to a smaller value so enforcement can
 * be exercised without a server-side change. Clamp-down only: it never raises
 * the server's limit, and it takes effect even when the server returns none.
 * Unset ⇒ server value passes through unchanged.
 */
/**
 * `promise`, with a handler attached so a rejection nobody else observes (a
 * step spec that ends up not run) does not surface as unhandled. Whoever
 * awaits it still sees the rejection.
 */
function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * The `run_created` a turbo delivery holds without loading the log: what
 * `start()` wrote at the first position, rebuilt from the run input the
 * message carries. Replay consumes `run_created` structurally, so only its
 * identity and creation data matter.
 */
function turboRunCreatedEvent(runId: string, input: RunInput): Event {
  return {
    eventId: slotToEventId(FIRST_EVENT_SLOT),
    runId,
    eventType: 'run_created',
    specVersion: input.specVersion ?? SPEC_VERSION_CURRENT,
    createdAt: new Date(runIdCreatedAt(runId) ?? Date.now()),
    eventData: {
      deploymentId: input.deploymentId,
      workflowName: input.workflowName,
      input: input.input,
      ...(input.executionContext
        ? { executionContext: input.executionContext }
        : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
    },
  } as Event;
}

/** The executor's view of a `step_started` a creation batch committed. */
function startedFromBatch(
  started: StartedInBatch | undefined
): InlineStepSpec['started'] {
  return started
    ? {
        startedAt: new Date(started.event.createdAt),
        postSentAtMs: started.postSentAtMs,
        completedAtMs: started.completedAtMs,
      }
    : undefined;
}

/**
 * Runs one delivery of a spec 9 run's queue message.
 *
 * A delivery that must end before the run's work does (its deadline, a
 * stream flush, the replay budget, a wait or write it cannot read yet)
 * continues the run in a fresh delivery by handing its message off
 * (`{ timeoutSeconds: 0 }`, see `Queue.createQueueHandler`): every World
 * delivers the same message again at once and does not count the handed-off
 * delivery toward `attempt`. A new message would not do on world-vercel: a
 * message the orchestrator sent itself while it holds the run would be
 * coalesced into its own delivery and run again in this same invocation.
 */
export async function runSpec9Delivery(
  delivery: WorkflowDelivery
): Promise<DeliveryResult> {
  const continuation: { handoff: boolean; exit?: string } = { handoff: false };
  const result = await runDelivery(delivery, continuation);
  // TEMPORARY diagnostic for the e2e webhook duplicate-start investigation;
  // remove before merge.
  if (
    continuation.exit !== undefined ||
    continuation.handoff ||
    (delivery.metadata.deliveryCount ?? 1) > delivery.metadata.attempt
  ) {
    runtimeLogger.warn('[diag] spec9 delivery exit', {
      workflowRunId: delivery.message.runId,
      exit: continuation.exit,
      handoff: continuation.handoff,
      result: JSON.stringify(result),
      deliveryCount: delivery.metadata.deliveryCount,
      attempt: delivery.metadata.attempt,
      messageId: delivery.metadata.messageId,
      requestId: delivery.requestId,
    });
  }
  // A redelivery the delivery asked for anyway continues the run too.
  return continuation.handoff && result === undefined
    ? { timeoutSeconds: 0 }
    : result;
}

async function runDelivery(
  delivery: WorkflowDelivery,
  continuation: { handoff: boolean; exit?: string }
): Promise<DeliveryResult> {
  const {
    workflowCode,
    namespace,
    metadata,
    world,
    span,
    runLogger,
    workflowName,
    requestId,
    nextTraceCarrier,
    replayBudget,
    prefetchedRun,
    runSpecVersion,
  } = delivery;
  let { resumeTracking } = delivery;
  const {
    runId,
    stepId: incomingStepId,
    stepName: incomingStepName,
    deploymentMismatchRetryCount,
    runInput,
    hookInput,
    stepInput,
    stepAttempt,
    stepCreatedEventId,
    runContext,
    hookResumeTiming,
    waitContinuation,
    completeWaits,
  } = delivery.message;
  // Waits a `run.wakeUp()` asked this delivery to complete now, whatever
  // their `resumeAt`. Spent on the first pass that sees them.
  const wakeUpWaits = new Set(completeWaits ?? []);
  // The creator identity this delivery holds: its message's id, and that
  // message's delivery count in attempts, which leave out handed-off
  // deliveries. A delivery after a handoff continues the run the way a new
  // message would; a redelivery after a crash (or a rejected delivery)
  // counts above 1 and may re-send what an earlier delivery of the same
  // message created and never got out (see `creator-rules.ts`).
  const creatorMessageId = metadata.messageId;
  const creatorDeliveryCount =
    metadata.deliveryCount === undefined
      ? undefined
      : Math.min(metadata.deliveryCount, metadata.attempt);

  // The inline deadline is measured from the start of the function
  // invocation, which every coalesced re-run of this delivery shares
  // (`metadata.invocationStartedAt`), so a late re-run hands off on time.
  const invocationStartTime = metadata.invocationStartedAt ?? Date.now();
  const noInlineReplayAfterMs = await getMaxInlineDurationMs(
    world,
    invocationStartTime
  );
  let loopIteration = 0;
  // Hooks whose force-claim victim wake this invocation has
  // already sent (its own forced creations, and the replay's
  // republishes), so each suspension of the loop below does
  // not send them again. See `forcedCreationsOwingWake`.
  const forceClaimVictimWakes = new Set<string>();
  // Replay divergences this delivery recovered from in place (see
  // `recordDivergence`), oldest first. The delivery cap bounds them across
  // crashes and redeliveries.
  const divergences: string[] = [];
  // Inert until a divergence is recovered: then the first natural write of
  // a replay that got past it reports the count.
  let replayRecoveryReporter = ReplayRecoveryReporter.inert();
  // Restarts in place after run-ahead stopped this delivery (see
  // `MAX_RUN_AHEAD_RESTARTS`). Run-ahead stays off after the first.
  let runAheadRestarts = 0;
  // Compilation is useful only for the Node VM. Wait until the
  // run's engine selection is known so QuickJS deliveries never
  // parse and cache an unused node:vm Script. The promise is
  // invocation-scoped and reused by every cold replay;
  // evaluation still waits for a fresh VM context.
  let compiledWorkflowScripts:
    | ReturnType<typeof compileWorkflowBundle>
    | undefined;
  let compiledWorkflowName: string | undefined;
  const startWorkflowCompile = await bindActiveTraceContext(
    (workflow?: Pick<WorkflowRun, 'workflowName' | 'executionContext'>) => {
      if (!workflow || useQuickJSVm(workflow)) return;
      // A dynamic run does not replay the deployment's
      // bundle, and its own code is not available yet (it is
      // encrypted, and resolving it needs the run's key). Skip
      // the warm-up rather than cache scripts the replay must
      // not use: `replayWorkflow` compiles the resolved code
      // itself when no compiled scripts are handed to it.
      if (readDynamicWorkflowMetadata(workflow.executionContext)) {
        return;
      }
      if (compiledWorkflowName !== workflow.workflowName) {
        compiledWorkflowName = workflow.workflowName;
        compiledWorkflowScripts = compileWorkflowBundle(
          workflowCode,
          workflow.workflowName
        );
        // Terminal runs can return without awaiting compilation.
        void compiledWorkflowScripts.catch(() => {});
      }
      return compiledWorkflowScripts;
    }
  );
  const encryptionKey = once(() => {
    const result = resolveRunEncryptionKey(world, runId);
    void result.catch(() => {});
    return result;
  });
  let replayPayloadCache: ReplayPayloadCache | undefined;
  const startReplayPayloadCache = (
    workflow?: Pick<WorkflowRun, 'executionContext'>
  ) => {
    if (!workflow || useQuickJSVm(workflow)) return;
    if (!replayPayloadCache) {
      replayPayloadCache = new ReplayPayloadCache(encryptionKey.value);
    }
    return replayPayloadCache;
  };
  const prepareReplayEvent = (event: Event): void => {
    if (event.eventType === 'run_created') {
      startReplayPayloadCache(event.eventData);
      startWorkflowCompile(event.eventData);
    }
    replayPayloadCache?.prepareEvent(event);
  };
  /**
   * What this delivery's own committed writes owe the queue and it has not
   * sent yet: the message of each background step whose `step_created` it
   * committed, and of each inline step whose retry it moved to the
   * background with a committed `step_retrying`, by step. Filled from the
   * writer's accepted events and emptied as the messages go out, so a
   * delivery that ends early (a fence refusal, a run-ahead restart) sends
   * exactly these (see `sendUnsentMessages`).
   */
  const unsentStepMessages = new Map<
    string,
    StepMessageSpec & { retryAfter?: Date }
  >();
  /** Steps whose message this delivery sent. */
  const sentStepMessages = new Set<string>();
  /** The `wait_created` this delivery committed, by wait, until it completes. */
  const ownOpenWaits = new Map<string, Event>();
  /** Each step's creation this delivery committed, by step. */
  const ownCreationEventIds = new Map<string, string>();
  /** Waits whose timer message this delivery sent. */
  const timedWaits = new Set<string>();
  /**
   * Waits whose `wait_completed` this delivery committed: their chains are
   * this delivery's to arm (see `ownedWaitChains`). Filled from the writer's
   * accepted events, so the QuickJS engine's completions count too.
   */
  const completedWaits = new Set<string>();
  const noteCommitted = (event: Event): void => {
    const id = event.correlationId;
    if (!id) return;
    const creation = stepCreationOf(event);
    if (creation && !ownCreationEventIds.has(id)) {
      ownCreationEventIds.set(id, event.eventId);
    }
    if (event.eventType === 'step_created' && creation && !creation.inline) {
      unsentStepMessages.set(id, {
        correlationId: id,
        stepName: creation.stepName,
        stepCreatedEventId: event.eventId,
        input: event.eventData.input,
      });
    } else if (event.eventType === 'step_retrying') {
      // An inline step's retry: its next attempt goes to the step's own
      // message (a background step's retry is written by its own message).
      const data = event.eventData as {
        stepName?: string;
        attempt?: number;
        retryAfter?: Date | string;
      };
      if (data.stepName === undefined) return;
      unsentStepMessages.set(id, {
        correlationId: id,
        stepName: data.stepName,
        stepAttempt: (data.attempt ?? 1) + 1,
        ...(data.retryAfter !== undefined
          ? { retryAfter: new Date(data.retryAfter) }
          : {}),
      });
    } else if (
      event.eventType === 'step_completed' ||
      event.eventType === 'step_failed'
    ) {
      // A step with an outcome needs no message.
      unsentStepMessages.delete(id);
    } else if (event.eventType === 'wait_created') {
      ownOpenWaits.set(id, event);
    } else if (event.eventType === 'wait_completed') {
      ownOpenWaits.delete(id);
      completedWaits.add(id);
    }
  };
  const noteStepMessageSent = (correlationId: string): void => {
    unsentStepMessages.delete(correlationId);
    sentStepMessages.add(correlationId);
  };
  // Every in-band write of this delivery goes through one
  // writer, which marks it in-band, carries the fence count
  // taken from the delivery's full log load, and stops the
  // delivery for good once the World refuses it as
  // superseded. A run-ahead restart takes a fresh one.
  const newWriter = (): InBandWriter => {
    const created = new InBandWriter(world, runId);
    created.onAccepted = noteCommitted;
    return created;
  };
  let writer = newWriter();
  /**
   * Sends what {@link unsentStepMessages} and the delivery's wait timers
   * still owe. Registered by each orchestrator pass once the run is known.
   */
  let sendUnsentMessages: (() => Promise<void>) | undefined;
  // Turbo mode fast-paths the first delivery of the run's
  // first orchestrator message: the one `start()` enqueued,
  // the only one that carries `runInput`, on its first
  // delivery. On it the log holds only `run_created` (or
  // nothing, when `run_created` never landed), and no other
  // orchestrator of the run can exist yet. So it writes
  // `run_started` without waiting for it, replays against an
  // empty log without loading it (the in-band count after the
  // run's creation is known), and starts inline step bodies
  // before their `step_created`/`step_started` commit. A
  // redelivery (a handoff included) has a delivery count above
  // 1 and takes the normal path, which loads the log, and so
  // does a re-run of a delivery whose queue coalesced other
  // messages into it, which the World reports as one too.
  // A restart in place (see `MAX_RUN_AHEAD_RESTARTS`) is not turbo.
  // Never for a `start({ hook })` candidate: its `run_started`
  // may refuse it, and turbo runs inline step bodies before that
  // write returns (see `admitsTurboStart`).
  let turbo =
    isTurboEnabled() &&
    runInput !== undefined &&
    admitsTurboStart(runInput) &&
    metadata.attempt === 1 &&
    (metadata.deliveryCount ?? 1) === 1 &&
    !incomingStepId &&
    !hookInput &&
    !waitContinuation;
  span?.setAttributes(Attribute.WorkflowTurbo(turbo));
  /**
   * Turbo only: settles once the backgrounded `run_started`
   * landed, and rejects with its error if it failed. Every
   * in-band write queues behind `run_started` in `writer`,
   * which stops for good if it fails. Writes made outside the
   * writer (an optimistic step body's stream and attribute
   * writes, an out-of-band `run_failed`) wait on this.
   * `undefined` outside turbo, where `run_started` is awaited.
   */
  let runReadyBarrier: Promise<void> | undefined;
  /** Turbo only: the backgrounded `run_started` write. */
  let turboRunStarted: Promise<EventResult> | undefined;
  /**
   * Turbo only: the backgrounded `run_started`, once it
   * committed and until it joined the log.
   */
  let turboStartLanded: EventResult | undefined;
  /** Turbo only: the backgrounded `run_started` failed. */
  let turboStartFailure: { error: unknown } | undefined;
  /**
   * Whether turbo still starts inline step bodies before
   * their start commits. Ends for the rest of the delivery
   * once a suspension has a hook or a wait; an explicit
   * `WORKFLOW_OPTIMISTIC_INLINE_START=0` keeps it off.
   */
  let turboOptimistic = turbo && !isOptimisticInlineStartExplicitlyDisabled();
  // Orders a write made outside the in-band writer after the
  // backgrounded `run_started`. Swallows its failure: the
  // callers stop the delivery on their own (a guard hand-off
  // or a setup failure). No-op outside turbo.
  const awaitRunReady = async (): Promise<void> => {
    await runReadyBarrier?.catch(() => {});
  };
  // The loaded event log. `undefined` until the delivery's
  // first full load.
  let log: LoadedEventLog | undefined;
  /**
   * The slot snapshot for a write: how much of the log the
   * decision behind it was made against. Understating is safe
   * (the World reports a wider span), so it is taken from
   * whatever is loaded.
   */
  // A write names only the positions the log holds for sure:
  // never a speculative event's predicted slot, which another
  // writer may have taken. The World then reports whatever
  // took one, which is what a run-ahead repair rebuilds from.
  const slotSnapshot = (): SlotSnapshotParams =>
    log
      ? slotSnapshotParams(
          speculativeSlots.size === 0 && speculativeEvents.size === 0
            ? log.events
            : log.events.filter((event) => {
                if (speculativeEvents.has(event)) return false;
                const slot = eventIdToSlot(event.eventId);
                return slot === null || !speculativeSlots.has(slot);
              })
        )
      : {};
  /**
   * The events speculative writes placed in the log at
   * their predicted slots, until their writes confirm them
   * there, or a repair replaces them.
   */
  const speculativeEvents = new Set<Event>();
  /**
   * The responses of speculative writes that settled once a
   * repair was due, which the repair rebuilds the log from.
   */
  const repairWrites: {
    event?: Event;
    events?: Event[];
    hasMore?: boolean;
  }[] = [];
  /**
   * Run-ahead: slots of the speculative step outcomes in the
   * log, handed to the workflow before their writes commit
   * (see `writeOutcomeAhead`). A write never names one as
   * held: it may still turn out to be another writer's.
   */
  const speculativeSlots = new Set<number>();
  /**
   * Run-ahead: a speculative write committed somewhere other
   * than where the workflow consumed it. Benign (only events
   * the boundary's classification calls inert can have pushed
   * it), but the log and the retained VM hold the wrong
   * position for it, so the delivery reloads the log and
   * replays fresh once its speculative writes settle. Writes
   * are not folded into the log meanwhile.
   */
  let runAheadRepair = false;
  // Set when an accepted write could not be folded into the
  // log without leaving a hole; the next pass reads first.
  let logBehind = false;
  // Slots of this delivery's accepted in-band writes, and the
  // highest slot the latest replay pass consumed. Any other
  // event above that slot reached the log after the VM
  // decided, so the delivery must not suspend past it.
  const ownSlots = new Set<number>();
  let passConsumedSlot = 0;
  /**
   * Folds an accepted in-band write into the loaded log: its
   * skipped-slot report, then its own event, in position
   * order. Nothing out-of-band can sit between the two except
   * what the report names, so the log stays a prefix of the
   * run's log, and the next replay needs no read for this
   * delivery's own writes. A truncated or incomplete report
   * is not merged; the gap check before the next replay then
   * reloads.
   */
  const absorbWrite = (result: {
    event?: Event;
    events?: Event[];
    hasMore?: boolean;
  }): void => {
    // Turbo: the backgrounded `run_started` precedes every
    // other write of the delivery, so it joins the log first.
    // Its report carries `run_created`; without the two, every
    // later write would leave a hole below it.
    const landed = turboStartLanded;
    if (landed && landed !== result) {
      turboStartLanded = undefined;
      absorbWrite(landed);
    } else if (landed) {
      turboStartLanded = undefined;
    }
    if (!log || !result.event) return;
    // A repair due rebuilds the log from the writes' own
    // responses, this one's included.
    if (runAheadRepair) {
      repairWrites.push(result);
      return;
    }
    if (result.hasMore) {
      logBehind = true;
      return;
    }
    const own = result.event;
    const report = (result.events ?? []).filter(
      (event) => event.eventId !== own.eventId
    );
    const below = Math.max(
      maxEventSlot(log.events) ?? 0,
      maxEventSlot(report) ?? 0
    );
    const ownSlot = eventIdToSlot(own.eventId);
    if (ownSlot !== null && ownSlot > below + 1) {
      // Something sits between what this delivery holds and
      // its own write that the World did not report: read it
      // before the next replay rather than leave a hole.
      logBehind = true;
      return;
    }
    if (ownSlot !== null) ownSlots.add(ownSlot);
    // Merged events take the same payload preparation as
    // loaded ones (decryption, decompression); replay reads
    // their payloads through the same cache.
    for (const event of report) prepareReplayEvent(event);
    prepareReplayEvent(own);
    mergeReportedEvents(log.events, [...report, own]);
  };
  /** A write's events, with their payloads prepared for replay. */
  const preparedResult = <R extends EventResult>(result: R): R => {
    for (const event of result.events ?? []) {
      prepareReplayEvent(event);
    }
    if (result.event) prepareReplayEvent(result.event);
    return result;
  };
  /** The in-band writer, folding each accepted write into the log. */
  const writeInBand: EventCreator = async (data, params) => {
    const result = await writer.create(data, {
      ...slotSnapshot(),
      ...params,
    });
    absorbWrite(result);
    return result;
  };
  const createEvent = async <T extends CreateEventRequest>(
    data: T,
    params?: CreateEventParams
  ) =>
    replayRecoveryReporter.withEventCreate(
      {
        ...slotSnapshot(),
        resolveData: REPLAY_RESOLVE_DATA,
        ...params,
      },
      (p) => writeInBand(data, p)
    );
  /** Full load: replaces the log and adopts its fence snapshot. */
  const fullLoad = async (): Promise<LoadedEventLog> => {
    const loaded = await loadWorkflowRunEvents(runId);
    for (const event of loaded.events) {
      prepareReplayEvent(event);
    }
    logBehind = false;
    // Throws a World contract error for a log without a
    // snapshot, except a resilient start's empty one.
    writer.adoptSnapshot(requireLoadSnapshot(runId, loaded));
    log = { events: loaded.events, cursor: loaded.cursor };
    return log;
  };
  /**
   * Incremental load from the log's cursor. Merged in slot
   * order, since the log may already hold this delivery's
   * own writes above the cursor.
   */
  const loadAfter = async (): Promise<LoadedEventLog> => {
    logBehind = false;
    if (!log || log.cursor === null) return fullLoad();
    const page = await loadWorkflowRunEvents(runId, log.cursor);
    for (const event of page.events) {
      prepareReplayEvent(event);
    }
    mergeReportedEvents(log.events, page.events);
    log.cursor = page.cursor ?? log.cursor;
    return log;
  };

  let workflowRun: WorkflowRun | undefined;
  // Server-supplied per-run event ceiling, from the
  // `run_started` response of the delivery that wrote it.
  let maxEventsLimit: number | undefined = clampMaxEvents(undefined);
  let workflowStartedAt = -1;
  // Latency telemetry (TTFS / STSO / RSFS), see
  // runtime/step-latency.ts: whether this invocation's first
  // load held nothing beyond the run's own creation and start,
  // and when the `run_started` this delivery wrote returned.
  let invocationStartedClean: boolean | undefined;
  let runStartedReceivedAtMs: number | undefined;
  let preStepBlockingMs = 0;

  const recordWorkflowSetupFailure = async (err: unknown): Promise<boolean> => {
    if (retriesRunlessRunStarted(err, runId)) {
      span?.setAttributes(Attribute.WorkflowRunStartedRunlessResponse(true));
      return false;
    }
    const errorCode = getWorkflowSetupErrorCode(err);
    if (!errorCode) return false;
    // Turbo: the out-of-band `run_failed` follows the
    // backgrounded `run_started`. If that failed, this
    // delivery writes nothing: its error decides instead.
    if (runReadyBarrier) await runReadyBarrier;
    await recordFatalRunError({
      world,
      workflowRun,
      runId,
      workflowName,
      requestId,
      err,
      errorCode,
      logMessage: 'Fatal runtime error during workflow setup',
    });
    return true;
  };

  // A plain orchestrator wake. Omits `runInput` and the
  // recovery counters of this delivery chain.
  const replayMessage = async (): Promise<WorkflowInvokePayload> => ({
    runId,
    traceCarrier: await nextTraceCarrier(),
    requestedAt: new Date(),
  });
  /**
   * Wakes this run's orchestrator once this delivery ends, after
   * `delaySeconds`. With no delay and nothing but a plain wake to carry,
   * this delivery hands its message off instead (see
   * {@link runSpec9Delivery}).
   */
  const wakeSelf = async (
    extra?: Partial<WorkflowInvokePayload>,
    delaySeconds?: number
  ): Promise<void> => {
    const delayed = delaySeconds !== undefined && delaySeconds > 0;
    if (!delayed && extra === undefined) {
      continuation.handoff = true;
      return;
    }
    await queueMessage(
      world,
      getWorkflowQueueName(workflowName, namespace),
      { ...(await replayMessage()), ...extra },
      {
        specVersion: runSpecVersion,
        ...(delayed ? { delaySeconds } : {}),
      }
    );
  };

  // Deployment-affinity guard, shared by the two paths that
  // execute a run: queued step executions and flow replays.
  const guardDeployment = async (
    run: Pick<WorkflowRun, 'runId' | 'deploymentId' | 'specVersion'>,
    reenqueuePayload: () => Promise<WorkflowInvokePayload>,
    beforeStop?: () => Promise<void>,
    writeEvent?: EventCreator
  ): Promise<DeploymentAffinityOutcome> => {
    const { outcome, spanAttributes } = await guardDeploymentAffinity({
      world,
      run,
      workflowName,
      requestId,
      retryCount: deploymentMismatchRetryCount,
      beforeStop,
      writeEvent,
      isDeploymentUnavailableError: world.isDeploymentUnavailableError,
      reenqueue: async ({
        deploymentId,
        specVersion,
        deploymentMismatchRetryCount: retryCount,
        delaySeconds,
      }: ReenqueueArgs) => {
        await queueMessage(
          world,
          getWorkflowQueueName(workflowName, namespace),
          {
            ...(await reenqueuePayload()),
            deploymentMismatchRetryCount: retryCount,
          },
          {
            deploymentId,
            specVersion: specVersion ?? runSpecVersion,
            delaySeconds,
          }
        );
      },
    });
    if (spanAttributes) span?.setAttributes(spanAttributes);
    return outcome;
  };

  // An intermediate hop of a long wait's timer chain (see
  // `waitTimerMessage`): the World delivers it beside a running orchestrator
  // of the run, so it reads nothing but the run's status, writes nothing,
  // sends the next hop and acknowledges.
  const hopResumeAtMs = waitContinuation?.resumeAtMs;
  if (waitContinuation && hopResumeAtMs !== undefined) {
    let run = prefetchedRun;
    try {
      run ??= (await world.runs.get(runId, { resolveData: 'none' })) as
        | WorkflowRun
        | undefined;
    } catch (err) {
      if (!WorkflowRunNotFoundError.is(err)) throw err;
    }
    if (!run || isTerminalWorkflowRunStatus(run.status)) return undefined;
    const now = Date.now();
    const next = waitTimerMessage({
      correlationId: waitContinuation.correlationId,
      resumeAtMs: hopResumeAtMs,
      seconds: Math.max(0, Math.ceil((hopResumeAtMs - now) / 1000)),
      nowMs: now,
    });
    runtimeLogger.debug('Wait timer hop; sending the next hop', {
      workflowRunId: runId,
      correlationId: waitContinuation.correlationId,
      delaySeconds: next.delaySeconds,
      intermediate: next.waitContinuation.resumeAtMs !== undefined,
    });
    span?.setAttributes(Attribute.WorkflowNoopDelivery(true));
    await wakeSelf(
      { waitContinuation: next.waitContinuation },
      next.delaySeconds
    );
    return undefined;
  }

  // A message with a stepId is a background step's own
  // message. Its invocation runs the body and reports the
  // outcome; it never replays the workflow.
  if (incomingStepId && incomingStepName) {
    const stepResumeTracking = resumeTracking;
    resumeTracking = undefined;
    try {
      return await handleStepMessage({
        world,
        runId,
        workflowName,
        namespace,
        requestId,
        payload: {
          stepId: incomingStepId,
          stepName: incomingStepName,
          stepAttempt,
          stepInput,
          stepCreatedEventId,
          runContext,
        },
        prefetchedRun,
        meta: metadata,
        resumeTracking: stepResumeTracking,
        span,
        nextTraceCarrier,
        guardDeployment: async (run) =>
          (await guardDeployment(run, async () => ({
            ...(await replayMessage()),
            stepId: incomingStepId,
            stepName: incomingStepName,
            ...(stepAttempt ? { stepAttempt } : {}),
            ...(stepInput ? { stepInput } : {}),
            ...(stepCreatedEventId ? { stepCreatedEventId } : {}),
            ...(runContext ? { runContext } : {}),
            ...(hookResumeTiming ? { hookResumeTiming } : {}),
          }))) === 'continue',
      });
    } catch (err) {
      const errorCode = getWorkflowSetupErrorCode(err);
      if (!errorCode) {
        throw err;
      }
      await recordFatalRunError({
        world,
        workflowRun,
        runId,
        workflowName,
        requestId,
        err,
        errorCode,
        logMessage: 'Fatal error while preparing background workflow step',
      });
      return;
    }
  }

  // --- Orchestrator delivery ---
  // A delivery with nothing new since the position this
  // process last consumed, and no due timer, exits without a
  // replay. Only consulted when this process holds a
  // position for the run, so a miss costs nothing.
  // A timer delivery is excluded: one that arrives before its
  // wait is due (a long sleep spans several queue hops) has
  // to arm the next hop, which a no-op exit would skip. So is
  // a redelivery: it may owe what an earlier delivery of its
  // message created and never sent (see `creator-rules.ts`).
  if (
    (creatorDeliveryCount ?? 1) === 1 &&
    !runInput &&
    !hookInput &&
    !waitContinuation &&
    wakeUpWaits.size === 0 &&
    hasConsumedPosition(world, runId)
  ) {
    const tail = await world.events.list({
      runId,
      pagination: { sortOrder: 'desc', limit: 1 },
      resolveData: 'none',
    });
    const tailId = tail.data[0]?.eventId;
    const tailSlot =
      tailId === undefined ? undefined : (eventIdToSlot(tailId) ?? undefined);
    if (
      isNoopDelivery({
        world,
        runId,
        tailSlot,
        nowMs: Date.now(),
      })
    ) {
      span?.setAttributes(Attribute.WorkflowNoopDelivery(true));
      runtimeLogger.debug(
        'Nothing new since the last consumed position; acknowledging without a replay',
        { workflowRunId: runId, tailSlot }
      );
      return;
    }
  }

  while (true) {
    try {
      return await orchestrate();
    } catch (caught) {
      // A failed turbo `run_started` decides the delivery, as
      // a failed awaited `run_started` does on the normal path,
      // whatever later write surfaced it.
      const err = turboStartFailure ? turboStartFailure.error : caught;
      if (OrchestratorSupersededError.is(err) || writer.isSuperseded) {
        forgetConsumedPosition(world, runId);
        // Expected, so not an error: another orchestrator invocation of the
        // run wrote in-band (an overlap the queue let through, such as a
        // delivery that outlived its lease), or the World sealed this
        // writer's own position (its write took longer than the World's
        // staleness bound), or a write the World refused after allocating
        // its position moved the count past this writer's.
        runtimeLogger.info(
          'Orchestrator write refused by the in-band fence; sending the messages its own writes owe and a wake, and acknowledging',
          {
            workflowRunId: runId,
            loopIteration,
            unsentStepMessages: unsentStepMessages.size,
            expectedSeqInBand: writer.expectedSeqInBand,
          }
        );
        span?.setAttributes(Attribute.WorkflowSuperseded(true));
        continuation.exit = `superseded:${(err as Error)?.message?.slice(0, 200)}`;
        // What this delivery's committed writes owe the queue goes out
        // first: no other delivery is their creator, so none would send
        // them. A crash before they do redelivers this message, whose
        // creator rules re-send them.
        await sendUnsentMessages?.();
        // Then one plain orchestrator wake, because a refusal does not prove
        // that another orchestrator is running: the World also refuses a
        // write whose own position it sealed, or one behind a refused write
        // that allocated, and then nothing else is queued for the run. The
        // wake is an ordinary orchestrator message (keyed where the World
        // keys them) and carries nothing the log does not hold. A World
        // that coalesces folds it into the delivery that holds the run: a
        // live winner, at no cost, or this delivery itself, whose
        // acknowledgment is then refused and which runs again from a fresh
        // load in the same invocation (the World bounds those re-runs and
        // hands the message off past the bound). A World that serializes
        // delivers it after the running delivery.
        await queueMessage(
          world,
          getWorkflowQueueName(workflowName, namespace),
          await replayMessage(),
          { specVersion: runSpecVersion }
        );
        continuation.handoff = false;
        return undefined;
      }
      if (
        !turboStartFailure &&
        (RunAheadStopError.is(err) || RunAheadStopError.is(writer.stopCause))
      ) {
        forgetConsumedPosition(world, runId);
        // The outcomes a hazard stop still lets through are
        // queued behind the refused writes: they commit first.
        await writer.idle();
        const reason = RunAheadStopError.is(err)
          ? err.reason
          : (writer.stopCause as RunAheadStopError).reason;
        // The restarted pass decides from the log, and on a first delivery
        // its creator rules re-send nothing (see `creator-rules.ts`): the
        // messages this delivery's commits owe go out now.
        await sendUnsentMessages?.();
        if (runAheadRestarts >= MAX_RUN_AHEAD_RESTARTS) {
          runtimeLogger.info(
            'Run-ahead stopped again after a restart in place; handing the run to the next delivery',
            { workflowRunId: runId, reason, runAheadRestarts }
          );
          continuation.exit = `run-ahead-stop-handoff:${reason}`;
          continuation.handoff = true;
          return undefined;
        }
        runAheadRestarts++;
        runtimeLogger.info(
          'Run-ahead stopped before writing from a speculative state; continuing in place from a fresh load',
          { workflowRunId: runId, reason, runAheadRestarts }
        );
        continuation.exit = `run-ahead-restart:${reason}`;
        restartInPlace();
        continue;
      }
      if (turboStartFailure) {
        // Defensive: turbo is off for start Hook candidates, so a
        // backgrounded `run_started` never decides one.
        if (ackRefusedStartHookCandidate(err, runInput, runId)) {
          return undefined;
        }
        if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
          runtimeLogger.info('Run already finished during setup, skipping', {
            workflowRunId: runId,
            message: (err as Error).message,
          });
          return undefined;
        }
        // Nothing else of this delivery reached the World, so
        // a setup error can still be recorded.
        runReadyBarrier = undefined;
        if (await recordWorkflowSetupFailure(err)) {
          return undefined;
        }
      }
      throw err;
    }
  }

  /**
   * Resets the delivery for a fresh orchestrator pass in this same delivery
   * after run-ahead stopped it: a fresh writer, which adopts the count of
   * the next full load, no log and no speculative state, no turbo, and no
   * run-ahead for the rest of the delivery. What it already sent stays sent
   * (`sentStepMessages`, `timedWaits`).
   */
  function restartInPlace(): void {
    writer = newWriter();
    log = undefined;
    speculativeEvents.clear();
    speculativeSlots.clear();
    repairWrites.length = 0;
    runAheadRepair = false;
    logBehind = false;
    passConsumedSlot = 0;
    turbo = false;
    turboOptimistic = false;
    turboStartLanded = undefined;
    turboRunStarted = undefined;
    runReadyBarrier = undefined;
    sendUnsentMessages = undefined;
  }

  /**
   * `run_started` for this delivery. On a first delivery
   * it carries the creation data from `runInput`, so a
   * World that never saw `run_created` creates the run
   * from it (resilient start).
   */
  function runStartedRequest() {
    return {
      eventType: 'run_started' as const,
      specVersion: runInput?.specVersion ?? SPEC_VERSION_CURRENT,
      ...(runInput
        ? {
            eventData: {
              input: runInput.input,
              deploymentId: runInput.deploymentId,
              workflowName: runInput.workflowName,
              executionContext: runInput.executionContext,
              attributes: runInput.attributes,
              allowReservedAttributes: runInput.allowReservedAttributes,
              dynamicWorkflowCode: runInput.dynamicWorkflowCode,
              dynamicWorkflowCodeRef: runInput.dynamicWorkflowCodeRef,
              // Without the key, a run this event creates could
              // never receive sealed writes.
              encryptionPublicKey: runInput.encryptionPublicKey,
              // The queued copy of `start({ hook })`: this write may
              // be the one that admits or refuses the candidate.
              startHook: runInput.startHook,
            },
          }
        : {}),
    };
  }

  /**
   * Turbo setup: writes `run_started` in the background and
   * returns the run synthesized from `runInput`. The log is
   * empty, and the fence count is the one right after the
   * run's creation, which is what a load would have found.
   */
  function startTurbo(input: RunInput): WorkflowRun {
    writer.adoptSnapshot({
      seq: FIRST_EVENT_SLOT,
      seqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
    });
    // The log as the World holds it: the run's creation at the
    // first position (a resilient start's `run_started`
    // creates it there too). Writes of this delivery then
    // join it in position order from the first one, whether
    // or not the World reports what lies below them.
    log = {
      events: [turboRunCreatedEvent(runId, input)],
      cursor: null,
    };
    span?.addEvent('workflow.run_started.create.start', {
      'workflow.run_started.skip_preload': true,
    });
    // Nothing reads this response's log page: the write is
    // a barrier, and its own event and skipped-slot report
    // are folded into the log like any in-band write's.
    const started = writer.createRequired(runStartedRequest(), {
      requestId,
      skipPreload: true,
      resolveData: REPLAY_RESOLVE_DATA,
    });
    turboRunStarted = started;
    runReadyBarrier = started.then(
      (result) => {
        turboStartLanded = result;
        const limit = clampMaxEvents(result.maxEvents);
        if (limit !== undefined) maxEventsLimit = limit;
      },
      (error: unknown) => {
        turboStartFailure = { error };
        throw error;
      }
    );
    // Observed by every gated write; this only keeps an
    // early failure from surfacing as unhandled.
    runReadyBarrier.catch(() => {});
    const now = new Date();
    // The run as `run_started` will have made it. Seed
    // attributes ride in `runInput` (they live on
    // `run_created`, not in `attr_set` events), so the
    // snapshot carries them although the log is not loaded.
    // This holds while attributes are write-only inside a
    // workflow: an in-workflow read API would have to read
    // this snapshot, not replay `run_created`/`attr_set`, or
    // it would see no seed attributes on this delivery only.
    // A dynamic run's code rides the message for the same
    // reason; without it (too large to send inline)
    // `resolveWorkflowCodeForRun` reads it from the run.
    return {
      runId,
      status: 'running',
      deploymentId: input.deploymentId,
      workflowName: input.workflowName,
      specVersion: input.specVersion,
      executionContext: input.executionContext,
      input: input.input,
      ...(input.dynamicWorkflowCode
        ? { dynamicWorkflowCode: input.dynamicWorkflowCode }
        : {}),
      attributes: input.attributes ?? {},
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    } as WorkflowRun;
  }

  async function orchestrate(): Promise<
    { timeoutSeconds: number } | undefined
  > {
    let run: WorkflowRun | undefined;
    if (turbo && runInput) {
      run = startTurbo(runInput);
      try {
        startWorkflowCompile(runInput);
        startReplayPayloadCache(runInput);
        for (const event of log?.events ?? []) {
          prepareReplayEvent(event);
        }
      } catch (err) {
        // Recorded behind the backgrounded `run_started`.
        if (!(await recordWorkflowSetupFailure(err))) throw err;
        return undefined;
      }
      // Turbo synthesizes the run before the response that
      // would anchor RSFS, so the synthesis anchors it.
      runStartedReceivedAtMs = +(run.startedAt as Date);
      if (resumeTracking) {
        resumeTracking.setupSource = 'run_started';
      }
      // AUTHORITATIVE deployment-affinity protection, before
      // replay or inline step execution. Both of its
      // stopping actions hand the run off, so they wait for
      // the backgrounded `run_started` first.
      if (
        (await guardDeployment(
          run,
          replayMessage,
          awaitRunReady,
          writeInBand
        )) !== 'continue'
      ) {
        return undefined;
      }
    } else {
      // --- Run setup: full load (with the fence snapshot) ---
      const [loadOutcome, runOutcome] = await Promise.allSettled([
        fullLoad(),
        prefetchedRun ?? world.runs.get(runId, { resolveData: 'none' }),
      ]);
      run =
        runOutcome.status === 'fulfilled'
          ? (runOutcome.value as WorkflowRun)
          : undefined;
      if (!run) {
        if (!runInput) {
          throw runOutcome.status === 'rejected'
            ? runOutcome.reason
            : new WorkflowRuntimeError(`Workflow run "${runId}" not found`);
        }
        // Resilient start: `run_created` never landed, and this
        // first delivery carries what the World needs to create
        // the run from `run_started`. A load that failed left no
        // snapshot; the run holds no in-band position yet.
        log = { events: [], cursor: null };
        if (!writer.hasSnapshot) {
          writer.adoptSnapshot(RESILIENT_START_SNAPSHOT);
        }
      } else if (loadOutcome.status === 'rejected') {
        // A World contract error on the log load fails the run
        // (out-of-band, since there is no fence snapshot); any
        // other load failure redelivers.
        workflowRun ??= run;
        if (await recordWorkflowSetupFailure(loadOutcome.reason)) {
          return undefined;
        }
        throw loadOutcome.reason;
      }
      if (run && isTerminalWorkflowRunStatus(run.status)) {
        runtimeLogger.info('Workflow already completed or failed, skipping', {
          workflowRunId: runId,
          status: run.status,
        });
        return undefined;
      }
      assert(log, 'The event log is loaded before setup');
      // AUTHORITATIVE deployment-affinity protection, before
      // this delivery writes anything (`run_started` included)
      // and before replay or inline step execution.
      if (
        run &&
        (await guardDeployment(
          run,
          async () => ({
            ...(await replayMessage()),
            ...(hookInput ? { hookInput } : {}),
            ...(hookResumeTiming ? { hookResumeTiming } : {}),
          }),
          undefined,
          // The log is loaded, so the orchestrator's own
          // DEPLOYMENT_MISMATCH failure is written in-band.
          writeInBand
        )) !== 'continue'
      ) {
        return undefined;
      }
      const hasRunStarted = log.events.some(
        (event) => event.eventType === 'run_started'
      );
      if (!hasRunStarted) {
        try {
          startWorkflowCompile(runInput);
          startReplayPayloadCache(runInput);
          span?.addEvent('workflow.run_started.create.start', {
            'workflow.run_started.skip_preload': false,
          });
          const started = await createEvent(runStartedRequest(), {
            requestId,
          });
          run = started.run ?? run;
          maxEventsLimit = clampMaxEvents(started.maxEvents);
          runStartedReceivedAtMs = Date.now();
          if (resumeTracking) {
            resumeTracking.setupSource = 'run_started';
          }
        } catch (err) {
          // A refused `start({ hook })` candidate: nothing ran and
          // it never becomes a run. Narrowed to the two admission
          // answers; every other error keeps its handling below.
          if (ackRefusedStartHookCandidate(err, runInput, runId)) {
            return undefined;
          }
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            runtimeLogger.info('Run already finished during setup, skipping', {
              workflowRunId: runId,
              message: err.message,
            });
            return undefined;
          }
          if (!(await recordWorkflowSetupFailure(err))) {
            throw err;
          }
          return undefined;
        }
        // The log now holds the run's own start (and, after a
        // resilient start, its creation).
        await fullLoad();
      } else if (resumeTracking) {
        resumeTracking.setupSource = 'event_load';
      }
    }
    assert(run, 'Workflow run must be loaded before replay');
    assert(log, 'The event log is loaded before replay');
    invocationStartedClean = log.events.every(
      (e) =>
        e.eventType === 'run_created' ||
        e.eventType === 'run_started' ||
        e.eventType === 'attr_set' ||
        isSealedNoopEvent(e)
    );
    const runCreated = log.events.find(
      (event) => event.eventType === 'run_created'
    );
    // A log without `run_created` (a legacy run, or a World
    // whose log starts later) takes the input from the run.
    let runInputValue: unknown;
    try {
      runInputValue = runCreated
        ? runCreated.eventData.input
        : turbo && runInput
          ? runInput.input
          : (
              await world.runs.get(runId, {
                resolveData: 'all',
              })
            ).input;
    } catch (err) {
      if (!(await recordWorkflowSetupFailure(err))) throw err;
      return undefined;
    }
    const runStarted = log.events.find(
      (event) => event.eventType === 'run_started'
    );
    workflowRun = {
      ...run,
      input: runInputValue,
      status: 'running',
      output: undefined,
      error: undefined,
      completedAt: undefined,
      startedAt: run.startedAt ?? runStarted?.createdAt ?? new Date(),
    } as WorkflowRun;
    workflowStartedAt = +(workflowRun.startedAt as Date);
    startWorkflowCompile(workflowRun);
    const runForMessages = workflowRun;
    sendUnsentMessages = () => sendOwedMessages(runForMessages);
    span?.setAttributes({
      ...Attribute.WorkflowRunStatus('running'),
      ...Attribute.WorkflowStartedAt(workflowStartedAt),
    });

    // Legacy lazy hook resume: an older producer sent the
    // payload on this message only. The orchestrator writes
    // the `hook_received` itself (in-band), deduplicated by
    // `resumeId`.
    if (
      hookInput &&
      !log.events.some(
        (event) =>
          event.eventType === 'hook_received' &&
          event.resumeId === hookInput.resumeId
      )
    ) {
      let occurredAt: Date | undefined;
      try {
        occurredAt = new Date(decodeTime(hookInput.resumeId));
      } catch {
        occurredAt = undefined;
      }
      try {
        await createEvent(
          {
            eventType: 'hook_received',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: hookInput.hookId,
            eventData: {
              token: hookInput.token,
              payload: hookInput.payload,
            },
          },
          {
            requestId,
            occurredAt,
            resumeId: hookInput.resumeId,
            resumePayloadDigest: hookInput.payloadDigest,
          }
        );
        span?.setAttributes(Attribute.HookResilientResumeMaterialized(true));
      } catch (err) {
        if (HookNotFoundError.is(err) || RunExpiredError.is(err)) {
          return undefined;
        }
        throw err;
      }
      await loadAfter();
    }

    let resolvedWorkflowCode: ResolvedWorkflowCode;
    try {
      resolvedWorkflowCode = await resolveWorkflowCodeForRun(
        workflowCode,
        workflowRun,
        () => encryptionKey.value,
        world,
        async () => {}
      );
    } catch (err) {
      if (!(await recordWorkflowSetupFailure(err))) {
        throw err;
      }
      return undefined;
    }
    const effectiveWorkflowCode = resolvedWorkflowCode.code;
    const dynamicWorkflowMetadata = resolvedWorkflowCode.dynamicWorkflow;
    if (dynamicWorkflowMetadata) {
      span?.setAttributes({
        ...Attribute.WorkflowDynamic(true),
        ...Attribute.WorkflowDynamicSourceHash(
          dynamicWorkflowMetadata.sourceHash
        ),
      });
      runLogger.info('Executing stored dynamic workflow code', {
        sourceHash: dynamicWorkflowMetadata.sourceHash,
      });
    }
    const dynamicWorkflowScripts =
      dynamicWorkflowMetadata && !useQuickJSVm(workflowRun)
        ? compileDynamicWorkflowBundle(
            effectiveWorkflowCode,
            workflowRun.workflowName
          )
        : undefined;

    // --- QuickJS VM engine dispatch ---
    if (useQuickJSVm(workflowRun)) {
      const { runWorkflowWithQuickJS } = await import(
        './quickjs-entrypoint.js'
      );
      try {
        const quickjsResult = await runWorkflowWithQuickJS({
          workflowCode: effectiveWorkflowCode,
          workflowName,
          workflowRun,
          preloadedEvents: log.events,
          preloadedEventsComplete: true,
          preloadedCursor: log.cursor,
          runInput,
          parentSpan: span,
          maxEventsLimit,
          namespace,
          nextTraceCarrier,
          waitContinuation,
          deliveryAttempt: creatorDeliveryCount,
          ownerMessageId: creatorMessageId,
          lingerDeadlineMs:
            invocationStartTime +
            noInlineReplayAfterMs -
            getInlineStepDeadlineMarginMs(),
          continueInNextDelivery: () => {
            continuation.exit = 'quickjs-continue';
            return wakeSelf();
          },
          requestId,
          writer,
          onStepMessageSent: noteStepMessageSent,
          onWaitTimerSent: (correlationId) => timedWaits.add(correlationId),
          completedWaits,
          ...(wakeUpWaits.size > 0 ? { wakeUpWaits } : {}),
          ...(turboRunStarted && runReadyBarrier
            ? {
                turbo: {
                  runStarted: turboRunStarted,
                  runReadyBarrier,
                  optimistic: turboOptimistic,
                },
              }
            : {}),
        });
        if (quickjsResult?.timeoutSeconds !== undefined) {
          await wakeSelf(undefined, quickjsResult.timeoutSeconds);
        }
        return undefined;
      } catch (err) {
        if (
          OrchestratorSupersededError.is(err) ||
          turboStartFailure ||
          isRetryableWorldError(err) ||
          isQueueSendFailure(err)
        ) {
          throw err;
        }
        return await failRun(err, effectiveWorkflowCode);
      }
    }

    let session: WorkflowSession | null = null;
    const continuedHookIds = new Set<string>();

    // Inline steps run as background work of this delivery,
    // so the VM keeps advancing (a due timer, a hook payload,
    // a sibling's outcome) while a body runs. Their writes
    // and the live feed's events are buffered and folded into
    // the log only between passes, never under a replay.
    type InlineSettled = {
      spec: InlineStepSpec;
      outcome: PromiseSettledResult<Awaited<ReturnType<typeof executeStep>>>;
    };
    const inFlight = new Map<string, Promise<void>>();
    // Every step whose body this delivery started. A body can
    // settle while a pass replays, before its outcome is
    // folded in, and that pass must not read the step as an
    // unfinished inline step to run again.
    const ranInline = new Set<string>();
    // Inline steps whose retry moved to the background: their
    // later events come from the step's own message.
    const retriedInBackground = new Set<string>();
    /**
     * Whether a live-feed event is this delivery's own write
     * echoed back, so it brings the workflow nothing new: a
     * slot its own write was answered with, an event of one of
     * its inline steps (only this delivery writes those, until
     * a retry moves the step to its own message), or one
     * already in the log.
     */
    const isOwnEvent = (event: Event): boolean => {
      const slot = eventIdToSlot(event.eventId);
      if (slot !== null && ownSlots.has(slot)) return true;
      // Turbo: the run's creation and this delivery's
      // backgrounded start, echoed before they joined the log.
      if (
        turbo &&
        (event.eventType === 'run_created' || event.eventType === 'run_started')
      ) {
        return true;
      }
      if (
        event.eventType.startsWith('step_') &&
        event.correlationId !== undefined &&
        ranInline.has(event.correlationId) &&
        !retriedInBackground.has(event.correlationId)
      ) {
        return true;
      }
      return log?.events.some((e) => e.eventId === event.eventId) ?? false;
    };
    const settledInline: InlineSettled[] = [];
    // Creation commits still in flight while the bodies they
    // create run (turbo's `optimisticCreation`), a fan-out's
    // later creation batches, and step dispatches sent next to
    // inline bodies. No pass decides, and the delivery does not
    // end, before they settled.
    const creationsInFlight = new Set<Promise<unknown>>();
    // A fan-out's later creation batches not yet queued on
    // the writer (`commitInChunks().queued`). An inline step's
    // outcome waits for them, so it is queued behind every
    // creation batch rather than between two of them, where
    // it would hold up the background creations behind it.
    const creationBatchesQueuing = new Set<Promise<void>>();
    // Why a fan-out's later creation batches, or a step
    // dispatch that runs next to inline bodies, failed. The
    // delivery fails with it, so its redelivery writes and
    // sends what is missing.
    let trailingCreationFailure: unknown;
    /**
     * Tracks a creation batch or step dispatch that settles
     * in the background of the delivery: in
     * `creationsInFlight` until it settles, its failure kept
     * in `trailingCreationFailure`.
     */
    const trackInFlightCreation = (work: Promise<unknown>): void => {
      const inFlightCreation = work.then(
        () => {},
        (error: unknown) => {
          trailingCreationFailure ??= error;
          notifyProgress();
        }
      );
      creationsInFlight.add(inFlightCreation);
      void inFlightCreation.then(() =>
        creationsInFlight.delete(inFlightCreation)
      );
    };
    // The longest backoff of the inline starts this delivery
    // had refused for load. Once every body has settled the
    // delivery defers the run by it.
    let throttledSeconds: number | undefined;
    const pendingAbsorbs: Array<Parameters<typeof absorbWrite>[0]> = [];
    const pendingFeedEvents: Event[] = [];
    let liveFeed: LiveLogFeed | undefined;
    // Set when an inline step finished with stream writes
    // still flushing; the delivery hands off once no body runs.
    let pendingStreamOps = false;
    type InlineProgress =
      | {
          type: 'return';
          result: { timeoutSeconds: number } | undefined;
        }
      | { type: 'reload-full' }
      | { type: 'continue'; retainSession: boolean };
    let progressDirty = false;
    let progressWaiter: (() => void) | undefined;
    const notifyProgress = (): void => {
      progressDirty = true;
      const waiter = progressWaiter;
      progressWaiter = undefined;
      waiter?.();
    };
    /** Folds buffered feed events and inline writes into the log. */
    const flushPending = (): void => {
      if (!log) return;
      if (turboStartLanded) absorbWrite(turboStartLanded);
      if (pendingFeedEvents.length > 0) {
        const events = pendingFeedEvents.splice(0).filter((event) => {
          const slot = eventIdToSlot(event.eventId);
          if (slot !== null) writer.observeSlot(slot);
          checkRunAheadHazard(event, 'live feed');
          // A speculative position is the delivery's own
          // until its write confirms or repairs it.
          if (slot !== null && speculativeSlots.has(slot)) {
            const own = speculationsBySlot.get(slot);
            if (
              own &&
              (own.event.eventType !== event.eventType ||
                own.event.correlationId !== event.correlationId)
            ) {
              markRunAheadRepair('feed');
            }
            return false;
          }
          return !runAheadRepair;
        });
        for (const event of events) prepareReplayEvent(event);
        mergeReportedEvents(log.events, events);
      }
      if (pendingAbsorbs.length > 0) {
        const results = pendingAbsorbs.splice(0);
        results.sort(
          (a, b) =>
            (eventIdToSlot(a.event?.eventId ?? '') ?? 0) -
            (eventIdToSlot(b.event?.eventId ?? '') ?? 0)
        );
        for (const result of results) absorbWrite(result);
      }
    };
    /** Waits for the next settle, feed event or due timer. */
    const waitForProgress = async (): Promise<void> => {
      if (progressDirty) {
        progressDirty = false;
        return;
      }
      const timer = log ? nextTimerAt(log.events) : {};
      const delayMs =
        timer.nextTimerAtMs === undefined
          ? undefined
          : Math.max(0, timer.nextTimerAtMs - Date.now());
      let handle: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        progressWaiter = resolve;
        if (delayMs !== undefined) {
          handle = setTimeout(resolve, delayMs);
        }
      });
      if (handle) clearTimeout(handle);
      progressWaiter = undefined;
      progressDirty = false;
    };
    /** Starts the live feed from the loaded log, once. */
    const ensureLiveFeed = (): void => {
      if (liveFeed || !log) return;
      liveFeed = new LiveLogFeed(world, runId, {
        afterSlot: maxEventSlot(log.events) ?? 0,
        cursor: log.cursor,
        pollIntervalMs: getOrchestratorPollIntervalMs(),
        onEvents: (events) => {
          pendingFeedEvents.push(...events);
          notifyProgress();
        },
      });
      liveFeed.start();
    };
    /** Lets every running inline body settle; stops the feed. */
    const drainInline = async (): Promise<void> => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()]);
      }
      // A fan-out's later creation batches and their step
      // messages go out before the delivery ends.
      while (creationsInFlight.size > 0) {
        await Promise.allSettled([...creationsInFlight]);
      }
      // Speculative outcome writes settle before the delivery
      // ends, whichever way it ends.
      await settleRunAhead();
      liveFeed?.stop();
      liveFeed = undefined;
      if (trailingCreationFailure !== undefined) {
        throw trailingCreationFailure;
      }
    };

    /**
     * Whether the log holds an event above what the latest
     * pass consumed that this delivery did not write.
     */
    const hasUnconsumedForeignEvent = (events: readonly Event[]): boolean =>
      events.some((event) => {
        const slot = eventIdToSlot(event.eventId);
        return (
          slot !== null &&
          slot > passConsumedSlot &&
          !ownSlots.has(slot) &&
          !speculativeSlots.has(slot) &&
          event.eventType !== 'noop'
        );
      });

    // --- Run-ahead (runtime/out-of-band-observation.ts) ---
    // At a boundary whose classification is inert, an inline
    // step's outcome is handed to the workflow as soon as its
    // body returns, while its `step_completed`/`step_failed`
    // is still in flight, so consecutive steps overlap their
    // writes. At most `runAheadDepth` such writes are
    // unconfirmed at once. Every write still goes through the
    // in-band writer in decision order, and a speculative one
    // is a required write: any failure stops the writer, so
    // nothing is written from a speculative state after it.
    // The World stores an in-band write at the time the
    // orchestrator chose (`Storage.events`), so the workflow can
    // see that time before the write commits. One found not to
    // is excluded for the rest of the process.
    // Off for the rest of a delivery that run-ahead stopped once.
    const runAheadDepth =
      isRunAheadDisabledFor(world) || runAheadRestarts > 0
        ? 0
        : getRunAheadDepth();
    /** A speculative write in flight, by the slot it holds. */
    type Speculation = {
      event: Event;
      settled: Promise<void>;
    };
    /**
     * Steps whose speculative outcome is in flight: the steps
     * the workflow has moved past without a confirmed write.
     * `runAheadDepth` bounds them.
     */
    const unconfirmedOutcomes = (): Set<string> =>
      new Set(
        [...speculationsBySlot.values()].flatMap((s) =>
          (s.event.eventType === 'step_completed' ||
            s.event.eventType === 'step_failed') &&
          s.event.correlationId
            ? [s.event.correlationId]
            : []
        )
      );
    /**
     * Whether the delivery may run ahead: of the outcomes of
     * `stepIds` within the depth, or (without ids) start new
     * steps ahead of their creation's commit while the
     * outcomes in flight are within it.
     */
    const withinRunAheadDepth = (stepIds: readonly string[] = []): boolean => {
      if (runAheadRepair || runAheadFailure !== undefined || writer.isStopped) {
        return false;
      }
      const steps = unconfirmedOutcomes();
      for (const id of stepIds) steps.add(id);
      return steps.size <= runAheadDepth;
    };
    const speculationsBySlot = new Map<number, Speculation>();
    /** Set when a speculative write failed; the delivery stops. */
    let runAheadFailure: unknown;
    /**
     * The classifications under which speculative writes are
     * in flight: what may and may not land below them.
     */
    const runAheadContexts = new Set<RunAheadContext>();
    /**
     * For each speculative event whose write committed at
     * another slot, the id it committed under.
     */
    const repairAliases = new Map<string, string>();
    /**
     * Hooks some boundary of the current run-ahead was
     * sensitive to: an event of one of them below a
     * speculative write is not admitted into a retained
     * session on repair.
     */
    const runAheadSensitiveHookIds = new Set<string>();
    /** Handed to the next resume of the retained session. */
    let pendingRebase: WorkflowSessionRebase | undefined;
    const noteRunAheadContext = (context: RunAheadContext): void => {
      runAheadContexts.add(context);
      for (const id of context.sensitiveHookIds) {
        runAheadSensitiveHookIds.add(id);
      }
    };
    const runAheadStats = {
      runAhead: 0,
      drained: 0,
      depthCap: 0,
      failureStops: 0,
      hazardStops: 0,
      /**
       * Repairs: another writer took a slot a speculative
       * write was placed at, so its events are re-placed.
       * Counted once per repair, by what found it first.
       */
      repairs: 0,
      repairsByCause: { feed: 0, outcome: 0, creation: 0 },
      /** Wall time spent repairing, in milliseconds. */
      repairMs: 0,
      /** Repairs whose retained session survived them. */
      repairsRetained: 0,
      /** Repairs that had to read the log after all. */
      repairReads: 0,
    };
    const markRunAheadRepair = (
      cause: 'feed' | 'outcome' | 'creation'
    ): void => {
      if (runAheadRepair) return;
      runAheadRepair = true;
      runAheadStats.repairs++;
      runAheadStats.repairsByCause[cause]++;
      recordRunAheadSpan();
    };
    const outOfBandBoundaries = {
      inert: 0,
      observedHook: 0,
      unknownHook: 0,
      abortSignal: 0,
      externalStep: 0,
      waitDue: 0,
    };
    const recordRunAheadSpan = (): void => {
      span?.setAttributes({
        'workflow.out_of_band.inert_boundaries': outOfBandBoundaries.inert,
        'workflow.out_of_band.observed_hook_boundaries':
          outOfBandBoundaries.observedHook,
        'workflow.out_of_band.unknown_hook_boundaries':
          outOfBandBoundaries.unknownHook,
        'workflow.out_of_band.abort_signal_boundaries':
          outOfBandBoundaries.abortSignal,
        'workflow.out_of_band.external_step_boundaries':
          outOfBandBoundaries.externalStep,
        'workflow.out_of_band.wait_due_boundaries': outOfBandBoundaries.waitDue,
        'workflow.run_ahead.depth': runAheadDepth,
        'workflow.run_ahead.boundaries': runAheadStats.runAhead,
        'workflow.run_ahead.drained_boundaries': runAheadStats.drained,
        'workflow.run_ahead.depth_cap_steps': runAheadStats.depthCap,
        'workflow.run_ahead.failure_stops': runAheadStats.failureStops,
        'workflow.run_ahead.hazard_stops': runAheadStats.hazardStops,
        'workflow.run_ahead.repairs': runAheadStats.repairs,
        'workflow.run_ahead.repairs.feed': runAheadStats.repairsByCause.feed,
        'workflow.run_ahead.repairs.outcome':
          runAheadStats.repairsByCause.outcome,
        'workflow.run_ahead.repairs.creation':
          runAheadStats.repairsByCause.creation,
        'workflow.run_ahead.repair_ms': runAheadStats.repairMs,
        'workflow.run_ahead.repairs_retained': runAheadStats.repairsRetained,
        'workflow.run_ahead.repair_reads': runAheadStats.repairReads,
      });
    };
    /**
     * Stops the delivery on an event that lands below an
     * unconfirmed speculative write and would have made the
     * boundary it ran ahead of path-changing. The
     * classification and the in-band fence rule this out, so
     * it is loud: the writer stops before anything else is
     * written, and the redelivery decides from the log.
     */
    function checkRunAheadHazard(event: Event, source: string): void {
      if (speculationsBySlot.size === 0) return;
      // Every step this delivery runs inline writes its own
      // events; the hooks are those any boundary still in
      // flight was sensitive to.
      const sensitiveHookIds = new Set<string>();
      const selfStepIds = new Set<string>([...ranInline, ...inFlight.keys()]);
      for (const context of runAheadContexts) {
        for (const id of context.sensitiveHookIds) {
          sensitiveHookIds.add(id);
        }
        for (const id of context.selfStepIds) {
          selfStepIds.add(id);
        }
      }
      const reason = runAheadHazard(
        event,
        { sensitiveHookIds, selfStepIds },
        isOwnOrKnownEvent
      );
      if (!reason) return;
      runAheadStats.hazardStops++;
      recordRunAheadSpan();
      runLogger.warn(
        'Run-ahead stopped: an event that could change the workflow landed below a speculative write',
        {
          reason,
          source,
          eventType: event.eventType,
          eventId: event.eventId,
          correlationId: event.correlationId,
          speculativeSlots: [...speculativeSlots],
        }
      );
      // What the delivery decided from here on stops; the
      // outcomes of steps it already ran, and whose start
      // committed, still get written, so the redelivery
      // that decides from the log runs none of them again.
      // Not thrown: this runs inside write checks, and the
      // loop acts on `runAheadFailure`.
      const stop = new RunAheadStopError(reason);
      writer.stopDecisions(stop, mayStillWriteAfterHazard);
      runAheadFailure ??= stop;
      notifyProgress();
    }
    /**
     * Steps whose `step_started` committed in a speculative
     * creation batch (the others are in the log).
     */
    const committedStarts = new Set<string>();
    /**
     * What a delivery stopped by a hazard may still write:
     * the outcome of a step whose start committed. Anything
     * else is a decision made from the speculative view.
     */
    function mayStillWriteAfterHazard(
      events: readonly CreateEventRequest[]
    ): boolean {
      return events.every((event) => {
        if (
          event.eventType !== 'step_completed' &&
          event.eventType !== 'step_failed' &&
          event.eventType !== 'step_retrying'
        ) {
          return false;
        }
        const id = event.correlationId;
        if (id === undefined) return false;
        if (committedStarts.has(id)) return true;
        const committedStart = (e: Event | undefined) =>
          e?.eventType === 'step_started' &&
          e.correlationId === id &&
          !speculativeEvents.has(e);
        return (
          (log?.events.some(committedStart) ?? false) ||
          pendingAbsorbs.some((r) => committedStart(r.event)) ||
          repairWrites.some((r) => committedStart(r.event))
        );
      });
    }
    /**
     * Whether `event` is this delivery's own write, or one the
     * log already holds: neither can change the workflow.
     */
    function isOwnOrKnownEvent(event: Event): boolean {
      const slot = eventIdToSlot(event.eventId);
      if (slot !== null && speculativeSlots.has(slot)) {
        // Another writer can hold a position the workflow
        // consumed a speculative event at.
        const own = speculationsBySlot.get(slot)?.event;
        return (
          own !== undefined &&
          own.eventType === event.eventType &&
          own.correlationId === event.correlationId
        );
      }
      if (slot !== null && ownSlots.has(slot)) return true;
      return log?.events.some((e) => e.eventId === event.eventId) ?? false;
    }
    /** Waits for every speculative write in flight to settle. */
    async function settleRunAhead(): Promise<void> {
      while (speculationsBySlot.size > 0) {
        await Promise.allSettled(
          [...speculationsBySlot.values()].map((s) => s.settled)
        );
      }
    }
    /**
     * Drains run-ahead before a decision that must not be
     * taken from a speculative view: every speculative write
     * settles, and a failure stops the delivery. Returns
     * whether the log must be reloaded first.
     */
    async function drainRunAhead(): Promise<'clean' | 'repair'> {
      await settleRunAhead();
      if (runAheadFailure !== undefined) throw runAheadFailure;
      writer.assertActive();
      runAheadContexts.clear();
      return runAheadRepair ? 'repair' : 'clean';
    }
    /** Replaces a repaired run-ahead's log with the World's. */
    /**
     * Puts a repaired run-ahead's log right. Its speculative
     * events leave the log, and the responses of its writes
     * take their place: each write's committed event, and the
     * skipped-slot report of whatever another writer placed
     * below it. A write names only confirmed positions (see
     * `slotSnapshot`), so the reports cover every slot the
     * speculative events were predicted at, and the log is
     * rebuilt without reading it again. Only a report that
     * came back incomplete, or a hole left after the merge,
     * sends it to a read. The writer's count is unaffected: it
     * tracked what each write allocated.
     *
     * The retained session survives when all the other writer
     * placed below its speculative events is inert to it (see
     * `admitBelowSpeculation`): its next resume takes the
     * corrected log as a rebase rather than a cold replay.
     */
    async function repairRunAhead(): Promise<void> {
      const startedAt = Date.now();
      await writer.idle();
      await settleRunAhead();
      runAheadRepair = false;
      speculativeSlots.clear();
      assert(log, 'The event log is loaded to repair run-ahead');
      if (speculativeEvents.size > 0) {
        for (let i = log.events.length - 1; i >= 0; i--) {
          if (speculativeEvents.has(log.events[i]!)) {
            log.events.splice(i, 1);
          }
        }
      }
      speculativeEvents.clear();
      const writes = [...repairWrites.splice(0), ...pendingAbsorbs.splice(0)];
      let complete = true;
      for (const write of writes) {
        if (write.hasMore) {
          complete = false;
          continue;
        }
        const merged = [
          ...(write.events ?? []),
          ...(write.event ? [write.event] : []),
        ];
        for (const event of merged) prepareReplayEvent(event);
        if (write.event) {
          const slot = eventIdToSlot(write.event.eventId);
          if (slot !== null) ownSlots.add(slot);
        }
        mergeReportedEvents(log.events, merged);
      }
      const readLog = !complete || findEventSlotGap(log.events) !== undefined;
      if (readLog) {
        runAheadStats.repairReads++;
        await loadAfter();
      }
      if (session) {
        const sensitive = new Set(runAheadSensitiveHookIds);
        pendingRebase = {
          aliases: new Map(repairAliases),
          admitBelow: (event) => admitBelowSpeculation(event, sensitive),
        };
      }
      runtimeLogger.debug('Run-ahead repaired', {
        workflowRunId: runId,
        writes: writes.length,
        readLog,
        rebased: pendingRebase !== undefined,
      });
      repairAliases.clear();
      runAheadSensitiveHookIds.clear();
      runAheadStats.repairMs += Date.now() - startedAt;
      recordRunAheadSpan();
    }
    /**
     * Writes an inline step's outcome ahead: returns at once
     * with the event the workflow consumes, at the slot the
     * write takes unless another writer appends first, and
     * with the time the World records for it (`occurredAt`).
     * The commit is checked before any later write is sent.
     */
    function writeOutcomeAhead(
      data: CreateEventRequest,
      params: CreateEventParams | undefined,
      context: RunAheadContext
    ): EventResult {
      const occurredAt = new Date();
      const slot = writer.predictNextSlot();
      const event = {
        ...data,
        runId,
        eventId: slotToEventId(slot),
        createdAt: occurredAt,
      } as Event;
      speculativeSlots.add(slot);
      speculativeEvents.add(event);
      noteRunAheadContext(context);
      const commit = writer.createAhead(
        data,
        {
          ...params,
          ...slotSnapshot(),
          resolveData: REPLAY_RESOLVE_DATA,
          occurredAt,
        },
        (result) => {
          const committed = result.event;
          for (const below of result.events ?? []) {
            checkRunAheadHazard(below, 'skipped-slot report');
          }
          if (!committed || +new Date(committed.createdAt) !== +occurredAt) {
            // The World keeps its own time for in-band
            // writes, so the workflow read a different
            // `Date.now()` than replay will. Never again in
            // this process for this World.
            disableRunAheadFor(world);
            throw new RunAheadStopError(
              'the World does not record an in-band write at its occurredAt'
            );
          }
          if (eventIdToSlot(committed.eventId) !== slot) {
            repairAliases.set(event.eventId, committed.eventId);
            markRunAheadRepair('outcome');
          }
        }
      );
      const settled = commit.then(
        (result) => {
          speculativeSlots.delete(slot);
          speculationsBySlot.delete(slot);
          if (!runAheadRepair) {
            speculativeEvents.delete(event);
            pendingAbsorbs.push(result);
          } else {
            repairWrites.push(result);
          }
          notifyProgress();
        },
        (error: unknown) => {
          speculationsBySlot.delete(slot);
          if (runAheadFailure === undefined) {
            runAheadStats.failureStops++;
            recordRunAheadSpan();
          }
          runAheadFailure ??= error;
          notifyProgress();
        }
      );
      speculationsBySlot.set(slot, { event, settled });
      return { event };
    }
    /**
     * Writes a boundary's step creations (each new inline
     * step's `step_created` and first `step_started`, one
     * batch) ahead: their events join the log at the slots
     * they take unless another writer appends first, and the
     * bodies start at once. The commit is checked as an
     * outcome's is (see {@link writeOutcomeAhead}).
     */
    function writeCreationAhead(
      events: readonly CreateEventRequest[],
      context: RunAheadContext
    ): Map<string, StartedInBatch> {
      assert(log, 'The event log is loaded to run ahead');
      const occurredAt = new Date();
      const first = writer.predictNextSlot();
      const speculative = events.map(
        (data, index) =>
          ({
            ...data,
            runId,
            eventId: slotToEventId(first + index),
            createdAt: occurredAt,
          }) as Event
      );
      noteRunAheadContext(context);
      const postSentAtMs = Date.now();
      const verifyCreation = (result: EventBatchResult) => {
        for (const below of result.events ?? []) {
          checkRunAheadHazard(below, 'skipped-slot report');
        }
        result.results.forEach((item, index) => {
          if (
            item.error === undefined &&
            item.event.eventType === 'step_started' &&
            item.event.correlationId
          ) {
            committedStarts.add(item.event.correlationId);
          }
          if (item.error !== undefined) {
            throw new RunAheadStopError(
              `a speculative ${events[index]?.eventType} was refused (${item.status}: ${item.message})`
            );
          }
          if (+new Date(item.event.createdAt) !== +occurredAt) {
            disableRunAheadFor(world);
            throw new RunAheadStopError(
              'the World does not record an in-band write at its occurredAt'
            );
          }
          if (eventIdToSlot(item.event.eventId) !== first + index) {
            const predicted = speculative[index];
            if (predicted) {
              repairAliases.set(predicted.eventId, item.event.eventId);
            }
            markRunAheadRepair('creation');
          }
        });
      };
      const commit = writer.createBatchAhead(
        events.map((event) => ({
          event,
          occurredAt,
          ...(event.eventType === 'step_started'
            ? { computeInstanceId: COMPUTE_INSTANCE_ID }
            : {}),
        })),
        {
          ...slotSnapshot(),
          ...(requestId ? { requestId } : {}),
        },
        verifyCreation
      );
      const settled = commit.then(
        (result) => {
          speculative.forEach((_, index) => {
            speculativeSlots.delete(first + index);
            speculationsBySlot.delete(first + index);
          });
          {
            const items: typeof repairWrites = [];
            let firstItem = true;
            for (const item of result.results) {
              if (item.error !== undefined) continue;
              items.push({
                event: item.event,
                ...(firstItem
                  ? {
                      events: result.events,
                      hasMore: result.hasMore,
                    }
                  : {}),
              });
              firstItem = false;
            }
            if (!runAheadRepair) {
              for (const event of speculative) {
                speculativeEvents.delete(event);
              }
              pendingAbsorbs.push(...items);
            } else {
              repairWrites.push(...items);
            }
          }
          notifyProgress();
        },
        (error: unknown) => {
          speculative.forEach((_, index) => {
            speculationsBySlot.delete(first + index);
          });
          if (runAheadFailure === undefined) {
            runAheadStats.failureStops++;
            recordRunAheadSpan();
          }
          runAheadFailure ??= error;
          notifyProgress();
        }
      );
      const starts = new Map<string, StartedInBatch>();
      speculative.forEach((event, index) => {
        speculativeSlots.add(first + index);
        speculativeEvents.add(event);
        speculationsBySlot.set(first + index, {
          event,
          settled,
        });
        prepareReplayEvent(event);
        if (event.eventType === 'step_started' && event.correlationId) {
          starts.set(event.correlationId, {
            event,
            postSentAtMs,
            completedAtMs: postSentAtMs,
          });
        }
      });
      mergeReportedEvents(log.events, speculative);
      return starts;
    }
    const inlineDeadlineMs = invocationStartTime + noInlineReplayAfterMs;
    const inlineMarginMs = getInlineStepDeadlineMarginMs();

    /**
     * Keeps a delivery that has nothing left to run live
     * while the run waits on work done elsewhere (see
     * `getOrchestratorLingerMs`). Resolves `true` once
     * another writer appended an event or a wait fell due,
     * so the caller runs another pass, and `false` when the
     * time ran out without either.
     */
    const lingerForExternalWork = async (): Promise<boolean> => {
      const lingerMs = getOrchestratorLingerMs();
      if (
        lingerMs <= 0 ||
        !world.events.subscribe ||
        !log ||
        !awaitsExternalWork(log.events)
      ) {
        return false;
      }
      const untilMs = Math.min(
        Date.now() + lingerMs,
        inlineDeadlineMs - inlineMarginMs
      );
      if (untilMs <= Date.now()) return false;
      ensureLiveFeed();
      const startedAtMs = Date.now();
      // Waiting is not replay work.
      replayBudget.pause();
      try {
        while (true) {
          const remainingMs = untilMs - Date.now();
          if (remainingMs <= 0) break;
          let handle: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            waitForProgress(),
            new Promise<void>((resolve) => {
              handle = setTimeout(resolve, remainingMs);
            }),
          ]);
          clearTimeout(handle);
          progressWaiter = undefined;
          if (
            pendingFeedEvents.some((event) => !isOwnEvent(event)) ||
            dueWaits(log.events, Date.now(), wakeUpWaits).length > 0
          ) {
            runtimeLogger.debug('Lingering delivery resumed', {
              workflowRunId: runId,
              lingeredMs: Date.now() - startedAtMs,
            });
            return true;
          }
        }
      } finally {
        replayBudget.resume();
      }
      runtimeLogger.debug('Lingering delivery found no new work', {
        workflowRunId: runId,
        lingeredMs: Date.now() - startedAtMs,
      });
      return false;
    };

    // Main loop: replay, decide, write, run inline steps.
    try {
      while (true) {
        loopIteration++;
        assert(log, 'The event log is loaded in the loop');

        if (replayBudget.isExhausted()) {
          await handleReplayBudgetExhausted({
            runId,
            workflowName,
            requestId,
            attempt: metadata.attempt,
            limitMs: replayBudget.configuredLimitMs,
            slotSnapshot: slotSnapshot(),
            runSpecVersion: run.specVersion,
            writeEvent: (data, params) => writeInBand(data, params),
          });
          return undefined;
        }

        // Hand off before the function's deadline: the next
        // delivery continues from the log.
        if (Date.now() >= inlineDeadlineMs) {
          runtimeLogger.info(
            'Invocation deadline reached, handing the run to the next delivery',
            {
              workflowRunId: runId,
              loopIteration,
              elapsedMs: Date.now() - invocationStartTime,
            }
          );
          continuation.exit = 'deadline';
          await wakeSelf();
          return undefined;
        }

        let replayStart = 0;
        try {
          if (runAheadRepair) {
            await settleRunAhead();
            if (runAheadFailure !== undefined) {
              throw runAheadFailure;
            }
            await repairRunAhead();
          }
          flushPending();
          if (logBehind) await loadAfter();
          assert(log, 'The event log is loaded in the loop');
          if (hasRecordedTerminalRunEvent(log.events, runId)) {
            forgetConsumedPosition(world, runId);
            return undefined;
          }

          // Complete elapsed waits. `wait_completed` resolves a
          // promise, so it is consumed only after it commits,
          // behind whatever its report says landed below it.
          const due = dueWaits(log.events, Date.now(), wakeUpWaits);
          for (const wait of due) {
            wakeUpWaits.delete(wait.correlationId);
            const completed = await createEvent(
              {
                eventType: 'wait_completed' as const,
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: wait.correlationId,
                eventData: { resumeAt: wait.resumeAt },
              },
              { requestId }
            );
            if (
              consumeOwnResolvingWrite(log.events, preparedResult(completed))
                .type === 'reload'
            ) {
              session = null;
              await fullLoad();
            }
          }
          assert(log, 'The event log is loaded in the loop');
          // The next timer of each chain whose wait this pass completed
          // goes out now, not at suspend: this delivery may end in a
          // handoff first, and the next delivery does not know which
          // waits this one completed.
          if (due.length > 0) await armTimers(log.events, 'other-chains');

          if (isSlotGapCheckEnabled()) {
            // Run-ahead places an outcome at the slot its write
            // will take, so the log can hold it above a
            // position this delivery's writer is still about
            // to fill (a sibling step's start queued ahead of
            // it). That is no hole: let the speculative writes
            // and everything queued before them commit, and
            // fold them in, before judging the log.
            if (
              speculationsBySlot.size > 0 &&
              findEventSlotGap(log.events) !== undefined
            ) {
              if ((await drainRunAhead()) === 'repair') {
                await repairRunAhead();
              }
              await writer.idle();
              flushPending();
            }
            const settled = await settleEventSlotGap(runId, {
              events: log.events,
              cursor: log.cursor,
            });
            if (settled.log.events !== log.events) {
              session = null;
            }
            log = {
              events: settled.log.events,
              cursor: settled.log.cursor,
            };
            if (settled.gap !== undefined) {
              throw new CorruptedEventLogError(
                `Event log for run ${runId} has a hole at slot ${settled.gap.firstMissingSlot}: ${settled.gap.missingCount} of the ${settled.gap.maxSlot} slots up to the log's maximum hold no event.`
              );
            }
          }
          if (hasRecordedTerminalRunEvent(log.events, runId)) {
            forgetConsumedPosition(world, runId);
            return undefined;
          }

          if (maxEventsLimit !== undefined) {
            const workflowEventCount = log.events.reduce(
              (n, e) => (isSealedNoopEvent(e) ? n : n + 1),
              0
            );
            if (workflowEventCount >= maxEventsLimit) {
              throw new MaxEventsExceededError(
                workflowEventCount,
                maxEventsLimit
              );
            }
            maybeWarnApproachingEventLimit({
              runId,
              workflowName,
              eventCount: workflowEventCount,
              limit: maxEventsLimit,
              isQuickJS: false,
            });
          }

          runtimeLogger.debug('Starting workflow execution', {
            workflowRunId: runId,
            loopIteration,
            eventCount: log.events.length,
            executionMode: session ? 'retained' : 'replay',
          });
          replayStart = Date.now();
          if (resumeTracking) {
            resumeTracking.replayStartedAtMs ??= replayStart;
          }
          const replayPayloadCache = startReplayPayloadCache(workflowRun);
          assert(
            replayPayloadCache,
            'Node workflow replay requires payload preparation'
          );
          const payloadPrewarm = replayPayloadCache.prewarm(
            workflowRun,
            log.events
          );
          passConsumedSlot = maxEventSlot(log.events) ?? 0;
          const rebase = pendingRebase;
          pendingRebase = undefined;
          let workflowResult: WorkflowResumeResult = session
            ? await resumeWorkflow(session, log.events, rebase)
            : { type: 'replay' };
          if (rebase && workflowResult.type !== 'replay') {
            runAheadStats.repairsRetained++;
            recordRunAheadSpan();
          }
          const servedByRetained =
            session !== null && workflowResult.type !== 'replay';
          if (workflowResult.type === 'replay') {
            session = null;
            const compiled = startWorkflowCompile(workflowRun);
            assert(
              compiled || dynamicWorkflowScripts,
              'Node workflow replay requires compiled scripts'
            );
            workflowResult = await replayWorkflow({
              workflowCode: effectiveWorkflowCode,
              workflowRun,
              events: log.events,
              encryptionKey: await encryptionKey.value,
              replayPayloadCache,
              ...((compiled ?? dynamicWorkflowScripts)
                ? {
                    compiledWorkflowScripts: await (compiled ??
                      dynamicWorkflowScripts),
                  }
                : {}),
              worldCapabilities: world.capabilities,
              drainPendingQueue: pendingQueueDrain(world, (data, params) =>
                writeInBand(data, params)
              ),
            });
          }
          await payloadPrewarm;

          if (workflowResult.type === 'completed') {
            replayRecoveryReporter.activate();
            let completed: EventResult;
            try {
              completed = await createEvent(
                {
                  eventType: 'run_completed',
                  specVersion: SPEC_VERSION_CURRENT,
                  eventData: { output: workflowResult.output },
                },
                { requestId }
              );
            } catch (err) {
              if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
                runtimeLogger.info(
                  'Tried completing workflow run, but run has already finished.',
                  { workflowRunId: runId, message: err.message }
                );
                return undefined;
              }
              throw err;
            }
            forgetConsumedPosition(world, runId);
            // An out-of-band terminal event (a `run_cancelled`,
            // or a `run_failed` from a step's invocation) can
            // land below this one; the first terminal event by
            // position decides the run. Only announce a
            // completion the World recorded as the outcome.
            const recordedStatus = completed.run?.status;
            if (
              recordedStatus !== undefined &&
              recordedStatus !== 'completed'
            ) {
              runtimeLogger.info(
                'Run reached another terminal state first; not dispatching completion hooks',
                { workflowRunId: runId, status: recordedStatus }
              );
              return undefined;
            }
            dispatchRunCompletedHooks(runId, workflowName);
            span?.setAttributes({
              ...Attribute.WorkflowRunStatus('completed'),
            });
            return undefined;
          }

          replayRecoveryReporter.activate();
          const suspension = workflowResult.suspension;
          session = workflowResult.session;
          if (resumeTracking && suspension.stepCount > 0) {
            resumeTracking.nextStepEncounteredAtMs ??= Date.now();
          }
          const suspensionMessage = buildWorkflowSuspensionMessage(
            suspension.stepCount,
            suspension.hookCount,
            suspension.waitCount
          );
          if (suspensionMessage) {
            runtimeLogger.debug(suspensionMessage);
          }

          const outcome = await handleOrchestratorSuspension(
            suspension,
            workflowRun,
            log,
            Date.now() - replayStart,
            servedByRetained
          );
          if (outcome.type === 'return') {
            return outcome.result;
          }
          if (outcome.type === 'reload-full') {
            // Speculative writes settle first. A repair they
            // made due rebuilds the log itself and may keep
            // the retained session (see `repairRunAhead`); a
            // full load replaces the log and the session.
            await settleRunAhead();
            if (runAheadFailure !== undefined) {
              throw runAheadFailure;
            }
            if (runAheadRepair) {
              await repairRunAhead();
            } else {
              session = null;
              await fullLoad();
            }
          } else if (outcome.type === 'reload') {
            if (!outcome.retainSession) session = null;
            await loadAfter();
          } else if (!outcome.retainSession) {
            session = null;
          }
        } catch (err) {
          if (
            OrchestratorSupersededError.is(err) ||
            writer.isSuperseded ||
            // A failed turbo `run_started` stopped every
            // write; the delivery ends on its error.
            turboStartFailure ||
            // So did a speculative write that failed or
            // failed its check.
            RunAheadStopError.is(err) ||
            RunAheadStopError.is(writer.stopCause) ||
            runAheadFailure !== undefined
          ) {
            throw err;
          }
          if (isRetryableWorldError(err) || isQueueSendFailure(err)) {
            runLogger.warn(
              'Transient world error during replay; redelivering via queue instead of failing the run',
              {
                errorName: err instanceof Error ? err.name : 'UnknownError',
                errorMessage: err instanceof Error ? err.message : String(err),
                deliveryAttempt: metadata.attempt,
              }
            );
            throw err;
          }
          if (ReplayDivergenceError.is(err)) {
            const recovery = recordDivergence(err);
            if (recovery.type === 'fail') {
              return await failRun(
                recovery.error,
                effectiveWorkflowCode,
                recovery.divergenceCount,
                recovery.logFields
              );
            }
            // Recover in place: the next pass is a cold replay, in a fresh
            // VM, of a freshly loaded log. Speculative writes settle first,
            // as before any full load.
            await settleRunAhead();
            if (runAheadFailure !== undefined) throw runAheadFailure;
            if (runAheadRepair) await repairRunAhead();
            session = null;
            pendingRebase = undefined;
            await fullLoad();
            continue;
          }
          if (replayStart > 0) {
            replayRecoveryReporter.activate();
          }
          return await failRun(err, effectiveWorkflowCode);
        }
      }
    } finally {
      await drainInline();
    }

    /**
     * Writes one suspension's decisions and runs what it
     * runs inline. Returns how the loop continues.
     */
    async function handleOrchestratorSuspension(
      suspension: WorkflowSuspension,
      run: WorkflowRun,
      loaded: LoadedEventLog,
      replayDurationMs: number,
      retained: boolean
    ): Promise<
      | {
          type: 'return';
          result: { timeoutSeconds: number } | undefined;
        }
      | { type: 'reload'; retainSession: boolean }
      | { type: 'reload-full' }
      | { type: 'continue'; retainSession: boolean }
    > {
      const compression =
        (run.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION;
      const hasAttributes = suspension.attributeCount > 0;
      // The log as the replay saw it, before this
      // suspension's own writes are folded in.
      const replayedEvents = loaded.events.slice();

      // Hooks, aborts, disposals and attribute writes.
      const otherItems = suspension.items.filter(
        (item) => item.type !== 'step' && item.type !== 'wait'
      );
      const hookAwaitingConflict = suspension.items.some(
        (item) =>
          item.type === 'hook' &&
          !item.hasCreatedEvent &&
          item.hasConflictAwaiter === true
      );
      if (runAheadFailure !== undefined) throw runAheadFailure;
      writer.assertActive();

      // --- Run-ahead gate ---
      // Whether an event another writer could append now can
      // change what this boundary leads to. Inert: the inline
      // steps it schedules may hand their outcomes to the
      // workflow before those commit. Not inert: nothing is
      // decided from a speculative view, so the speculative
      // writes in flight settle and their reports are taken
      // in, in log order, before this boundary writes.
      const gateRunnable = analyzeLogSteps(replayedEvents).filter(
        (step) => step.runnableInline && !ranInline.has(step.correlationId)
      );
      const gateMayInline =
        !hookAwaitingConflict &&
        mayStartInlineStep({
          nowMs: Date.now(),
          deadlineMs: inlineDeadlineMs,
          marginMs: inlineMarginMs,
        });
      const gateSlots = gateMayInline
        ? Math.max(0, getMaxInlineSteps() - gateRunnable.length - inFlight.size)
        : 0;
      const gateNewSteps = suspension.items.flatMap((item) =>
        item.type === 'step' && !item.hasCreatedEvent
          ? [item.correlationId]
          : []
      );
      const selfStepIds = new Set<string>([
        ...ranInline,
        ...inFlight.keys(),
        ...gateRunnable.map((step) => step.correlationId),
        ...gateNewSteps.slice(0, gateSlots),
      ]);
      const schedulesInline =
        gateMayInline &&
        (gateRunnable.length > 0 || (gateSlots > 0 && gateNewSteps.length > 0));
      const waitWindowEndMs = inlineDeadlineMs + getOpenWaitClockSkewMs();
      const observation = observeOutOfBandWriters({
        items: suspension.items,
        observedHookIds: suspension.observedHookIds,
        selfExecutedStepIds: selfStepIds,
        waitDue:
          openWaits(replayedEvents).some(
            (wait) => wait.resumeAtMs <= waitWindowEndMs
          ) ||
          suspension.items.some(
            (item) =>
              item.type === 'wait' &&
              +new Date(item.resumeAt) <= waitWindowEndMs
          ),
      });
      let boundaryRunAhead: RunAheadContext | undefined;
      if (schedulesInline) {
        if (observation.inert) {
          outOfBandBoundaries.inert++;
        } else {
          if (observation.observedHookCount > 0) {
            outOfBandBoundaries.observedHook++;
          }
          if (observation.unknownHookCount > 0) {
            outOfBandBoundaries.unknownHook++;
          }
          if (observation.abortSignalHookCount > 0) {
            outOfBandBoundaries.abortSignal++;
          }
          if (observation.externalStepCount > 0) {
            outOfBandBoundaries.externalStep++;
          }
          if (observation.waitDue) outOfBandBoundaries.waitDue++;
        }
        if (runAheadDepth > 0 && observation.inert) {
          runAheadStats.runAhead++;
          boundaryRunAhead = runAheadContextFor({
            observation,
            hookItems: suspension.items.flatMap((item) =>
              item.type === 'hook' ? [item] : []
            ),
            observedHookIds: suspension.observedHookIds,
            selfStepIds,
          });
        } else if (runAheadDepth > 0) {
          runAheadStats.drained++;
        }
        recordRunAheadSpan();
      }
      if (
        !observation.inert &&
        (speculationsBySlot.size > 0 || runAheadRepair)
      ) {
        if ((await drainRunAhead()) === 'repair') {
          await repairRunAhead();
          return { type: 'continue', retainSession: false };
        }
        flushPending();
        // Something landed below the speculative writes:
        // the workflow takes it in before this boundary.
        if (log && hasUnconsumedForeignEvent(log.events)) {
          return { type: 'continue', retainSession: true };
        }
      }
      let hookResult: Awaited<ReturnType<typeof handleSuspension>> | undefined;
      if (otherItems.length > 0) {
        try {
          hookResult = await handleSuspension({
            suspension: Object.assign(
              Object.create(Object.getPrototypeOf(suspension)),
              suspension,
              { items: otherItems, steps: otherItems }
            ) as WorkflowSuspension,
            world,
            run,
            span,
            requestId,
            eventLog: loaded,
            replayRecoveryReporter,
            forceClaimVictimWakes,
            writeEvent: (data, params) => writeInBand(data, params),
          });
        } catch (suspensionError) {
          if (
            OrchestratorSupersededError.is(suspensionError) ||
            !FatalError.is(suspensionError)
          ) {
            throw suspensionError;
          }
          // Non-retryable, e.g. an attribute write the World
          // rejected as invalid. Redelivery would hit it
          // again, so fail the run.
          return {
            type: 'return',
            result: await failRun(suspensionError, effectiveWorkflowCode),
          };
        }
      }

      // A hook write settles awaiters in the workflow itself
      // (a conflict, an awaited registration). The workflow
      // observes that before anything else this suspension
      // would start, so continue while each pass makes
      // progress. The hook write is already folded into the
      // log (a fold that left a hole reads first, see
      // `logBehind`), so the next pass reads nothing more.
      if (hookResult?.hasHookConflict) {
        const fresh = hookResult.hookConflictCorrelationIds.filter(
          (id) => !continuedHookIds.has(id)
        );
        if (fresh.length > 0) {
          for (const id of fresh) continuedHookIds.add(id);
          return { type: 'continue', retainSession: true };
        }
        continuation.exit = 'hook-conflict';
        await wakeSelf();
        return { type: 'return', result: undefined };
      }
      if (hasAttributes) {
        // The committed `attr_set` decides races against the
        // steps of the same pass, so nothing else is written
        // until the next pass resolves it.
        return { type: 'reload', retainSession: true };
      }
      if (hookResult?.hasAwaitedHookCreation) {
        const fresh = hookResult.awaitedHookCorrelationIds.filter(
          (id) => !continuedHookIds.has(id)
        );
        if (fresh.length > 0) {
          for (const id of fresh) continuedHookIds.add(id);
          return { type: 'continue', retainSession: true };
        }
      }

      // Steps and waits: decide each new step's execution
      // mode, commit `step_created`/`wait_created`, then
      // enqueue the background steps.
      const logSteps = analyzeLogSteps(replayedEvents);
      const runnableInline = logSteps.filter(
        (step) => step.runnableInline && !ranInline.has(step.correlationId)
      );
      const mayInline =
        !hookAwaitingConflict &&
        mayStartInlineStep({
          nowMs: Date.now(),
          deadlineMs: inlineDeadlineMs,
          marginMs: inlineMarginMs,
        });
      const inlineSlots = mayInline
        ? Math.max(
            0,
            getMaxInlineSteps() - runnableInline.length - inFlight.size
          )
        : 0;
      // Turbo stops starting bodies ahead of their start
      // for the rest of the delivery once the run has a hook
      // or a wait: a hook resume, a timer or `wakeUp()`
      // gives the run writers other than this delivery.
      // Attribute writes do not: they resolve in this
      // process.
      if (
        turboOptimistic &&
        suspension.items.some(
          (item) => item.type !== 'step' && item.type !== 'attribute'
        )
      ) {
        turboOptimistic = false;
      }
      // While set, accepted creation writes join the log
      // between passes rather than at once: the commit
      // below is then still in flight when the pass ends.
      let deferAbsorbs = false;
      const plan = await planStepsAndWaits({
        suspension,
        run,
        writer,
        onCommitted: (result) => {
          if (deferAbsorbs) pendingAbsorbs.push(result);
          else absorbWrite(result);
        },
        eventCount: () => slotSnapshot().eventCount,
        encryptionKey: await encryptionKey.value,
        compression,
        creatorMessageId,
        inlineSlots,
        requestId,
      });
      // Turbo: a suspension of only new inline steps starts
      // their bodies while their `step_created` commits.
      // Each body's `step_started` follows that commit, and
      // its outcome follows the start. Anything with a
      // background step, a wait or a step that failed to
      // serialize commits first, as without turbo.
      // A step that allows no retries starts only on a
      // durable `step_started` (see `mayRunBeforeItsStart`),
      // so a boundary that creates one commits first.
      const startsAhead = plan.steps.every((step) =>
        mayRunBeforeItsStart(step.stepName)
      );
      const optimisticCreation =
        turboOptimistic &&
        mayInline &&
        startsAhead &&
        plan.steps.length > 0 &&
        plan.failedCount === 0 &&
        plan.waitCount === 0 &&
        plan.steps.every((step) => step.inline);
      let created: Awaited<ReturnType<typeof plan.commit>>;
      let newInline: Array<
        Omit<CreatedStep, 'event'> & {
          started?: StartedInBatch;
        }
      >;
      let creationGate: Promise<Map<string, CreatedStep>> | undefined;
      // Run-ahead: the same shape of suspension writes its
      // creations ahead instead, when the World takes them
      // as one batch and the depth allows.
      const speculativeCreation =
        boundaryRunAhead !== undefined &&
        mayInline &&
        startsAhead &&
        writer.supportsBatch &&
        plan.steps.length > 0 &&
        plan.failedCount === 0 &&
        plan.waitCount === 0 &&
        plan.steps.every((step) => step.inline) &&
        // One speculative batch; a larger fan-out commits
        // in chunks on the awaited path.
        plan.events.length <= MAX_BATCH_EVENTS &&
        withinRunAheadDepth();
      if (speculativeCreation && boundaryRunAhead) {
        const starts = writeCreationAhead(plan.events, boundaryRunAhead);
        created = {
          createdSteps: [],
          failedStepCorrelationIds: new Set(),
          createdWaits: [],
          serializationBlockerCount: plan.serializationBlockerCount,
          serializationBlockers: plan.serializationBlockers,
        };
        newInline = plan.steps.map((step) => {
          const started = starts.get(step.correlationId);
          return started ? { ...step, started } : step;
        });
      } else if (optimisticCreation) {
        deferAbsorbs = true;
        const committing = plan.commit();
        creationGate = committing.then((result) => {
          if (result.createdSteps.length < plan.steps.length) {
            // A batch item was refused after its body
            // started. Redeliver; the next delivery loads the
            // log and decides from it.
            throw new WorkflowWorldError(
              'A step_created of an inline step started ahead of its commit was not committed',
              { status: 503 }
            );
          }
          return new Map(
            result.createdSteps.map((step) => [step.correlationId, step])
          );
        });
        creationGate.catch(() => {});
        const inFlightCreation = creationGate.then(
          () => {},
          () => {}
        );
        creationsInFlight.add(inFlightCreation);
        void inFlightCreation.then(() =>
          creationsInFlight.delete(inFlightCreation)
        );
        created = {
          createdSteps: [],
          failedStepCorrelationIds: new Set(),
          createdWaits: [],
          serializationBlockerCount: plan.serializationBlockerCount,
          serializationBlockers: plan.serializationBlockers,
        };
        newInline = plan.steps;
      } else if (
        writer.supportsBatch &&
        plan.events.length > MAX_BATCH_EVENTS &&
        plan.failedCount === 0 &&
        plan.waitCount === 0
      ) {
        // A fan-out larger than one batch: the inline steps
        // ride the first batch and start once it commits;
        // the later batches commit behind it, and each
        // enqueues the background steps it created. No pass
        // decides before they commit (see
        // `creationsInFlight`).
        const chunks = plan.commitInChunks();
        creationBatchesQueuing.add(chunks.queued);
        void chunks.queued.then(() =>
          creationBatchesQueuing.delete(chunks.queued)
        );
        created = await chunks.first;
        deferAbsorbs = true;
        newInline = created.createdSteps.filter((step) => step.inline);
        const trailing = chunks.rest.then((rest) =>
          enqueueStepMessages(
            run,
            rest.createdSteps.flatMap((step) =>
              step.inline
                ? []
                : [
                    {
                      correlationId: step.correlationId,
                      stepName: step.stepName,
                      stepCreatedEventId: step.event?.eventId,
                      input: step.input,
                    },
                  ]
            )
          )
        );
        trackInFlightCreation(trailing);
      } else {
        created = await plan.commit();
        newInline = created.createdSteps.filter((step) => step.inline);
      }
      if (created.failedStepCorrelationIds.size > 0) {
        return { type: 'reload', retainSession: false };
      }
      const serializationBlockerCount =
        created.serializationBlockerCount +
        (hookResult?.serializationBlockerCount ?? 0);
      const retention = getRetentionDecision({
        suspension,
        serializationBlockerCount,
        invocationContinuation: true,
      });
      const retain = retention.retain;
      if (!retention.retain) {
        runtimeLogger.debug('Retained VM not kept', {
          workflowRunId: runId,
          workflowVmRetentionReason: retention.reason,
          ...(serializationBlockerCount > 0
            ? serializationBlockerLogMetadata(
                [
                  ...created.serializationBlockers,
                  ...(hookResult?.serializationBlockers ?? []),
                ].slice(0, GUEST_CODE_EXECUTION_SAMPLE_LIMIT),
                serializationBlockerCount
              )
            : {}),
        });
      }

      // Background steps: enqueue the ones created now, and
      // re-enqueue the ones a crashed earlier delivery of
      // this same message created but never got out.
      const reenqueue = new Set(
        stepsToReenqueue({
          events: replayedEvents,
          messageId: creatorMessageId,
          deliveryCount: creatorDeliveryCount,
        })
      );
      const toEnqueue: StepMessageSpec[] = [];
      for (const step of created.createdSteps) {
        if (step.inline) continue;
        toEnqueue.push({
          correlationId: step.correlationId,
          stepName: step.stepName,
          stepCreatedEventId: step.event?.eventId,
          input: step.input,
        });
      }
      for (const step of logSteps) {
        if (!reenqueue.has(step.correlationId)) continue;
        toEnqueue.push({
          correlationId: step.correlationId,
          stepName: step.stepName,
          stepCreatedEventId: step.createdEventId,
          ...(step.inline ? { stepAttempt: step.starts + 1 } : {}),
        });
      }
      // Hook-resume TTR: when no inline step will report it,
      // the first dispatched step carries the boundaries to
      // the invocation that runs it.
      const willRunInline =
        mayInline && (newInline.length > 0 || runnableInline.length > 0);
      let dispatchedTiming: HookResumeTiming | undefined;
      if (!willRunInline && toEnqueue.length > 0) {
        dispatchedTiming = resumeTimingForMessage(resumeTracking);
        if (dispatchedTiming) resumeTracking = undefined;
      }

      // Inline steps: the ones created inline now, plus inline
      // steps an earlier invocation started and never
      // finished (its retry runs them again).
      const inlineToRun: InlineStepSpec[] = [];
      if (mayInline) {
        for (const step of newInline) {
          const started = startedFromBatch(step.started);
          const gate = creationGate;
          inlineToRun.push({
            correlationId: step.correlationId,
            stepName: step.stepName,
            input: step.input,
            attempt: 1,
            ...(started ? { started } : {}),
            ...(step.startRefusal ? { startRefusal: step.startRefusal } : {}),
            ...(gate
              ? {
                  // The creation-bearing start once the
                  // batch committed it, or its refusal.
                  startAfter: observed(
                    gate.then((steps) => {
                      const committed = steps.get(step.correlationId);
                      if (committed?.startRefusal) {
                        throw committed.startRefusal;
                      }
                      return startedFromBatch(committed?.started);
                    })
                  ),
                }
              : {}),
          });
        }
        for (const step of runnableInline) {
          if (step.starts > 0) {
            // TEMPORARY diagnostic; remove before merge.
            runtimeLogger.warn('[diag] re-running an open inline step', {
              workflowRunId: runId,
              correlationId: step.correlationId,
              starts: step.starts,
              messageId: metadata.messageId,
              deliveryCount: metadata.deliveryCount,
              attempt: metadata.attempt,
              requestId,
              loopIteration,
            });
          }
          const createdEvent = replayedEvents.find(
            (event) => event.eventId === step.createdEventId
          );
          // The creation is a `step_created`, or the first
          // `step_started` of a step it created inline.
          const loadedInput =
            createdEvent?.eventType === 'step_created' ||
            createdEvent?.eventType === 'step_started'
              ? createdEvent.eventData?.input
              : undefined;
          inlineToRun.push({
            correlationId: step.correlationId,
            stepName: step.stepName,
            createdEventId: step.createdEventId,
            // A World may leave step inputs out of replay
            // loads; read it back only then.
            ...(loadedInput !== undefined ? { input: loadedInput } : {}),
            attempt: step.starts + 1,
            ...(step.firstStartedAt
              ? { firstStartedAt: step.firstStartedAt }
              : {}),
          });
        }
      }

      // The background steps' messages go out while the inline
      // bodies run: nothing an inline body does depends on them.
      // Like a fan-out's later creation batches, the dispatch is
      // in `creationsInFlight`, so no later pass decides, no
      // timer is armed on suspend and the delivery does not end
      // before it settled, and a failed dispatch fails the
      // delivery there, whose redelivery re-sends the steps that
      // have not started (`stepsToReenqueue`). Without inline
      // work the dispatch is awaited here.
      const dispatching = enqueueStepMessages(
        run,
        toEnqueue,
        undefined,
        dispatchedTiming
      );
      if (inlineToRun.length > 0 && toEnqueue.length > 0) {
        trackInFlightCreation(dispatching);
      } else {
        await dispatching;
      }

      if (inlineToRun.length > 0) {
        const latencyTracking = computeStepLatencyTracking({
          events: replayedEvents,
          invocationStartedClean: invocationStartedClean === true,
          // Turbo's synthesized run has a local-clock
          // `createdAt`; only the run id's time is trusted.
          runCreatedAtMs:
            runIdCreatedAt(runId) ?? (turbo ? undefined : +run.createdAt),
          runStartedReceivedAtMs,
          replayMs: replayDurationMs,
          preStepBlockingMs,
          preStepBlockingBeforeAttrMs: undefined,
          suspensionHasWaits: suspension.waitCount > 0,
          suspensionCreatedHooks: suspension.hookCount > 0,
          turbo,
          retained,
        });
        preStepBlockingMs += hookResult?.hookCreationMs ?? 0;
        const ran = await runInlineSteps(
          run,
          inlineToRun,
          latencyTracking,
          boundaryRunAhead
        );
        return ran.type === 'continue'
          ? { type: 'continue', retainSession: retain }
          : ran;
      }
      if (inFlight.size > 0 || settledInline.length > 0) {
        const progressed = await awaitInlineProgress(run);
        return progressed.type === 'continue'
          ? { type: 'continue', retainSession: retain }
          : progressed;
      }

      // Suspend: nothing to run here. Arm the timers this
      // delivery owns and acknowledge, once every creation
      // committed.
      while (creationsInFlight.size > 0) {
        await Promise.allSettled([...creationsInFlight]);
      }
      if (trailingCreationFailure !== undefined) {
        throw trailingCreationFailure;
      }
      flushPending();
      const wroteSomething =
        created.createdSteps.length > 0 ||
        created.createdWaits.length > 0 ||
        (hookResult !== undefined && otherItems.length > 0);
      // A delivery that ran ahead parks only on a confirmed
      // log, so whatever landed below its speculative writes
      // is acted on now.
      if (speculationsBySlot.size > 0 || runAheadRepair) {
        if ((await drainRunAhead()) === 'repair') {
          await repairRunAhead();
          return { type: 'continue', retainSession: false };
        }
        flushPending();
      }
      if (wroteSomething) await loadAfter();
      assert(log, 'The event log is loaded on suspend');
      // An event that landed after the VM decided (a hook
      // payload, a background step's outcome) has a wake of
      // its own, but that wake would find this position
      // already recorded as consumed. Replay it now instead.
      if (
        log.events.some((event) => {
          const slot = eventIdToSlot(event.eventId);
          return (
            slot !== null &&
            slot > passConsumedSlot &&
            !ownSlots.has(slot) &&
            event.eventType !== 'noop'
          );
        })
      ) {
        return { type: 'continue', retainSession: false };
      }
      // Stay warm for what the run waits on instead of
      // leaving it to a queued wake.
      if (await lingerForExternalWork()) {
        return { type: 'continue', retainSession: retain };
      }
      await armTimers(log.events);
      recordConsumedPosition(world, runId, {
        slot: maxEventSlot(log.events) ?? 0,
        ...nextTimerAt(log.events),
      });
      return { type: 'return', result: undefined };
    }

    /**
     * Starts inline steps as background work of this
     * delivery, then waits for the next progress.
     */
    async function runInlineSteps(
      run: WorkflowRun,
      steps: InlineStepSpec[],
      latencyTracking?: ReturnType<typeof computeStepLatencyTracking>,
      /** Set when these steps' outcomes may run ahead. */
      runAhead?: RunAheadContext
    ): Promise<InlineProgress> {
      assert(log, 'The event log is loaded for inline steps');
      // Decided once per batch: the latch can end while
      // these bodies run. A run-ahead boundary starts its
      // bodies ahead of their start too.
      const optimistic = turboOptimistic || runAhead !== undefined;
      ensureLiveFeed();
      const tracking = resumeTracking;
      resumeTracking = undefined;
      const stepEncryptionKey = await encryptionKey.value;
      let first = true;
      for (const step of steps) {
        if (ranInline.has(step.correlationId)) continue;
        ranInline.add(step.correlationId);
        const isFirst = first;
        first = false;
        const body = (async () => {
          const input =
            step.input ?? (await readStepInput(step.createdEventId));
          return runStepSingleFlight(
            runId,
            step.correlationId,
            () =>
              executeStep({
                world,
                createEvent: async (data, params) => {
                  if (
                    data.eventType === 'step_completed' ||
                    data.eventType === 'step_failed' ||
                    data.eventType === 'step_retrying'
                  ) {
                    while (creationBatchesQueuing.size > 0) {
                      await Promise.all([...creationBatchesQueuing]);
                    }
                  }
                  if (
                    runAhead &&
                    (data.eventType === 'step_completed' ||
                      data.eventType === 'step_failed')
                  ) {
                    if (!withinRunAheadDepth([step.correlationId])) {
                      // At the cap, wait for an earlier
                      // speculative write to settle, which
                      // frees a place, and run this outcome
                      // ahead too: an awaited write of its
                      // own would leave the next creation
                      // nothing to share a round trip with.
                      runAheadStats.depthCap++;
                      recordRunAheadSpan();
                      while (
                        !withinRunAheadDepth([step.correlationId]) &&
                        !runAheadRepair &&
                        runAheadFailure === undefined &&
                        !writer.isStopped &&
                        speculationsBySlot.size > 0
                      ) {
                        await Promise.race(
                          [...speculationsBySlot.values()].map((s) => s.settled)
                        );
                      }
                    }
                    if (withinRunAheadDepth([step.correlationId])) {
                      return writeOutcomeAhead(data, params, runAhead);
                    }
                  }
                  const result = await writer.create(data, {
                    ...params,
                    ...slotSnapshot(),
                    resolveData: REPLAY_RESOLVE_DATA,
                  });
                  pendingAbsorbs.push(result);
                  return result;
                },
                workflowRunId: runId,
                workflowDeploymentId: run.deploymentId,
                workflowName,
                workflowStartedAt,
                rootRunId: rootRunIdFrom(run.attributes, runId),
                requestId,
                stepId: step.correlationId,
                stepName: step.stepName,
                encryptionKey: stepEncryptionKey,
                runSpecVersion: run.specVersion,
                attempt: step.attempt,
                ...(step.firstStartedAt
                  ? { firstStartedAt: step.firstStartedAt }
                  : {}),
                input,
                ...(step.started ? { started: step.started } : {}),
                ...(step.startRefusal
                  ? { startRefusal: step.startRefusal }
                  : {}),
                // Turbo: optimistic for a step's first
                // attempt while turbo still allows it.
                forceOptimisticStart: optimistic && step.attempt === 1,
                ...(runReadyBarrier ? { runReadyBarrier } : {}),
                ...(step.startAfter ? { startAfter: step.startAfter } : {}),
                beforeBody: () => writer.assertActive(),
                // Every step of the batch shares it: the
                // first to reach user code reports, so a
                // refused first step does not lose it.
                ...(tracking ? { resumeTracking: tracking } : {}),
                ...(isFirst && latencyTracking ? { latencyTracking } : {}),
              }),
            'debug'
          );
        })();
        const tracked = body.then(
          (value) => {
            settledInline.push({
              spec: step,
              outcome: { status: 'fulfilled', value },
            });
          },
          (reason: unknown) => {
            settledInline.push({
              spec: step,
              outcome: { status: 'rejected', reason },
            });
          }
        );
        inFlight.set(
          step.correlationId,
          tracked.finally(() => {
            inFlight.delete(step.correlationId);
            notifyProgress();
          })
        );
      }
      return awaitInlineProgress(run);
    }

    /**
     * Waits for an inline body to settle, a live-feed event
     * or the next due timer, then takes in what settled.
     */
    async function awaitInlineProgress(
      run: WorkflowRun
    ): Promise<InlineProgress> {
      // The timer also goes out as a queue message, as on
      // suspend: this delivery completes a due wait itself
      // while it is alive, and the message covers the wait if
      // the delivery ends first.
      if (log) await armTimers(log.events);
      replayBudget.pause();
      try {
        // Wake for a settled body, an event from someone
        // else, or a due timer. Anything else (the feed's echo
        // of this delivery's own writes) would only cost the
        // workflow a pass with nothing new to act on.
        while (true) {
          await waitForProgress();
          if (settledInline.length > 0) break;
          if (runAheadFailure !== undefined) break;
          if (pendingFeedEvents.some((e) => !isOwnEvent(e))) {
            break;
          }
          if (log && dueWaits(log.events, Date.now()).length > 0) {
            break;
          }
          if (inFlight.size === 0) break;
        }
        // Turbo: no pass decides while a creation it would
        // re-derive is still in flight. Its events join the
        // log only once it committed, and a pass before that
        // would create those steps again.
        while (creationsInFlight.size > 0) {
          await Promise.allSettled([...creationsInFlight]);
        }
        if (trailingCreationFailure !== undefined) {
          throw trailingCreationFailure;
        }
      } finally {
        replayBudget.resume();
      }
      flushPending();
      if (runAheadFailure !== undefined) throw runAheadFailure;
      const settled = settledInline.splice(0);
      // Supersession wins over any other failure; the outer
      // drain lets the remaining bodies settle.
      const failures = settled.flatMap((item) =>
        item.outcome.status === 'rejected' ? [item.outcome.reason] : []
      );
      if (failures.length > 0) {
        throw (
          failures.find((reason) => OrchestratorSupersededError.is(reason)) ??
          failures[0]
        );
      }

      let reload = false;
      for (const item of settled) {
        const step = item.spec;
        const result = (
          item.outcome as PromiseFulfilledResult<
            Awaited<ReturnType<typeof executeStep>>
          >
        ).value;
        if (result.type === 'gone') {
          forgetConsumedPosition(world, runId);
          return { type: 'return', result: undefined };
        }
        if (result.type === 'throttled') {
          throttledSeconds = Math.max(
            throttledSeconds ?? 0,
            result.timeoutSeconds
          );
          continue;
        }
        if (result.type === 'retry') {
          // The retry moves to the background: this is the
          // step's first message, carrying the next attempt.
          retriedInBackground.add(step.correlationId);
          await enqueueStepMessages(
            run,
            [
              {
                correlationId: step.correlationId,
                stepName: step.stepName,
                stepAttempt: step.attempt + 1,
                ...(step.createdEventId
                  ? { stepCreatedEventId: step.createdEventId }
                  : {}),
                ...(step.input ? { input: step.input } : {}),
              },
            ],
            result.timeoutSeconds
          );
          continue;
        }
        if (result.type === 'completed' && result.hasPendingOps) {
          pendingStreamOps = true;
        }
        assert(log, 'The event log is loaded after inline steps');
        if (runAheadRepair) {
          // Not folded: the log is reloaded once the
          // speculative writes settle.
          reload = true;
        } else if (
          consumeOwnResolvingWrite(log.events, preparedResult(result.result))
            .type === 'reload'
        ) {
          reload = true;
        }
      }
      if (throttledSeconds !== undefined) {
        // Every sibling still running settles and is acted on
        // first (a retry's message goes out now), then the
        // run is deferred by the longest backoff.
        if (inFlight.size > 0) return awaitInlineProgress(run);
        return {
          type: 'return',
          result: { timeoutSeconds: throttledSeconds },
        };
      }
      if (pendingStreamOps && inFlight.size === 0) {
        // Stream writes are still flushing through
        // `waitUntil`; hand the run to the next delivery so
        // this one can end.
        continuation.exit = 'pending-stream-ops';
        await wakeSelf();
        return { type: 'return', result: undefined };
      }
      return reload
        ? { type: 'reload-full' }
        : { type: 'continue', retainSession: true };
    }

    /**
     * Reads a step's input from its creation: its
     * `step_created`, or the first `step_started` of a step
     * created inline.
     */
    async function readStepInput(
      createdEventId: string | undefined
    ): Promise<SerializedData> {
      if (createdEventId === undefined) {
        throw new WorkflowRuntimeError(
          'An inline step has neither an input nor a creation event'
        );
      }
      const created = await world.events.get(runId, createdEventId, {
        resolveData: 'all',
      });
      const input =
        created.eventType === 'step_created' ||
        (created.eventType === 'step_started' &&
          stepCreationOf(created) !== undefined)
          ? created.eventData?.input
          : undefined;
      if (input === undefined) {
        throw new WorkflowRuntimeError(
          `Event "${createdEventId}" is not a step's creation`
        );
      }
      return input;
    }

    /**
     * Enqueues background step messages: one message per
     * step, with a key stable for the step and a retention
     * that covers its retries. The messages go out in
     * parallel queue batches of at most
     * {@link STEP_DISPATCH_QUEUE_BATCH_SIZE}; the enqueue
     * fails, with the first failed batch's error, once every
     * batch settled, as one batch of all of them would.
     */
    async function enqueueStepMessages(
      run: WorkflowRun,
      steps: StepMessageSpec[],
      delaySeconds?: number,
      hookResumeTiming?: HookResumeTiming
    ): Promise<void> {
      if (steps.length === 0) return;
      const traceCarrier = await nextTraceCarrier();
      const binaryTransport =
        (run.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT;
      const messages = steps.map((step, index) => {
        const maxRetries =
          getStepFunction(step.stepName)?.maxRetries ??
          DEFAULT_STEP_MAX_RETRIES;
        const carryInput =
          binaryTransport &&
          step.input instanceof Uint8Array &&
          step.input.byteLength <= MAX_STEP_MESSAGE_INPUT_BYTES;
        return {
          message: {
            runId,
            stepId: step.correlationId,
            stepName: step.stepName,
            traceCarrier,
            requestedAt: new Date(),
            runContext: runDispatchContext(run),
            ...(step.stepCreatedEventId
              ? {
                  stepCreatedEventId: step.stepCreatedEventId,
                }
              : {}),
            ...(carryInput
              ? {
                  stepInput: {
                    input: step.input as Uint8Array,
                  },
                }
              : {}),
            ...(step.stepAttempt && step.stepAttempt > 1
              ? { stepAttempt: step.stepAttempt }
              : {}),
            ...(index === 0 && hookResumeTiming ? { hookResumeTiming } : {}),
          },
          opts: {
            idempotencyKey: stepDispatchIdempotencyKey(
              step.correlationId,
              step.stepName
            ),
            retentionSeconds: stepMessageRetentionSeconds(maxRetries),
            ...(delaySeconds !== undefined && delaySeconds > 0
              ? { delaySeconds }
              : {}),
          },
        };
      });
      const queueName = getWorkflowQueueName(workflowName, namespace);
      const batches: (typeof messages)[] = [];
      for (
        let offset = 0;
        offset < messages.length;
        offset += STEP_DISPATCH_QUEUE_BATCH_SIZE
      ) {
        batches.push(
          messages.slice(offset, offset + STEP_DISPATCH_QUEUE_BATCH_SIZE)
        );
      }
      const sent = await Promise.allSettled(
        batches.map((batch) => queueMessages(world, queueName, batch))
      );
      const failed = sent.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected'
      );
      if (failed) throw failed.reason;
      for (const step of steps) noteStepMessageSent(step.correlationId);
    }

    /** The open waits of `events` whose timer this delivery may arm. */
    function ownedOpenWaits(events: readonly Event[]) {
      const timerFor = waitContinuation?.correlationId;
      const ownedChains = ownedWaitChains({
        events,
        messageId: creatorMessageId,
        completedWaits,
        timerFor,
        redelivery: creatorDeliveryCount !== 1,
      });
      return openWaits(events).filter((wait) =>
        schedulesWaitTimer({
          wait: wait.event,
          correlationId: wait.correlationId,
          timerFor,
          ownedChains,
        })
      );
    }

    /**
     * Arms the timer of the earliest open wait of each chain this delivery
     * owns, and of the wait a timer delivery is for (`waitTimersToArm`),
     * once per wait: a delivery that waits on inline bodies arms timers
     * early, and its suspend would otherwise send them again. With
     * `'other-chains'`, only the chains of other messages: those this
     * delivery owns because it completed one of their waits.
     */
    async function armTimers(
      events: Event[],
      scope: 'all' | 'other-chains' = 'all'
    ): Promise<void> {
      const owned = ownedOpenWaits(events).filter(
        (wait) =>
          scope === 'all' ||
          (wait.event !== undefined &&
            waitCreatorMessageId(wait.event) !== creatorMessageId)
      );
      for (const wait of waitTimersToArm(
        owned,
        creatorMessageId,
        waitContinuation?.correlationId
      )) {
        if (!timedWaits.has(wait.correlationId)) await sendWaitTimer(wait);
      }
    }

    /** Sends the timer message of one wait (see `waitTimerMessage`). */
    async function sendWaitTimer(wait: {
      correlationId: string;
      resumeAtMs: number;
    }): Promise<void> {
      timedWaits.add(wait.correlationId);
      const now = Date.now();
      const timer = waitTimerMessage({
        correlationId: wait.correlationId,
        resumeAtMs: wait.resumeAtMs,
        seconds: Math.max(0, Math.ceil((wait.resumeAtMs - now) / 1000)),
        nowMs: now,
      });
      try {
        await wakeSelf(
          { waitContinuation: timer.waitContinuation },
          timer.delaySeconds
        );
      } catch (error) {
        timedWaits.delete(wait.correlationId);
        throw error;
      }
    }

    /**
     * Sends what this delivery's writes owe the queue and it has not sent:
     * the step messages in `unsentStepMessages`, plus, on a redelivery of
     * its message, the ones the creator rules re-send for an earlier
     * delivery of it that never got them out (see `stepsToReenqueue`); and
     * the timers of the wait chains it owns that have none from it yet
     * (`armTimers`). A step message keeps its idempotency key, so one
     * already sent is deduped.
     */
    async function sendOwedMessages(run: WorkflowRun): Promise<void> {
      const owed = new Map(unsentStepMessages);
      if (log && creatorDeliveryCount !== 1) {
        const reenqueue = new Set(
          stepsToReenqueue({
            events: log.events,
            messageId: creatorMessageId,
            deliveryCount: creatorDeliveryCount,
          })
        );
        for (const step of analyzeLogSteps(log.events)) {
          const id = step.correlationId;
          if (!reenqueue.has(id) || owed.has(id) || sentStepMessages.has(id)) {
            continue;
          }
          owed.set(id, {
            correlationId: id,
            stepName: step.stepName,
            stepCreatedEventId: step.createdEventId,
            ...(step.inline ? { stepAttempt: step.starts + 1 } : {}),
          });
        }
      }
      const now = Date.now();
      const immediate: StepMessageSpec[] = [];
      for (const { retryAfter, ...step } of owed.values()) {
        const spec: StepMessageSpec = {
          ...step,
          stepCreatedEventId:
            step.stepCreatedEventId ??
            ownCreationEventIds.get(step.correlationId) ??
            log?.events.find(
              (event) =>
                event.correlationId === step.correlationId &&
                stepCreationOf(event) !== undefined
            )?.eventId,
        };
        const delaySeconds =
          retryAfter === undefined
            ? 0
            : Math.max(0, Math.ceil((+retryAfter - now) / 1000));
        if (delaySeconds > 0) {
          await enqueueStepMessages(run, [spec], delaySeconds);
        } else {
          immediate.push(spec);
        }
      }
      await enqueueStepMessages(run, immediate);
      const events = [
        ...(log?.events ?? []),
        ...[...ownOpenWaits.values()].filter(
          (wait) => !log?.events.some((event) => event.eventId === wait.eventId)
        ),
      ];
      await armTimers(events);
    }

    /**
     * Records a replay divergence. While the recovery budget lasts the
     * delivery replays again from a fresh load (`recover`), and the first
     * natural write of a replay that gets past it reports the count.
     */
    function recordDivergence(err: ReplayDivergenceError):
      | { type: 'recover' }
      | {
          type: 'fail';
          error: Error;
          divergenceCount: number;
          logFields: Record<string, unknown>;
        } {
      const priorDivergenceEventId = divergences.at(-1);
      const isRecoveryReplay = divergences.length > 0;
      divergences.push(err.eventId);
      const divergenceCount = divergences.length;
      const maxRecoveryReplays = getReplayDivergenceMaxRetries();
      const divergenceEventIds = divergences.slice(-(maxRecoveryReplays + 1));
      const logFields = {
        errorCode: RUN_ERROR_CODES.REPLAY_DIVERGENCE,
        divergenceEventId: err.eventId,
        priorDivergenceEventId,
        divergenceEventIds,
        divergenceCount,
        maxRecoveryReplays,
        loopIteration,
        deliveryAttempt: metadata.attempt,
        eventLogLength: log?.events.length,
        eventLogLastEventId: log?.events.at(-1)?.eventId,
        isRecoveryReplay,
        hasHookInput: hookInput !== undefined,
        hasWaitContinuation: waitContinuation !== undefined,
      };
      if (divergenceCount <= maxRecoveryReplays) {
        runLogger.warn(
          'Workflow replay diverged; replaying again from a fresh load before declaring the event log corrupted',
          { ...logFields, errorMessage: err.message }
        );
        replayRecoveryReporter = new ReplayRecoveryReporter(divergenceCount);
        return { type: 'recover' };
      }
      return {
        type: 'fail',
        divergenceCount,
        logFields,
        error: new CorruptedEventLogError(
          `Workflow replay diverged ${divergenceCount} times after ${maxRecoveryReplays} recovery replays; latest divergent event was ${err.eventId}; divergent event ids: ${divergenceEventIds.join(', ')}. Last divergence: ${err.message}`,
          { cause: err }
        ),
      };
    }
  }

  /** Records `run_failed` for an error the run cannot survive. */
  async function failRun(
    terminalError: unknown,
    effectiveWorkflowCode: string,
    replayDivergenceCount?: number,
    extraLogFields: Record<string, unknown> = {}
  ): Promise<undefined> {
    if (terminalError instanceof Error) {
      span?.recordException?.(terminalError);
    }
    const normalizedError = await normalizeUnknownError(terminalError);
    const errorName = normalizedError.name || getErrorName(terminalError);
    const errorMessage = normalizedError.message;
    let errorStack = normalizedError.stack || getErrorStack(terminalError);
    if (errorStack) {
      const parsedName = parseWorkflowName(workflowName);
      const filename = parsedName?.moduleSpecifier || workflowName;
      errorStack = remapErrorStack(errorStack, filename, effectiveWorkflowCode);
    }
    const errorCode = classifyRunError(terminalError);
    runtimeLogger.error('Error while running workflow', {
      ...extraLogFields,
      workflowRunId: runId,
      errorCode,
      errorName,
      errorMessage,
      errorStack,
      errorCause: formatErrorCauseChain(terminalError) || undefined,
    });
    if (types.isNativeError(terminalError) && errorStack) {
      setErrorStack(terminalError, errorStack);
    }
    let failureKey: PayloadKey | undefined;
    let dehydratedError: Uint8Array;
    let failedResult: EventResult | undefined;
    try {
      failureKey = await encryptionKey.value;
      dehydratedError = await dehydrateRunError(
        terminalError,
        runId,
        failureKey,
        globalThis,
        (workflowRun?.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION
      );
      failedResult = await createEvent(
        {
          eventType: 'run_failed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { error: dehydratedError, errorCode },
        },
        {
          requestId,
          ...(replayDivergenceCount !== undefined
            ? { replayDivergenceCount }
            : {}),
        }
      );
    } catch (failErr) {
      if (EntityConflictError.is(failErr) || RunExpiredError.is(failErr)) {
        runtimeLogger.info(
          'Tried failing workflow run, but run has already finished.',
          {
            workflowRunId: runId,
            message:
              failErr instanceof Error ? failErr.message : String(failErr),
          }
        );
        return undefined;
      }
      if (isWorldContractError(failErr)) {
        runtimeLogger.error(
          'Fatal world contract error while recording workflow failure',
          {
            workflowRunId: runId,
            errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
            error: failErr instanceof Error ? failErr.message : String(failErr),
          }
        );
        return undefined;
      }
      throw failErr;
    }
    forgetConsumedPosition(world, runId);
    // As for completion: an out-of-band terminal event at a
    // lower position decided the run instead.
    const recordedStatus = failedResult?.run?.status;
    if (recordedStatus !== undefined && recordedStatus !== 'failed') {
      return undefined;
    }
    dispatchRunFailedHooks(
      runId,
      workflowName,
      dehydratedError,
      failureKey,
      errorCode
    );
    span?.setAttributes({
      ...Attribute.WorkflowRunStatus('failed'),
      ...Attribute.WorkflowErrorCode(errorCode),
      ...Attribute.WorkflowErrorName(errorName),
      ...Attribute.WorkflowErrorMessage(errorMessage),
      ...Attribute.ErrorType(errorName),
    });
    return undefined;
  }
}

/** The spec 9 orchestrator, for the shared entrypoint. */
export const spec9Orchestrator: Orchestrator = {
  // A step message is exempt: it is retried in place for its whole life
  // (each userland retry is a redelivery), so its delivery count is bounded
  // by the step's retries and the message's retention.
  countsTowardMaxDeliveries: (message) => message.stepId === undefined,
  async writeMaxDeliveriesFailure(world, runId, eventData, requestId) {
    // The orchestrator's own terminal write, so in-band: load the log for the
    // fence count first. A step message never reaches here (it is exempt
    // from the cap).
    const loaded = await loadWorkflowRunEvents(runId);
    const writer = new InBandWriter(world, runId);
    writer.adoptSnapshot(requireLoadSnapshot(runId, loaded));
    try {
      await writer.create(
        {
          eventType: 'run_failed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData,
        },
        { requestId, ...slotSnapshotParams(loaded.events) }
      );
    } catch (err) {
      if (OrchestratorSupersededError.is(err)) return 'superseded';
      throw err;
    }
    return 'written';
  },
  runDelivery: runSpec9Delivery,
};
