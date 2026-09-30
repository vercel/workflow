/**
 * Piggyback commit: commit a held step completion together with what a replay
 * over it derived, as one fenced, atomic `world.events.commit` request.
 *
 * Design, model and server semantics: `docs/fenced-commit.md` and
 * `specs/PiggybackCommit.tla` in workflow-server. In the inline loop a
 * sequential step costs two awaited round trips before the next body starts
 * (`step_completed(A)`, then after a replay `step_started(B)`), and a run's
 * end two more (`step_completed(last)`, then `run_completed`). Here the
 * executor holds A's completion instead of writing it
 * (`StepExecutorParams.holdTerminal`), the workflow is replayed over the
 * durable prefix plus a synthetic, in-memory A, and when that replay's only new
 * work is one inline step B, or the run's end, the completion and the derived
 * events commit as one request:
 *
 *   `[step_completed|step_failed(A), step_created(B), step_started(B)]`
 *   `[step_completed|step_failed(last), run_completed|run_failed]`
 *
 * B's body starts only after that request is confirmed (`OutputCommit`), and
 * off its verdict (`preclaimedStart`), so a chain of sequential steps costs one
 * round trip per step.
 *
 * What makes this safe is what the World promises (see `Storage.events.commit`
 * in `@workflow/world`) plus four rules this file owns, one per guard of the
 * model it implements:
 *
 * - **FlushOnExit.** A held completion is written alone (`flushAlone()`, the
 *   executor's own write) before ANY other write leaves the process, on every
 *   path that does not commit it. Every exit below goes through
 *   {@link exitWithHeld}; `piggyback.test.ts` enumerates them.
 * - **BodyAfterCommit.** B runs only on a `committed` answer that verified.
 * - **OwnFromConsumed.** `own` is computed from the events fed to the replay,
 *   never from what this process has had acknowledged.
 * - **Scope: `pre` only from a durable read.** Only a server-loaded log is
 *   replayed over ({@link PiggybackHoldGate.prefixLoaded}); turbo's
 *   synthesized first-iteration log never is.
 *
 * The synthetic completion lives only in the array handed to the replay. It
 * never enters the loaded event log, a slot snapshot, or a cursor, and its id
 * (`PIGGYBACK_HELD_EVENT_ID`) is refused by every slot helper. On a verified
 * commit the same object is renamed to the committed row's id and joins the
 * log, which keeps the retained VM that consumed it a valid prefix; on every
 * other path the VM is discarded.
 */

import type { Span } from '@opentelemetry/api';
import { AmbiguousCommitError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import type {
  BatchEventRequest,
  CommitEventsRequest,
  CommitEventsResult,
  CreateEventRequest,
  Event,
  SerializedData,
  StartedStep,
  WorkflowRun,
  World,
} from '@workflow/world';
import {
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  PIGGYBACK_HELD_EVENT_ID,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
} from '@workflow/world';
import type { WorkflowSuspension } from '../global.js';
import { runtimeLogger } from '../logger.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { recordPiggybackHoldDuration } from '../telemetry.js';
import type { EndOfRunDrainHold } from '../workflow.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import {
  isPiggybackCommitEnabled,
  isPiggybackRunEndEnabled,
} from './constants.js';
import type { LoadedEventLog } from './helpers.js';
import type {
  HeldStepTerminal,
  PreclaimedInlineStart,
  StepExecutionResult,
} from './step-executor.js';
import type { PiggybackStepPairPlan } from './suspension-handler.js';

// ---------------------------------------------------------------------------
// Availability and the hold gate
// ---------------------------------------------------------------------------

/**
 * Worlds whose commit answered "unsupported for a while" (an old server
 * without the route), keyed by the `commit` function, until when. The World
 * keeps the authoritative memo (world-vercel's, keyed on the capability
 * header, 10 minutes); this mirror only lets the runtime skip holding at all,
 * so a deployment without the route pays neither the hold nor the replay.
 * On `globalThis` so every bundled copy of this module shares it.
 */
const commitUnsupported = globalSingleton(
  '@workflow/core//piggybackCommitUnsupported',
  1,
  () => ({ until: new WeakMap<object, number>() })
);

/** Test hook: forget every "commit unsupported" memo. */
export function resetPiggybackCommitMemoForTests(): void {
  commitUnsupported.until = new WeakMap();
}

