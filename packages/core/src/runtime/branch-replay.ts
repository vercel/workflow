/**
 * Helpers behind advance-only replays: the replays that let one branch of a
 * fan-out move on while sibling steps are still in flight elsewhere
 * (`isAdvanceOnlyReplayEnabled`).
 */
import {
  type Event,
  ROOT_RUN_ID_ATTRIBUTE,
  type RunDispatchContext,
  type WorkflowRun,
} from '@workflow/world';
import type { StepInvocationQueueItem, WorkflowSuspension } from '../global.js';
import { runIdCreatedAt } from './run-id-time.js';
import type { StepExecutionResult } from './step-executor.js';

/**
 * Whether a suspension holds work its replay would write, as opposed to only
 * waiting on things that already exist in the event log.
 *
 * An advance-only replay acts on exactly this: a step, hook or wait without
 * its creation event, a hook disposal or abort not yet recorded, or an
 * attribute write. Anything else in the suspension already has an event, so
 * the invocation that wrote it is the one driving it, and a replay that
 * reaches only those has nothing to do.
 */
export function suspensionHasNewWork(
  suspension: Pick<WorkflowSuspension, 'items'>
): boolean {
  return suspension.items.some((item) => {
    switch (item.type) {
      case 'step':
      case 'wait':
        return item.hasCreatedEvent !== true;
      case 'hook':
        // Replay drops a hook's queue item once its disposal or abort is in
        // the log, so either flag still set means the write is outstanding.
        return (
          item.hasCreatedEvent !== true ||
          item.disposed === true ||
          item.abortRequested === true
        );
      case 'attribute':
        return true;
      default:
        // An item kind this check does not know about: assume it writes, so
        // the replay goes on to handle it rather than dropping it.
        return true;
    }
  });
}

/**
 * Steps that have executable work in progress: a `step_created` not identified
 * by the current replay as drain-only, or any `step_started`, without a
 * terminal step event. A start is authoritative even when the replay also
 * reports the id as an un-awaited terminal-drain item.
 */
export function pendingStepIdsIn(
  events: readonly Event[],
  terminalDrainStepIds: ReadonlySet<string> = new Set()
): Set<string | undefined> {
  const created = new Set<string | undefined>();
  const settled = new Set<string | undefined>();
  for (const e of events) {
    if (
      (e.eventType === 'step_created' &&
        (e.correlationId === undefined ||
          !terminalDrainStepIds.has(e.correlationId))) ||
      e.eventType === 'step_started'
    ) {
      created.add(e.correlationId);
    } else if (
      e.eventType === 'step_completed' ||
      e.eventType === 'step_failed'
    ) {
      settled.add(e.correlationId);
    }
  }
  const pending = new Set<string | undefined>();
  for (const id of created) {
    if (!settled.has(id)) pending.add(id);
  }
  return pending;
}

export interface PendingStepReplayAnalysis {
  pendingStepIds: Set<string | undefined>;
  currentEpisodePeakPendingStepCount: number;
  pendingSiblingCountAtLatestStart: number | undefined;
  pendingCreationsFollowFirstStart: boolean;
}

/**
 * Derive the queued replay's pending and width inputs in one event-log pass.
 * A fan-out episode begins when the pending set leaves zero and ends when it
 * returns to zero, so a completed wide fan-out cannot disable a later batch.
 */