function noteCommitUnsupported(world: World, forMs: number): void {
  const commit = world.events.commit;
  if (!commit || !(forMs > 0)) return;
  commitUnsupported.until.set(commit, Date.now() + forMs);
}

/**
 * The workflow name of eve's entry workflow, as the server's eve runtime depth
 * gate matches it (workflow-server `lib/eve-runtime-depth-gate.ts`).
 */
export const EVE_WORKFLOW_ENTRY = 'workflow//eve//workflowEntry';

/** A run the server's eve runtime depth gate may apply to. */
export function isEveSubagentRun(
  run: Partial<Pick<WorkflowRun, 'workflowName' | 'attributes'>> | undefined
): boolean {
  return (
    run?.workflowName === EVE_WORKFLOW_ENTRY &&
    run.attributes?.['$eve.type'] === 'subagent'
  );
}

/**
 * Whether this run could commit a piggyback pair at all: the World implements
 * `events.commit`, the run has a sealed log (the fence and gap seal need
 * positions handed out in advance), a flag is on, and the World has not said
 * the capability is unavailable. `undefined` when available; otherwise the
 * `workflow.piggyback.ineligible_reason` to report.
 */
export function piggybackUnavailableReason(
  world: World,
  run:
    | (Pick<WorkflowRun, 'specVersion'> &
        Partial<Pick<WorkflowRun, 'workflowName' | 'attributes'>>)
    | undefined
): string | undefined {
  const stepPair = isPiggybackCommitEnabled();
  const runEnd = isPiggybackRunEndEnabled();
  if (!stepPair && !runEnd) return 'disabled';
  const commit = world.events.commit;
  if (typeof commit !== 'function') return 'world_unsupported';
  // The first step of a chain is claimed through the batch pair
  // `[step_created, step_started]` (`foldLoneInlinePair`), so a World that
  // implements `commit` without `createBatch` cannot take this path at all.
  if (typeof world.events.createBatch !== 'function') {
    return 'world_unsupported';
  }
  if ((run?.specVersion ?? 0) < SPEC_VERSION_SUPPORTS_SEALED_LOG) {
    return 'spec_version';
  }
  // An eve subagent run may be subject to the server's eve runtime depth
  // gate, which today only the single lazy `step_started` path applies: it
  // turns an over-depth start into `step_failed`. The batch born-running
  // create does not run that gate, and piggyback claims every lone inline
  // step through it (`foldLoneInlinePair`) — so for these runs piggyback
  // would start a step the server would have failed. Keep such runs off
  // piggyback entirely, which keeps every one of their lone steps on the
  // gated lazy start exactly as today. The predicate mirrors the server's
  // (`classifyEveRuntimeDepthLimit`: workflow name and `$eve.type`) and is
  // deliberately wider than it: the server's further narrowing (Workflow Core
  // cohort, parent lineage) is not repeated here, so a future widening of
  // the server's gate cannot slip past this check.
  if (isEveSubagentRun(run)) return 'eve_subagent';
  const until = commitUnsupported.until.get(commit);
  if (until !== undefined) {
    if (Date.now() < until) return 'route_unsupported';
    commitUnsupported.until.delete(commit);
  }
  return undefined;
}

/** Everything the inline loop knows when it decides whether to hold. */
export interface PiggybackHoldGate {
  /** From {@link piggybackUnavailableReason}. */
  unavailableReason: string | undefined;
  /**
   * The loaded log came from a durable read, an inline delta, or a commit
   * response, and carries a real cursor. Turbo's synthesized first-iteration
   * log (empty, no cursor, local-clock run snapshot) never does: a pair derived
   * from it would not be derived from the durable prefix.
   */
  prefixLoaded: boolean;
  /** Owned executions in this inline batch (a hold needs exactly one). */
  inlineExecutions: number;
  /** The inline-delta gate: this is the clean single-step sequential case. */
  requestInlineDelta: boolean;
  /** Turbo's forced optimistic start applies to this batch. */
  forceOptimisticStart: boolean;
  /** The execution's pre-claim, when the suspension committed one. */
  preclaimedStart: PreclaimedInlineStart | undefined;
}

/**
 * Why a single inline execution will not be held, or `undefined` when it
 * will be. Deliberately strict: declining is always safe (the step writes its
 * completion exactly as today), and each condition rules out a case the
 * commit could not carry or would lose for certain.
 */
export function piggybackHoldIneligibleReason(
  gate: PiggybackHoldGate
): string | undefined {
  if (gate.unavailableReason !== undefined) return gate.unavailableReason;
  if (gate.inlineExecutions !== 1) return 'siblings';
  if (!gate.prefixLoaded) return 'turbo_synth_prefix';
  if (gate.forceOptimisticStart) return 'optimistic_start';
  // Everything the inline-delta gate requires (one step, one pending step, no
  // owned recovery, no wait due in this invocation) is required here too, for
  // the same reasons: the flush after an exit is exactly today's
  // delta-carrying write.
  if (!gate.requestInlineDelta) return 'not_sequential';
  const claim = gate.preclaimedStart;
  if (!claim || !claim.owned) return 'not_preclaimed';
  if (claim.events?.length !== 2) return 'own_rows_unknown';
  return undefined;
}

/**
 * Why a commit must not be sent now, or `undefined`. Evaluated immediately
 * before the request (and before holding the next step), because after a
 * `committed` answer the only continuation is starting B:
 *
 * - `replay_budget` / `invocation_timeout`: the loop would stop at its next
 *   boundary anyway, and B would be born running under a message about to be
 *   handed off, recoverable only by its lease;
 * - `channel_moved`: a run input reached this process since the iteration
 *   read its log — a foreign event above `after` the fence would reject, so
 *   the round trip is known to be wasted.
 */