export function analyzePendingStepsForReplay(
  events: readonly Event[],
  stepId: string
): PendingStepReplayAnalysis {
  const pending = new Set<string | undefined>();
  const settled = new Set<string | undefined>();
  const createdAfterFirstStart = new Set<string>();
  const started = new Set<string | undefined>();
  const activelyStarted = new Set<string | undefined>();
  let currentEpisodePeakPendingStepCount = 0;
  let pendingSiblingCount: number | undefined;
  let attemptSiblingIds = new Set<string | undefined>();
  let awaitingStart = false;
  let sawFirstStart = false;

  for (const event of events) {
    if (event.eventType === 'step_created') {
      pending.add(event.correlationId);
      if (sawFirstStart && event.correlationId !== undefined) {
        createdAfterFirstStart.add(event.correlationId);
      }
      if (event.correlationId === stepId) {
        awaitingStart = true;
        attemptSiblingIds = new Set(
          [...pending].filter(
            (id) => id !== event.correlationId && !activelyStarted.has(id)
          )
        );
      } else if (awaitingStart) {
        attemptSiblingIds.add(event.correlationId);
      }
      currentEpisodePeakPendingStepCount = Math.max(
        currentEpisodePeakPendingStepCount,
        pending.size
      );
    } else if (event.eventType === 'step_started') {
      pending.add(event.correlationId);
      started.add(event.correlationId);
      activelyStarted.add(event.correlationId);
      if (event.correlationId === stepId) {
        pendingSiblingCount = attemptSiblingIds.size;
        awaitingStart = false;
        sawFirstStart = true;
      } else if (awaitingStart) {
        attemptSiblingIds.add(event.correlationId);
      }
      currentEpisodePeakPendingStepCount = Math.max(
        currentEpisodePeakPendingStepCount,
        pending.size
      );
    } else if (
      event.eventType === 'step_retrying' &&
      event.correlationId === stepId
    ) {
      awaitingStart = true;
      pendingSiblingCount = undefined;
      activelyStarted.delete(event.correlationId);
      attemptSiblingIds = new Set(
        [...attemptSiblingIds].filter((id) => pending.has(id))
      );
    } else if (
      event.eventType === 'step_completed' ||
      event.eventType === 'step_failed'
    ) {
      pending.delete(event.correlationId);
      activelyStarted.delete(event.correlationId);
      settled.add(event.correlationId);
      if (pending.size === 0) currentEpisodePeakPendingStepCount = 0;
    }
  }

  // Match pendingStepIdsIn's set-difference behavior for malformed or legacy
  // logs whose terminal row precedes a duplicate create/start.
  for (const id of settled) pending.delete(id);
  if (pending.size === 0) currentEpisodePeakPendingStepCount = 0;

  const pendingCreationsFollowFirstStart =
    pending.size > 0 &&
    !pending.has(undefined) &&
    [...pending].every(
      (id): id is string =>
        id !== undefined && createdAfterFirstStart.has(id) && !started.has(id)
    );

  return {
    pendingStepIds: pending,
    currentEpisodePeakPendingStepCount,
    pendingSiblingCountAtLatestStart: pendingSiblingCount,
    pendingCreationsFollowFirstStart,
  };
}

/** Who is replaying: decides which pending steps an advance-only pass owes. */
export interface AdvanceOnlyDelivery {
  /** The queue message id of the delivery replaying. */
  messageId: string;
  /** Whether this delivery must recover created-but-never-started steps. */
  recoverNeverStarted: boolean;
}

/** Queue dedupe key for one settled inline step's advance-only continuation. */
export function advanceOnlyReplayIdempotencyKey(
  runId: string,
  stepId: string
): string {
  return `advance-only:${runId}:${stepId}`;
}

/**
 * Whether an advance-only replay leaves this pending step to whoever is
 * driving it, rather than dispatching it the ordinary way.
 *
 * It leaves a sibling, the reason the mode exists. It does not leave two kinds
 * of step that nothing but this delivery would ever drive:
 *
 * - A step this message claimed inline. A redelivery of the owning message is
 *   how a body that died mid-run gets recovered, and it is the only delivery
 *   that may recover it while the claim stands.
 * - On a redelivery, a step that was created but never started. The delivery
 *   being retried may have created it and crashed before sending its message,
 *   and then no other delivery knows to send it. Sending it again is safe: the
 *   step's dispatch key dedupes the copy when the first did go out. A first
 *   delivery skips this, which is what keeps a fan-out's queued siblings from
 *   being re-sent on every branch's settlement.
 */