export function piggybackPreSendExitReason(state: {
  replayBudgetExhausted: boolean;
  elapsedMs: number;
  inlineReplayLimitMs: number;
  /** The run-input activity revision now, when this invocation has one. */
  activityRevision: number | undefined;
  /** The revision when the iteration began. */
  iterationRevision: number;
}): string | undefined {
  if (state.replayBudgetExhausted) return 'replay_budget';
  if (state.elapsedMs >= state.inlineReplayLimitMs) {
    return 'invocation_timeout';
  }
  if (
    state.activityRevision !== undefined &&
    state.activityRevision !== state.iterationRevision
  ) {
    return 'channel_moved';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Log positions
// ---------------------------------------------------------------------------

/**
 * The highest slot of the dense prefix the log holds: every position from 1
 * through it is loaded. `undefined` when the log does not start at slot 1 (a
 * read that raced `run_created`), which is not a prefix a fence can start
 * from.
 */
export function denseTop(events: readonly Event[]): number | undefined {
  let top = 0;
  for (const event of events) {
    const slot = eventIdToSlot(event.eventId);
    if (slot === null) return undefined;
    if (slot <= top) continue;
    if (slot !== top + 1) break;
    top = slot;
  }
  return top >= FIRST_EVENT_SLOT ? top : undefined;
}

/**
 * The `own` ids of a commit: the events in the replay's input that sit above
 * `after`, in input order, excluding the synthetic completion. Derived from
 * what the replay consumed and nothing else (`OwnFromConsumed`).
 */
export function ownIdsAbove(
  replayInput: readonly Event[],
  after: number
): string[] {
  const own: string[] = [];
  for (const event of replayInput) {
    if (event.eventId === PIGGYBACK_HELD_EVENT_ID) continue;
    const slot = eventIdToSlot(event.eventId);
    if (slot !== null && slot > after) own.push(event.eventId);
  }
  return own;
}

/**
 * The in-memory event a replay consumes for a held completion. A plain
 * `step_completed` / `step_failed` row with the sentinel id and the time the
 * commit will store verbatim; mutable so a verified commit can rename it.
 */
export function syntheticHeldEvent(
  runId: string,
  held: HeldStepTerminal
): Event {
  const payload =
    held.eventType === 'step_completed'
      ? { result: held.eventData.result }
      : { error: held.eventData.error };
  return {
    eventId: PIGGYBACK_HELD_EVENT_ID,
    runId,
    eventType: held.eventType,
    correlationId: held.correlationId,
    specVersion: SPEC_VERSION_CURRENT,
    createdAt: held.occurredAt,
    eventData: { stepName: held.stepName, ...payload },
  } as unknown as Event;
}

/** A committed step row as the replay log holds it: without the step input. */
function asReplayLogRow(event: Event): Event {
  if (
    (event.eventType === 'step_created' ||
      event.eventType === 'step_started') &&
    event.eventData &&
    'input' in event.eventData
  ) {
    const { input: _input, ...eventData } = event.eventData as Record<
      string,
      unknown
    >;
    return { ...event, eventData } as unknown as Event;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Verification of a committed answer
// ---------------------------------------------------------------------------

/**
 * Why a `committed` answer does not match what was sent, or `undefined` when
 * it does: one row per event, same types and step ids, every `createdAt`
 * exactly the `occurredAt` sent, contiguous slots above `after`, and
 * `denseThrough` equal to the last. A mismatch should be impossible; if one
 * happens the runtime trusts none of it (see {@link runPiggybackChain}).
 */
export function verifyCommittedRows(
  sent: readonly BatchEventRequest[],
  answer: Extract<CommitEventsResult, { status: 'committed' }>,
  after: number
): string | undefined {
  if (answer.results.length !== sent.length) return 'row_count';
  let previous = after;
  for (let i = 0; i < sent.length; i++) {
    const checked = checkCommittedRow(
      i,
      answer.results[i]?.event,
      sent[i],
      previous
    );
    if (typeof checked === 'string') return checked;
    previous = checked;
  }
  if (answer.denseThrough !== previous) return 'dense_through';
  if (typeof answer.cursor !== 'string' || answer.cursor.length === 0) {
    return 'cursor';
  }
  return undefined;
}

/** One row of {@link verifyCommittedRows}: its slot, or why it is wrong. */
function checkCommittedRow(
  index: number,
  row: Event | undefined,
  request: BatchEventRequest,
  previous: number
): number | string {
  if (!row) return `row_${index}_missing`;
  if (row.eventType !== request.event.eventType) return `row_${index}_type`;
  if (
    request.event.correlationId !== undefined &&
    row.correlationId !== request.event.correlationId
  ) {
    return `row_${index}_correlation`;
  }
  const occurredAt = request.occurredAt?.getTime();
  if (
    occurredAt === undefined ||
    new Date(row.createdAt).getTime() !== occurredAt
  ) {
    return `row_${index}_created_at`;
  }
  const slot = eventIdToSlot(row.eventId);
  // The first row sits above `after`; each later one directly follows.
  const valid =
    slot !== null && (index === 0 ? slot > previous : slot === previous + 1);
  return valid ? slot : `row_${index}_slot`;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** What a replay over a held completion produced. */
export type PiggybackReplayOutcome =
  | { type: 'suspended'; suspension: WorkflowSuspension }
  | { type: 'completed'; output: unknown }
  | { type: 'failed'; error: unknown };

/** A run failure ready to commit, and what to do once it has. */
export interface PiggybackRunFailure {
  eventData: { error: SerializedData; errorCode: string };
  onCommitted: () => void;
}

/** One inline step to execute off a verified pair. */
export interface PiggybackNextStep {
  correlationId: string;
  stepName: string;
  preclaimedStart: Extract<PreclaimedInlineStart, { owned: true }>;
  /** Hold this step's completion too (the chain continues). */
  holdTerminal: boolean;
  /** The replay that derived this step, for its latency telemetry. */
  replayMs: number;
}

/**
 * The inline loop's state and effects, as the chain needs them. Everything is
 * the loop's own: the log is mutated in place, and the replay, the VM, the
 * payload cache and the step executor are the loop's.
 */
export interface PiggybackChainContext {
  runId: string;
  world: World;
  requestId?: string;
  /** This delivery's message id: the ownership stamp on B's start. */
  ownerMessageId: string | undefined;
  /** The loop's ready event log; extended in place on a verified commit. */
  eventLog: LoadedEventLog;
  /** Owned executions in flight, which a held completion counts in. */
  inFlightOwnedSteps: Set<string>;
  span?: Span;
  /**
   * Replay (resume the retained VM, or cold-replay) over `events` with the
   * end-of-run drain held. Leaves the resulting VM as the loop's retained
   * session.
   */
  replay(
    events: Event[],
    drainHold: EndOfRunDrainHold
  ): Promise<PiggybackReplayOutcome>;
  /**
   * Forget the VM that consumed the synthetic completion, and anything cached
   * under the sentinel id. Local state only: never a write.
   */
  discardReplay(): void;
  /** Keep or drop the retained VM after a committed step pair. */
  retainAfterCommit(
    suspension: WorkflowSuspension,
    serializationBlockerCount: number
  ): void;
  /** Move cached payload work from the sentinel to the committed id. */
  rekeyHeldEvent(committedEventId: string): void;
  /** Fold the suspension into the second half of a step pair. */
  buildStepPair(suspension: WorkflowSuspension): Promise<PiggybackStepPairPlan>;
  /**
   * A replay's failure as a committable `run_failed`, or `undefined` when it
   * must go through today's terminal path (anything but a plain user error).
   */
  buildRunFailure(error: unknown): Promise<PiggybackRunFailure | undefined>;
  /** Side effects of a committed `run_completed` (hooks, span status). */
  onRunCompleted(): void;
  /**
   * Checked immediately before a commit is sent (budget, timeout, a channel
   * notice of a foreign event): after a `committed` answer the only
   * continuation is starting B, so every reason to stop is evaluated first.
   */
  preSendExitReason(): string | undefined;
  /**
   * Whether the next step's completion may be held as well: commits are
   * still available for this run and no pre-send exit already applies.
   */
  mayHoldNext(): boolean;
  /** Execute B off the pair's verdict. */
  runStep(step: PiggybackNextStep): Promise<StepExecutionResult>;
}

/** A held completion and the execution it belongs to. */
export interface HeldExecution {
  correlationId: string;
  stepName: string;
  result: Extract<StepExecutionResult, { type: 'held' }>;
  /**
   * The step's own rows above the loaded log (its `step_created` and
   * `step_started`), which the replay consumes before the completion and the
   * fence exempts. Empty when they are already in the loaded log.
   */
  ownTail: Event[];
}

/** How a chain ended, for the inline loop's ordinary bookkeeping. */
export type PiggybackChainOutcome =
  | {
      /**
       * The last step's result as an ordinary execution result, for the step
       * named here. After an exit it is `flushAlone()`'s result; after an
       * ambiguous exit its inline delta is dropped, so the loop re-reads.
       */
      type: 'step';
      correlationId: string;
      stepName: string;
      result: StepExecutionResult;
    }
  | {
      /** A run-end pair committed: the run is finished. */
      type: 'run_finished';
    };

/** Counters one chain reports on the invocation span. */
interface ChainStats {
  commits: number;
  exits: number;
}

/**
 * Commit a held completion and, while each commit derives the next step and
 * that step's completion is held again, keep committing. Returns once a
 * completion is written alone (an exit), a run-end pair commits, or a step
 * runs without a hold.
 *
 * Exits never throw on their own: whatever the replay or the pair building
 * throws is an exit like any other (flush, then today's path, whose own replay
 * reproduces a deterministic failure). Only `flushAlone()` and B's own
 * execution can reject, exactly as the writes they replace could.
 */
export async function runPiggybackChain(
  ctx: PiggybackChainContext,
  first: HeldExecution
): Promise<PiggybackChainOutcome> {
  const stats: ChainStats = { commits: 0, exits: 0 };
  let held = first;
  try {
    for (;;) {
      const step = await commitHeld(ctx, held, stats);
      if (step.type !== 'next') return step.outcome;
      held = step.held;
    }
  } finally {
    ctx.span?.setAttributes({
      ...Attribute.WorkflowPiggybackCommits(stats.commits),
      ...Attribute.WorkflowPiggybackExits(stats.exits),
    });
  }
}

type CommitStep =
  | { type: 'done'; outcome: PiggybackChainOutcome }
  | { type: 'next'; held: HeldExecution };

/**
 * The one way out of a hold other than a commit (FlushOnExit): forget the VM
 * that consumed the synthetic completion, write the completion alone exactly
 * as the executor would have, and hand its result to today's path.
 *
 * `reread` is for an ambiguous commit: the pair may have landed, so the
 * flush's delta cannot be taken as the log (a 409 on it carries none anyway),
 * and the loop reads before deciding anything else. Owned recovery then runs
 * B, if the pair landed with this delivery's ownership stamp, from its durable
 * input.
 */
async function exitWithHeld(
  ctx: PiggybackChainContext,
  held: HeldExecution,
  stats: ChainStats,
  reason: string,
  { reread = false }: { reread?: boolean } = {}
): Promise<CommitStep> {
  stats.exits++;
  ctx.span?.setAttributes(Attribute.WorkflowPiggybackIneligibleReason(reason));
  ctx.discardReplay();
  let flushed: StepExecutionResult;
  try {
    flushed = await held.result.flushAlone();
  } finally {
    ctx.inFlightOwnedSteps.delete(held.correlationId);
    void recordPiggybackHoldDuration(
      Date.now() - held.result.held.heldAtMs,
      reason
    );
  }
  runtimeLogger.debug('Piggyback hold exited; wrote the completion alone', {
    workflowRunId: ctx.runId,
    stepId: held.correlationId,
    reason,
    reread,
    flushed: flushed.type,
  });
  const result =
    reread && flushed.type === 'completed'
      ? { ...flushed, inlineDelta: undefined }
      : flushed;
  return {
    type: 'done',
    outcome: {
      type: 'step',
      correlationId: held.correlationId,
      stepName: held.stepName,
      result,
    },
  };
}

/** A commit request built from a replay over the held completion. */
interface PlannedCommit {
  request: CommitEventsRequest;
  /** The synthetic completion the replay consumed (renamed on commit). */
  synthetic: Event;
  replayMs: number;
  kind: 'step' | 'run_completed' | 'run_failed';
  /** The step pair's second half (`kind: 'step'`). */
  plan?: Extract<PiggybackStepPairPlan, { eligible: true }>;
  suspension?: WorkflowSuspension;
  runFailure?: PiggybackRunFailure;
}

/**
 * Phase 1 of a hold: replay over the durable prefix plus the synthetic
 * completion, and turn what the replay produced into a commit request, or
 * name the exit. Writes nothing (the replay's end-of-run drain is held).
 */
async function planCommit(
  ctx: PiggybackChainContext,
  held: HeldExecution
): Promise<PlannedCommit | { exit: string }> {
  const heldEvent = held.result.held;
  const after = denseTop(ctx.eventLog.events);
  if (after === undefined) return { exit: 'prefix_not_dense' };
  const synthetic = syntheticHeldEvent(ctx.runId, heldEvent);
  const replayInput = [...ctx.eventLog.events, ...held.ownTail, synthetic];
  const own = ownIdsAbove(replayInput, after);
  // Every `own` id is in the replay input by construction; the tail must also
  // sit wholly above the prefix (it is the step's own later writes).
  if (own.length !== held.ownTail.length) return { exit: 'own_below_prefix' };

  const drainHold: EndOfRunDrainHold = { drainPending: false };
  const replayStartedAt = Date.now();
  const replayed = await ctx.replay(replayInput, drainHold);
  const replayMs = Date.now() - replayStartedAt;

  const heldRequest: BatchEventRequest = {
    event: {
      eventType: heldEvent.eventType,
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: heldEvent.correlationId,
      eventData: heldEvent.eventData,
    } as unknown as CreateEventRequest,
    occurredAt: heldEvent.occurredAt,
  };

  if (replayed.type === 'suspended') {
    if (!isPiggybackCommitEnabled()) return { exit: 'step_pair_disabled' };
    if (ctx.ownerMessageId === undefined) return { exit: 'no_owner_message' };
    const built = await ctx.buildStepPair(replayed.suspension);
    if (!built.eligible) return { exit: built.reason };
    const occurredAt = new Date();
    return {
      request: {
        after,
        own,
        events: [
          heldRequest,
          { event: built.events[0], occurredAt },
          {
            event: built.events[1],
            occurredAt,
            computeInstanceId: COMPUTE_INSTANCE_ID,
          },
        ],
      },
      synthetic,
      replayMs,
      kind: 'step',
      plan: built,
      suspension: replayed.suspension,
    };
  }
  if (!isPiggybackRunEndEnabled()) return { exit: 'run_end_disabled' };
  if (drainHold.drainPending) return { exit: 'end_of_run_drain' };
  if (replayed.type === 'completed') {
    return {
      request: {
        after,
        own,
        events: [
          heldRequest,
          {
            event: {
              eventType: 'run_completed',
              specVersion: SPEC_VERSION_CURRENT,
              eventData: { output: replayed.output },
            } as CreateEventRequest,
            occurredAt: new Date(),
          },
        ],
      },
      synthetic,
      replayMs,
      kind: 'run_completed',
    };
  }
  const runFailure = await ctx.buildRunFailure(replayed.error);
  if (!runFailure) return { exit: 'run_failed_not_user_error' };
  return {
    request: {
      after,
      own,
      events: [
        heldRequest,
        {
          event: {
            eventType: 'run_failed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: runFailure.eventData,
          } as CreateEventRequest,
          occurredAt: new Date(),
        },
      ],
    },
    synthetic,
    replayMs,
    kind: 'run_failed',
    runFailure,
  };
}

/**
 * One hold: plan, send, and act on the answer. Every way out before a
 * `committed` answer is {@link exitWithHeld}; after one, the only
 * continuation is {@link continueAfterCommit}, which never flushes.
 */
async function commitHeld(
  ctx: PiggybackChainContext,
  held: HeldExecution,
  stats: ChainStats
): Promise<CommitStep> {
  const exit = (reason: string, options?: { reread?: boolean }) =>
    exitWithHeld(ctx, held, stats, reason, options);
  const commit = ctx.world.events.commit;
  if (typeof commit !== 'function') return exit('world_unsupported');

  let planned: PlannedCommit | { exit: string };
  try {
    planned = await planCommit(ctx, held);
  } catch (error) {
    runtimeLogger.debug('Piggyback replay or pair build failed; exiting', {
      workflowRunId: ctx.runId,
      stepId: held.correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return exit('replay_error');
  }
  if ('exit' in planned) return exit(planned.exit);
  // Budget, timeout and channel checks happen here, never after the answer:
  // a committed pair's only continuation is starting B.
  const preSend = ctx.preSendExitReason();
  if (preSend !== undefined) return exit(preSend);

  const sentAtMs = Date.now();
  let answer: CommitEventsResult;
  try {
    answer = await commit.call(ctx.world.events, ctx.runId, planned.request, {
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    });
  } catch (error) {
    // Anything but a definite answer may have committed: flush (a 409 means
    // the pair or a duplicate probably landed), then re-read before deciding.
    return exit(AmbiguousCommitError.is(error) ? 'ambiguous' : 'commit_error', {
      reread: true,
    });
  }
  const answeredAtMs = Date.now();
  if (answer.status === 'rejected') {
    if (answer.unsupportedForMs !== undefined) {
      noteCommitUnsupported(ctx.world, answer.unsupportedForMs);
    }
    return exit(`rejected_${answer.reason}`);
  }
  return continueAfterCommit(ctx, held, stats, planned, answer, {
    sentAtMs,
    answeredAtMs,
  });
}

/**
 * Phase 3: act on a `committed` answer. A is durable from here on, so nothing
 * in this function writes it again: it verifies, joins the confirmed rows to
 * the log, and either finishes the run or starts B off the pair's verdict.
 */
async function continueAfterCommit(
  ctx: PiggybackChainContext,
  held: HeldExecution,
  stats: ChainStats,
  planned: PlannedCommit,
  answer: Extract<CommitEventsResult, { status: 'committed' }>,
  { sentAtMs, answeredAtMs }: { sentAtMs: number; answeredAtMs: number }
): Promise<CommitStep> {
  const heldEvent = held.result.held;
  const { request, synthetic, replayMs, kind, runFailure } = planned;
  // --- Committed. No exit from here on: A is durable. ---------------------
  ctx.inFlightOwnedSteps.delete(held.correlationId);
  void recordPiggybackHoldDuration(
    Date.now() - heldEvent.heldAtMs,
    'committed'
  );
  const mismatch = verifyCommittedRows(request.events, answer, request.after);
  if (mismatch !== undefined) {
    // Should be impossible. Trust none of it: discard the VM, run nothing,
    // and re-read. A is durable; owned recovery runs B from its durable
    // input if the pair created it.
    runtimeLogger.error(
      'Piggyback commit answered with rows that do not match the request; discarding the replay and re-reading',
      {
        workflowRunId: ctx.runId,
        stepId: held.correlationId,
        mismatch,
      }
    );
    ctx.span?.setAttributes(
      Attribute.WorkflowPiggybackIneligibleReason(`verify_${mismatch}`)
    );
    ctx.discardReplay();
    return {
      type: 'done',
      outcome: {
        type: 'step',
        correlationId: held.correlationId,
        stepName: held.stepName,
        result: { type: 'completed' },
      },
    };
  }
  stats.commits++;

  // The committed completion is the synthetic event the replay consumed: same
  // bytes, same time (verified). Renaming the very object keeps the retained
  // VM's consumed events a prefix of the log it resumes over next.
  const committedCompletion = answer.results[0].event;
  (synthetic as { eventId: string }).eventId = committedCompletion.eventId;
  ctx.rekeyHeldEvent(committedCompletion.eventId);

  // Splice the confirmed rows onto the log only when nothing else sits
  // between them and the prefix: the steady state. When the World sealed gap
  // positions (noops the client never read), the log is left as it was and
  // the next write's delta (or read) brings them with the rest.
  const firstCommittedSlot = request.after + held.ownTail.length + 1;
  const ownContiguous = held.ownTail.every(
    (event, index) => eventIdToSlot(event.eventId) === request.after + index + 1
  );
  const gapFree =
    ownContiguous &&
    eventIdToSlot(committedCompletion.eventId) === firstCommittedSlot;

  if (kind !== 'step') {
    if (kind === 'run_completed') ctx.onRunCompleted();
    else runFailure?.onCommitted();
    runtimeLogger.debug('Piggyback run-end pair committed', {
      workflowRunId: ctx.runId,
      stepId: held.correlationId,
      kind,
    });
    return { type: 'done', outcome: { type: 'run_finished' } };
  }

  // biome-ignore lint/style/noNonNullAssertion: set on the step path
  const pair = planned.plan!;
  if (gapFree) {
    ctx.eventLog.events.push(
      ...held.ownTail.map(asReplayLogRow),
      synthetic,
      asReplayLogRow(answer.results[1].event),
      asReplayLogRow(answer.results[2].event)
    );
    ctx.eventLog.cursor = answer.cursor;
    // biome-ignore lint/style/noNonNullAssertion: set on the step path
    ctx.retainAfterCommit(planned.suspension!, pair.serializationBlockerCount);
  } else {
    ctx.discardReplay();
  }

  const startedRow = answer.results[2];
  const now = new Date();
  const startedStep: StartedStep = startedRow.step?.startedAt
    ? { ...startedRow.step, startedAt: startedRow.step.startedAt }
    : {
        runId: ctx.runId,
        stepId: pair.correlationId,
        stepName: pair.stepName,
        status: 'running',
        attempt: 1,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      };
  const preclaimedStart: Extract<PreclaimedInlineStart, { owned: true }> = {
    owned: true,
    step: { ...startedStep, input: pair.dehydratedInput },
    batchPostSentAtMs: sentAtMs,
    claimCompletedAtMs: answeredAtMs,
    source: 'piggyback',
    events: [answer.results[1].event, answer.results[2].event],
  };
  // B's completion is held too when its own pair could follow: its rows are
  // in the log (so its replay needs no tail) and nothing has since made a
  // commit unavailable or pointless.
  const holdNext = gapFree && ctx.mayHoldNext();

  ctx.inFlightOwnedSteps.add(pair.correlationId);
  let result: StepExecutionResult;
  try {
    result = await ctx.runStep({
      correlationId: pair.correlationId,
      stepName: pair.stepName,
      preclaimedStart,
      holdTerminal: holdNext,
      replayMs,
    });
  } catch (error) {
    ctx.inFlightOwnedSteps.delete(pair.correlationId);
    throw error;
  }
  if (result.type === 'held') {
    // B's rows are in the log already (gapFree), so its hold has no tail.
    return {
      type: 'next',
      held: {
        correlationId: pair.correlationId,
        stepName: pair.stepName,
        result,
        ownTail: [],
      },
    };
  }
  ctx.inFlightOwnedSteps.delete(pair.correlationId);
  return {
    type: 'done',
    outcome: {
      type: 'step',
      correlationId: pair.correlationId,
      stepName: pair.stepName,
      result,
    },
  };
}