export function advanceOnlyLeavesStep(
  step: StepInvocationQueueItem,
  delivery: AdvanceOnlyDelivery
): boolean {
  if (step.ownerMessageId === delivery.messageId) return false;
  if (delivery.recoverNeverStarted && step.lastStartedAt === undefined) {
    return false;
  }
  return true;
}

/**
 * Whether an advance-only replay has anything to do for this suspension: work
 * of its own to write (see {@link suspensionHasNewWork}), or a pending step it
 * must not leave to anyone else (see {@link advanceOnlyLeavesStep}). When it
 * has none, the replay returns without handling the suspension.
 */
export function advanceOnlyHasWork(
  suspension: Pick<WorkflowSuspension, 'items'>,
  delivery: AdvanceOnlyDelivery
): boolean {
  return (
    suspensionHasNewWork(suspension) ||
    suspension.items.some(
      (item) => item.type === 'step' && !advanceOnlyLeavesStep(item, delivery)
    )
  );
}

/**
 * Whether an inline step's result settles its branch, so that a replay now
 * could take that branch further.
 *
 * A step that completed or failed for good has its terminal event, which the
 * replay resolves the step's promise from. Every other outcome leaves the
 * branch where it was: a retry runs again later, a lost claim (`skipped`)
 * means another invocation owns the step, `gone` means the run is over, and
 * a throttled claim never created the step. A completed step whose stream
 * writes are still flushing is held back too: the inline loop already hands
 * such a batch to a fresh invocation once it settles, after the writes have
 * had their chance to flush.
 */
export function settlesBranch(result: StepExecutionResult): boolean {
  if (result.type === 'completed') return result.hasPendingOps !== true;
  return result.type === 'failed';
}

/**
 * The run row an advance-only replay of a queued step's run replays against,
 * built from the run identity its message carries and the run's own
 * `run_created` and `run_started` events instead of read back with `runs.get`.
 * Turbo builds the row it replays its first delivery against from the start
 * payload the same way.
 *
 * Every field the replay reads comes from one of the two, and the ones the
 * workflow VM is seeded from match the stored row exactly: the seed is the run
 * id, workflow name and deployment, the VM clock starts at the time the run id
 * encodes, and `workflowStartedAt` comes from the persisted `run_started`
 * timestamp. That is why a run id that encodes no time or a log without either
 * required event gets `undefined` here: the caller then reads the row as
 * before.
 *
 * The status is always `running`. The caller does not rely on it: a replay
 * returns before running the workflow when its log holds a terminal run event,
 * and any write it makes is fenced if the run has ended since.
 */
export function runRowFromCreation(
  runId: string,
  runCreated: Event,
  runStarted: Event | undefined,
  runContext: RunDispatchContext
): WorkflowRun | undefined {
  if (
    runCreated.eventType !== 'run_created' ||
    runStarted?.eventType !== 'run_started'
  ) {
    return undefined;
  }
  const createdAtMs = runIdCreatedAt(runId);
  const startedAtMs = +runStarted.createdAt;
  if (createdAtMs === undefined || !Number.isFinite(startedAtMs)) {
    return undefined;
  }
  const { eventData } = runCreated;
  return {
    runId,
    status: 'running',
    deploymentId: runContext.deploymentId,
    workflowName: eventData.workflowName,
    specVersion: runContext.specVersion,
    executionContext: eventData.executionContext,
    input: eventData.input,
    // Seed attributes ride `run_created`, the lineage root among them. The
    // carried root is the stored row's, so it agrees; it is set explicitly so
    // a World that keeps reserved keys off the event still yields it.
    attributes: {
      ...eventData.attributes,
      ...(runContext.rootRunId !== undefined && runContext.rootRunId !== runId
        ? { [ROOT_RUN_ID_ATTRIBUTE]: runContext.rootRunId }
        : {}),
    },
    ...(eventData.encryptionPublicKey !== undefined
      ? { encryptionPublicKey: eventData.encryptionPublicKey }
      : {}),
    startedAt: new Date(startedAtMs),
    createdAt: new Date(createdAtMs),
    updatedAt: new Date(startedAtMs),
  };
}
