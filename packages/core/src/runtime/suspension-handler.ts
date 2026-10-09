import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  FatalError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  AttributeValidationError,
  type CreateEventParams,
  type CreateEventRequest,
  type EventResult,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { importKey } from '../encryption.js';
import type {
  AttributeInvocationQueueItem,
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import { runtimeLogger } from '../logger.js';
import {
  GUEST_CODE_EXECUTION_SAMPLE_LIMIT,
  type GuestCodeExecution,
  type GuestCodeStats,
} from '../serialization/hardened.js';
import { dehydrateStepArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getAbortStreamIdFromToken } from '../util.js';
import {
  absorbSkippedSlotReport,
  type EventCreator,
  type LoadedEventLog,
  mergeReportedEvents,
  slotSnapshotParams,
} from './helpers.js';
import {
  publishForceClaimVictimWake,
  republishOwedForceClaimVictimWakes,
} from './hook-wake.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  span?: Span;
  requestId?: string;
  /**
   * The runtime's loaded event log. Every event creation this suspension makes
   * names the position it was derived from, so a backend that has recorded
   * events the replay did not see can report them back on the write, or, if
   * it would rather refuse than report, reject it with a 412. A rejection is
   * not retried here: the event's correlation id was minted by *this* replay's
   * seeded sequence, so re-committing it against a corrected log would persist
   * an event no correct replay produces. The caller restarts the replay
   * instead.
   *
   * Extended in place by what those writes report back — the events on slots
   * they skipped over, and (on the hook create) the inline delta since its
   * cursor. Whether the log is complete afterwards is answered by
   * {@link SuspensionHandlerResult.eventLogCarriedForward}.
   */
  eventLog?: LoadedEventLog;
  /** One-shot telemetry reporter, activated only after replay has recovered. */
  replayRecoveryReporter?: ReplayRecoveryReporter;
  /**
   * The invocation's record of hooks whose force-claim victim wake it has
   * already published or attempted, whether as the forced creation's own wake
   * or as a replay's republish (see `republishOwedForceClaimVictimWakes`). The
   * caller passes one set for the whole invocation so a run that suspends more
   * than once per invocation sends each hook's wake once, not once per
   * suspension. Omitted, every suspension republishes on its own.
   */
  forceClaimVictimWakes?: Set<string>;
  /**
   * Writes this suspension's events in place of `world.events.create`. The
   * single-orchestrator runtime passes its in-band writer, so every write is
   * marked in-band and fenced.
   */
  writeEvent?: EventCreator;
}

/**
 * Result of handling a suspension. Returns pending step items so the caller
 * can decide which to execute inline vs queue to background.
 */
export interface SuspensionHandlerResult {
  /** Pending step items with events created but NOT queued */
  pendingSteps: StepInvocationQueueItem[];
  /**
   * Correlation IDs for which this suspension call actually wrote the
   * step_created event (as opposed to catching EntityConflictError because
   * a concurrent handler wrote it first). Only the handler that wrote the
   * step_created event should queue / inline-execute the step; this
   * guarantees a single owner per step, even when multiple handlers race
   * into the same batch boundary.
   */
  createdStepCorrelationIds: Set<string>;
  /**
   * Correlation IDs of steps whose arguments failed to serialize. Each was
   * finalized here as `step_created` (with a placeholder input; the real
   * input is precisely what refused to serialize) followed by `step_failed`
   * carrying the SerializationError, so the next replay rejects the step's
   * promise and a try/catch around the step call observes the error,
   * exactly like a step-body failure. No step-execution message is
   * dispatched for these, so the caller MUST force an in-process replay:
   * when the failed step was the only pending work, nothing else will ever
   * re-invoke the run to observe the terminal event.
   */
  failedStepCorrelationIds: Set<string>;
  /**
   * How many events this phase's writes reported back as occupying slots they
   * skipped over, already merged into the caller's `eventLog.events`. Nonzero
   * means the array was reordered to restore slot order, so any index the
   * caller cached into it (payload prewarm scan position) is stale.
   */
  reportedEventCount: number;
  /**
   * The soonest pending wait, if any: seconds until it elapses and the
   * correlationId of the wait that produced that timeout. `resumeAtMs`
   * is that wait's absolute deadline, for gates that ask whether it can fire
   * within some window rather than how long until it does.
   *
   * Covers every wait still in the workflow's queue, not only ones this
   * suspension created: a `sleep()` that lost a `Promise.race` stays queued
   * (and reported here) until its `wait_completed` lands.
   */
  waitTimeout?: { seconds: number; correlationId: string; resumeAtMs: number };
  /**
   * Whether a hook create committed a `hook_conflict` — the token was already
   * claimed, so this run's hook was never created. The caller answers it by
   * advancing the workflow over the committed event before it dispatches or
   * runs the steps this suspension scheduled. Those steps were written
   * alongside the hook create, not after it, so their `step_created` events
   * (and, on the batched path, their step messages and any pre-claimed inline
   * pairs in {@link inlineClaims}) may already be out: work the workflow
   * started concurrently with the hook is not held back by its conflict.
   */
  hasHookConflict: boolean;
  /** Whether a `hook.getConflict()` awaiter needs the workflow to continue immediately */
  hasAwaitedHookCreation: boolean;
  /**
   * Correlation ids of the hooks this suspension committed a `hook_created`
   * for while a `hook.getConflict()` awaiter was waiting on it — the events
   * that resolve those awaiters on the next pass. Empty exactly when
   * {@link hasAwaitedHookCreation} is false.
   *
   * Reported by id, not just counted, so a caller that continues in this
   * process can tell a continuation that got somewhere from one that is
   * repeating: a workflow may create one awaited hook after another, and each
   * new id is a pass that made progress, while the same id coming back means
   * the pass ran over a log that still did not hold its event and continuing
   * again cannot change that.
   */
  awaitedHookCorrelationIds: string[];
  /**
   * Correlation ids of the hooks whose create committed a `hook_conflict`.
   * Empty exactly when {@link hasHookConflict} is false.
   *
   * By id for the same reason as {@link awaitedHookCorrelationIds}, and
   * against the same hazard: a conflict is resolved by the `hook_conflict`
   * this suspension committed, and until the workflow observes it the hook
   * stays in the invocations queue and the next pass writes the create again.
   * A fresh id is progress; the same id coming back is a pass that ran over a
   * log which still did not hold the event, so continuing again cannot change
   * that.
   */
  hookConflictCorrelationIds: string[];
  /**
   * Whether the caller's `eventLog` now holds every event this suspension
   * committed, so a caller that continues in this process can replay — or
   * resume a retained VM — straight off it with no read.
   *
   * True only when the hook create's inline delta came back complete and was
   * folded in (see `hookDeltaCursor` below), and nothing else in this
   * suspension wrote an event. False whenever a read is needed first: no
   * delta was asked for or returned, it was truncated, or a step / wait /
   * attribute / abort write (single or batched) also committed and may not be
   * in it.
   *
   * Indifferent to which event the create committed: the delta is the slice
   * of the log after the caller's cursor either way, so it carries a
   * `hook_conflict` exactly as it carries a `hook_created`.
   */
  eventLogCarriedForward: boolean;
  /** Whether native workflow attribute events were written for replay. */
  hasAttributeEvents: boolean;
  /**
   * Whether this suspension created any hook (`hook_created`) events. Unlike
   * `hasHookConflict` / `hasAwaitedHookCreation`, this is true even for a plain
   * fire-and-forget hook with no conflict and no awaiter. Turbo mode uses it to
   * detect "a hook was created this suspension" and stop forcing optimistic
   * inline start (a hook introduces later resume invocations that could race).
   */
  hasHookEvents: boolean;
  /**
   * Wall-clock ms this suspension spent blocked on nothing but committing its
   * `hook_created` events (0 when it created none): the stretch the hook
   * writes outlasted every other write, since until then the suspension was
   * waiting on those too. The caller accumulates this across iterations and
   * subtracts it from the TTFS latency measurement, so time spent durably
   * creating the user's hooks doesn't count as runtime overhead.
   */
  hookCreationMs: number;
  /** Exact number of workflow-code executions observed during serialization. */
  serializationBlockerCount: number;
  /** Bounded sample used only for retention diagnostics. */
  serializationBlockers: SuspensionSerializationBlocker[];
}

export interface SuspensionSerializationBlocker extends GuestCodeExecution {
  source: 'step_input' | 'hook_metadata' | 'hook_abort';
  correlationId: string;
}

async function createHookEvent({
  runId,
  hookEvent,
  queueItem,
  requestId,
  sinceCursor,
  createEvent,
  world,
  forceClaimVictimWakes,
}: {
  runId: string;
  hookEvent: CreateEventRequest;
  queueItem: HookInvocationQueueItem;
  requestId?: string;
  /**
   * Needed only to wake the run a forced creation took its token from; see
   * `publishForceClaimVictimWake`.
   */
  world: World;
  /** See {@link SuspensionHandlerParams.forceClaimVictimWakes}. */
  forceClaimVictimWakes?: Set<string>;
  /**
   * Cursor to ask the World for the event-log delta against, or undefined to
   * not ask. See `hookDeltaCursor` in {@link handleSuspension} for when it is
   * set and why it is at most one write per suspension.
   */
  sinceCursor?: string;
  createEvent: (
    data: CreateEventRequest,
    params?: CreateEventParams
  ) => Promise<EventResult>;
}): Promise<{
  hasHookConflict: boolean;
  hasAwaitedHookCreation: boolean;
}> {
  try {
    const result = await createEvent(hookEvent, {
      requestId,
      ...(sinceCursor === undefined ? {} : { sinceCursor }),
    });

    // Check if the world returned a hook_conflict event instead of hook_created.
    // The hook_conflict event is stored in the event log and is what the next
    // pass consumes to settle the hook's awaiters — rejecting a payload await,
    // resolving a `hook.getConflict()` with the conflicting run. An inline
    // delta asked for above carries it just as it would have carried the
    // hook_created, so the caller can advance over it without a re-invocation.
    if (result.event?.eventType === 'hook_conflict') {
      return {
        hasHookConflict: true,
        hasAwaitedHookCreation: false,
      };
    }

    // A forced creation that took the token over: the World journaled the
    // victim's `hook_disposed{forceClaimedBy}` and recorded the victim on the
    // hook. The victim only reads that row when something invokes it, and the
    // World has no queue, so the wake is ours to publish. A claimer that dies
    // before it goes out has left the forced `hook_created` in its log, and
    // every replay inside the republish window repays it
    // (`forcedCreationsOwingWake`), whatever else this suspension wrote. See
    // `publishForceClaimVictimWake` for why a wake that still fails does not
    // fail the claimer.
    if (result.hook?.claimedFrom) {
      forceClaimVictimWakes?.add(result.hook.hookId);
      const outcome = await publishForceClaimVictimWake(
        world,
        runId,
        result.hook
      );
      runtimeLogger.info('Hook token force-claimed from another run', {
        workflowRunId: runId,
        hookId: queueItem.correlationId,
        victimRunId: result.hook.claimedFrom.runId,
        victimWake: outcome,
      });
    }

    return {
      hasHookConflict: false,
      hasAwaitedHookCreation: queueItem.hasConflictAwaiter === true,
    };
  } catch (err) {
    if (EntityConflictError.is(err)) {
      runtimeLogger.info('Hook already exists, continuing', {
        workflowRunId: runId,
        message: err.message,
      });
      return {
        hasHookConflict: false,
        hasAwaitedHookCreation: queueItem.hasConflictAwaiter === true,
      };
    }

    if (RunExpiredError.is(err)) {
      runtimeLogger.info('Workflow run already completed, skipping hook', {
        workflowRunId: runId,
        message: err.message,
      });
      return {
        hasHookConflict: false,
        hasAwaitedHookCreation: false,
      };
    }

    if (isWorldValidationFailure(err)) {
      const fatal = new FatalError(
        `createHook failed World validation: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      fatal.cause = err;
      throw fatal;
    }

    throw err;
  }
}

/**
 * Handles a workflow suspension by processing all pending operations (hooks, steps, waits).
 * Creates events for all operations but does NOT queue step messages; returns the pending
 * steps so the caller can decide which to execute inline vs queue to background.
 *
 * Every write is issued concurrently: hook creations and disposals (in code
 * order per token, then abort deliveries), step and wait events (batched where
 * the World supports it), and attribute events.
 *
 * Hooks are not written ahead of the steps created alongside them. A step
 * started in the same suspension as a hook can therefore run before that hook
 * is registered; a workflow that needs the hook registered first (say, a step
 * that hands the token to something that resumes it at once) awaits
 * `hook.getConflict()` before calling the step.
 */
export async function handleSuspension({
  suspension,
  world,
  run,
  span,
  requestId,
  eventLog,
  replayRecoveryReporter,
  forceClaimVictimWakes,
  writeEvent,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  const runId = run.runId;

  // Every recent forced creation in the loaded log may still owe its victim a
  // wake (the invocation that created it may have died before publishing), so
  // it is republished, as an unkeyed wake; see
  // `forcedCreationsOwingWake` for the rule and its window. The rule reads
  // nothing this suspension writes, so the republish goes out alongside the
  // writes below instead of ahead of them, and is joined before returning.
  // It never rejects.
  const owedVictimWakes = republishOwedForceClaimVictimWakes(
    world,
    runId,
    eventLog?.events,
    { alreadyWoken: forceClaimVictimWakes }
  );

  /**
   * Await every operation in a suspension phase before letting a failure
   * escape, preferring a stale-snapshot (412) rejection when one occurred.
   *
   * `Promise.all` rejects as soon as one operation does and leaves its siblings
   * in flight. That matters for a 412: the caller reacts by reloading the event
   * log and restarting the replay, so a sibling create that lands after the
   * rejection escaped commits an event whose correlation id came from the
   * abandoned replay's seeded sequence (an event the fresh replay never
   * produces), and it races the restart's reload while doing so. Settling first
   * makes this phase's write set final before the caller acts on the failure.
   * It mirrors the runtime's inline step claim, which settles the in-flight
   * step executions before escalating a 412.
   *
   * A 412 is preferred over any other rejection in the same phase because it
   * has a defined, cheap recovery (replay from a corrected log) while the
   * others do not. A deterministic failure such as an attribute-validation
   * `FatalError` recurs on the restart and fails the run then, at the cost of
   * one extra replay.
   */
  const settlePhase = async (ops: Promise<unknown>[]): Promise<void> => {
    const reasons = (await Promise.allSettled(ops))
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (reasons.length === 0) return;
    throw reasons.find((r) => PreconditionFailedError.is(r)) ?? reasons[0];
  };

  // Every suspension write carries replay-recovery telemetry on the first one
  // that commits after replay recovered. All suspension events are
  // non-run_created events on this run's `runId`.
  const reporter = replayRecoveryReporter ?? ReplayRecoveryReporter.inert();
  const createEvent = (data: CreateEventRequest, params?: CreateEventParams) =>
    reporter.withEventCreate(params, (p) =>
      writeEvent ? writeEvent(data, p) : world.events.create(runId, data, p)
    );
  // Adds the optimistic-concurrency guard when the caller supplied a loaded
  // event log; without one it creates directly (callers with no replay
  // snapshot, e.g. tests). A stale (412) rejection propagates to the caller,
  // which restarts the replay from a corrected log. It is not retried here,
  // because the event's correlation id was minted by *this* replay's seeded
  // sequence, so re-committing it against a corrected log would persist an
  // event no correct replay produces.
  let reportedEvents = 0;
  // Event writes this suspension issued (single creates and batch commits
  // alike), and whether one of them handed back a complete inline delta that
  // was folded into the caller's log. Together they answer
  // `eventLogCarriedForward`: the delta covers the log up to the write that
  // returned it, so it accounts for every event this suspension committed only
  // if that write was the only one.
  let eventWrites = 0;
  let deltaAbsorbed = false;
  const createGuarded: EventCreator = async (data, params) => {
    eventWrites++;
    if (!eventLog) {
      return createEvent(data, params);
    }
    const log = eventLog;
    const result = await createEvent(data, {
      ...params,
      ...slotSnapshotParams(log.events),
    });
    // An inline delta this call asked for (`sinceCursor`) is everything the
    // log gained since that cursor, this write included, so it is folded onto
    // the tail and carries the cursor with it — unlike a skipped-slot report,
    // which is a window strictly below the write and has to be sorted back
    // into place. A World returns one or the other, never both (the delta is a
    // strict superset), so the two are handled apart rather than merged.
    //
    // Declining is always safe — an unabsorbed delta is one the next read
    // returns — so the guards match the replay loop's `absorbCreateDelta`: a
    // truncated page (`hasMore`) is dropped whole rather than advancing the
    // cursor past events it did not carry, and the log must still be at the
    // cursor the request was computed from.
    //
    // The delta is merged in slot order rather than appended: the hook create
    // that asks for it runs concurrently with this suspension's other writes,
    // and one of those may have folded a skipped-slot report in while it was
    // in flight, leaving events above some of the delta's. The union is still
    // a prefix of the log (the delta covers everything from the cursor up to
    // this write, a report everything its write skipped), so sorting it is
    // all the repair it needs.
    if (typeof params?.sinceCursor === 'string') {
      if (
        log.cursor === params.sinceCursor &&
        result.events !== undefined &&
        result.hasMore !== true
      ) {
        mergeReportedEvents(log.events, result.events);
        log.cursor = result.cursor ?? log.cursor;
        deltaAbsorbed = true;
      }
      return result;
    }
    // Bump-and-report: the write landed above the slot it asked for, so the
    // report holds the events it was decided without. Absorbing here rather
    // than at each call site means the rest of this phase's writes (which read
    // the same array to build their own snapshot) ask for a slot above them,
    // and the replay that resumes from this log sees them without a reload.
    const report = absorbSkippedSlotReport(log.events, result);
    reportedEvents += report.added;
    if (report.truncated) {
      runtimeLogger.debug('Dropped a truncated skipped-slot report', {
        workflowRunId: runId,
        eventType: data.eventType,
        eventId: result.event?.eventId,
        offered: report.offered,
      });
    } else if (report.added > 0) {
      runtimeLogger.debug('Suspension write skipped occupied slots', {
        workflowRunId: runId,
        eventType: data.eventType,
        eventId: result.event?.eventId,
        reported: report.added,
      });
    }
    return result;
  };
  // Separate queue items by type
  const stepItems = suspension.items.filter(
    (item): item is StepInvocationQueueItem => item.type === 'step'
  );
  const allHookItems = suspension.items.filter(
    (item): item is HookInvocationQueueItem => item.type === 'hook'
  );
  const waitItems = suspension.items.filter(
    (item): item is WaitInvocationQueueItem => item.type === 'wait'
  );
  const attributeItems = suspension.items.filter(
    (item): item is AttributeInvocationQueueItem => item.type === 'attribute'
  );

  const hooksNeedingCreation = allHookItems.filter(
    (item) => !item.hasCreatedEvent
  );

  // Group hook items that need work by token, preserving queue-insertion
  // (workflow code) order within each token. Operations on one token must
  // apply in code order: a dispose() of an earlier hook releases the token
  // before a later same-token hook's creation is validated (otherwise the
  // new hook records a spurious hook_conflict against the run's own
  // disposed hook), while a hook created and disposed within the same
  // suspension is still created before it is disposed. Different tokens
  // have no claim interaction, so token groups are processed in parallel.
  const hookItemsByToken = new Map<string, HookInvocationQueueItem[]>();
  for (const item of allHookItems) {
    if (item.hasCreatedEvent && !item.disposed) {
      continue; // already committed and still live: nothing to do
    }
    const group = hookItemsByToken.get(item.token);
    if (group) {
      group.push(item);
    } else {
      hookItemsByToken.set(item.token, [item]);
    }
  }

  // Resolve encryption key for this run
  const rawKey = await world.getEncryptionKeyForRun?.(run);
  const encryptionKey = rawKey ? await importKey(rawKey) : undefined;

  // Gate payload compression on the run's specVersion.
  const compression =
    (run.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_COMPRESSION;

  let serializationBlockerCount = 0;
  const serializationBlockers: SuspensionSerializationBlocker[] = [];
  async function dehydrateInput(
    value: unknown,
    context: Pick<SuspensionSerializationBlocker, 'source' | 'correlationId'>
  ): Promise<SerializedData> {
    const stats: GuestCodeStats = { executions: [] };
    try {
      return (await dehydrateStepArguments(
        value,
        runId,
        encryptionKey,
        suspension.globalThis,
        false,
        compression,
        stats
      )) as SerializedData;
    } finally {
      serializationBlockerCount +=
        stats.totalExecutions ?? stats.executions.length;
      serializationBlockers.push(
        ...stats.executions
          .slice(
            0,
            GUEST_CODE_EXECUTION_SAMPLE_LIMIT - serializationBlockers.length
          )
          .map((execution) => ({ ...context, ...execution }))
      );
    }
  }

  async function disposeHook(
    queueItem: HookInvocationQueueItem
  ): Promise<void> {
    const hookDisposedEvent: CreateEventRequest = {
      eventType: 'hook_disposed' as const,
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: queueItem.correlationId,
      eventData: {
        token: queueItem.token,
      },
    };
    try {
      await createGuarded(hookDisposedEvent, { requestId });
    } catch (err) {
      if (EntityConflictError.is(err)) {
        // Hook was already disposed by a concurrent invocation, safe to skip
        runtimeLogger.info(
          'Hook already disposed, skipping duplicate disposal',
          {
            workflowRunId: runId,
            correlationId: queueItem.correlationId,
            message: err.message,
          }
        );
      } else if (RunExpiredError.is(err)) {
        runtimeLogger.info(
          'Workflow run already completed, skipping hook disposal',
          {
            workflowRunId: runId,
            correlationId: queueItem.correlationId,
            message: err.message,
          }
        );
      } else if (HookNotFoundError.is(err)) {
        // Hook may have already been disposed or never created
        runtimeLogger.info('Hook not found for disposal, continuing', {
          workflowRunId: runId,
          correlationId: queueItem.correlationId,
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // Hook outcomes, returned to the caller so it can advance the workflow over
  // a committed `hook_conflict` (or an awaited `hook_created`) in-process.
  const hookConflictCorrelationIds: string[] = [];
  const awaitedHookCorrelationIds: string[] = [];
  let hookCreationMs = 0;

  // Ask the hook create for the event-log delta since the cursor the caller's
  // log was read at. The hook's awaiters are settled by the event this write
  // commits and by nothing else — a `hook_created` for a clean registration,
  // a `hook_conflict` when the token was already claimed — so the caller can
  // continue the workflow in its own process on either outcome, but only over
  // a log that holds that event, and this write is the one request that can
  // hand it back together with anything another writer landed in the meantime.
  // Optional by contract: a World that ignores `sinceCursor` returns no delta
  // and the caller reads instead.
  //
  // Asked for on the single-hook suspension only. Two creates issued from one
  // snapshot each diff against the same cursor, and only the first delta back
  // can be folded in (the cursor moves with it), so the log would end up short
  // of the other's event with nothing to say so.
  const hookDeltaCursor =
    hooksNeedingCreation.length === 1 && typeof eventLog?.cursor === 'string'
      ? eventLog.cursor
      : undefined;

  const processHookGroup = async (
    items: HookInvocationQueueItem[]
  ): Promise<void> => {
    for (const queueItem of items) {
      let creationConflicted = false;

      if (!queueItem.hasCreatedEvent) {
        const hookMetadata =
          typeof queueItem.metadata === 'undefined'
            ? undefined
            : await dehydrateInput(queueItem.metadata, {
                source: 'hook_metadata',
                correlationId: queueItem.correlationId,
              });
        const hookEvent: CreateEventRequest = {
          eventType: 'hook_created' as const,
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: queueItem.correlationId,
          eventData: {
            token: queueItem.token,
            tokenRetentionUntil: queueItem.tokenRetentionUntil,
            metadata: hookMetadata,
            isWebhook: queueItem.isWebhook ?? false,
            ...(queueItem.isSystem && { isSystem: true }),
            ...(queueItem.force && { force: true }),
          },
        };
        const result = await createHookEvent({
          runId,
          hookEvent,
          queueItem,
          requestId,
          sinceCursor: hookDeltaCursor,
          createEvent: createGuarded,
          world,
          forceClaimVictimWakes,
        });
        if (result.hasHookConflict) {
          hookConflictCorrelationIds.push(queueItem.correlationId);
        }
        if (result.hasAwaitedHookCreation) {
          awaitedHookCorrelationIds.push(queueItem.correlationId);
        }
        creationConflicted = result.hasHookConflict;
      }

      // Dispose after creation for hooks born and disposed within this
      // batch. A hook whose creation conflicted was never created, so
      // there is nothing to dispose.
      if (queueItem.disposed && !creationConflicted) {
        await disposeHook(queueItem);
      }
    }
  };

  // Abort requests: resume the hook with the abort payload and write the
  // stream packet.
  const abortHook = async (queueItem: HookInvocationQueueItem) => {
    try {
      // Dehydrate the abort payload for storage
      const abortPayload = await dehydrateInput(
        {
          aborted: true,
          reason: queueItem.abortReason,
        },
        {
          source: 'hook_abort',
          correlationId: queueItem.correlationId,
        }
      );

      // Create hook_received event with abort payload
      await createGuarded({
        eventType: 'hook_received' as const,
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: queueItem.correlationId,
        eventData: {
          token: queueItem.token,
          payload: abortPayload,
        },
      });

      // Write stream cancellation packet for real-time step propagation.
      // Reuse the same dehydrated payload as the hook event so the reason
      // round-trips through `dehydrateStepArguments` / `hydrateStepArguments`
      // (handles DOMException, custom errors, encryption, etc.) instead of
      // bare JSON.stringify which loses type information and drops undefined.
      // streamName is set on the queue item at controller construction time
      // (see workflow/abort-controller.ts).
      try {
        const streamName = getAbortStreamIdFromToken(queueItem.token);
        await world.streams.write(
          runId,
          streamName,
          abortPayload as Uint8Array
        );
        await world.streams.close(runId, streamName);
      } catch {
        // Best-effort stream write: hook event provides the durable fallback
        runtimeLogger.debug(
          'Failed to write abort stream packet, hook event will provide fallback',
          {
            workflowRunId: runId,
            correlationId: queueItem.correlationId,
          }
        );
      }
    } catch (err) {
      if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
        runtimeLogger.info('Workflow run already completed, skipping abort', {
          workflowRunId: runId,
          correlationId: queueItem.correlationId,
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  };

  // Hook writes go out alongside this suspension's step, wait, and attribute
  // writes rather than ahead of them: they are one more op in the set settled
  // below. Within the hook writes themselves, token groups apply in code order
  // (see `hookItemsByToken`) and aborts follow the creations, so a hook created
  // and aborted in one suspension is created first.
  //
  // That includes forced creations. A forced creation publishes its victim's
  // wake before its token group's next write, but other groups and the step
  // writes are not held for it. They need not be: a crash before the wake is
  // repaid by the next replay from the forced `hook_created` itself, which
  // `forcedCreationsOwingWake` finds wherever it sits in the log, so no row
  // written after it can hide the debt.
  const hookGroups = [...hookItemsByToken.values()];
  const hooksNeedingAbort = allHookItems.filter(
    (item) => item.abortRequested && !item.disposed
  );
  // When the hook groups started and settled, for `hookCreationMs`.
  let hookGroupsWindow: { startMs: number; endMs?: number } | undefined;
  const hookOp =
    hookGroups.length > 0 || hooksNeedingAbort.length > 0
      ? (async () => {
          if (hookGroups.length > 0) {
            const window: { startMs: number; endMs?: number } = {
              startMs: Date.now(),
            };
            hookGroupsWindow = window;
            await settlePhase(hookGroups.map(processHookGroup));
            window.endMs = Date.now();
          }
          if (hooksNeedingAbort.length > 0) {
            await settlePhase(hooksNeedingAbort.map(abortHook));
          }
        })()
      : undefined;

  // Create step events for steps that don't have them yet.
  // Unlike V1, we do NOT queue step messages from here: the caller
  // decides which steps to execute inline vs. queue to background.
  // Wait events are also created in parallel below.
  const stepsNeedingCreation = new Set(
    stepItems
      .filter((queueItem) => !queueItem.hasCreatedEvent)
      .map((queueItem) => queueItem.correlationId)
  );

  // Correlation IDs for which THIS suspension call actually wrote the
  // step_created event. Populated by the ops below after a successful
  // events.create, used by the caller to claim ownership and avoid
  // racing with concurrent handlers on step execution.
  const createdStepCorrelationIds = new Set<string>();

  // Correlation IDs of steps finalized as failed because their arguments
  // refused to serialize: see finalizeUnserializableStep below.
  const failedStepCorrelationIds = new Set<string>();

  const ops: Promise<void>[] = [];
  // Already in flight (see `hookOp`); settled with everything else below.
  if (hookOp) ops.push(hookOp);

  // Steps and waits. The single-orchestrator runtime writes the steps and
  // waits of a live suspension itself (with their execution mode); what
  // reaches here is the end-of-run drain, which records fire-and-forget
  // steps and waits as created so the log shows them. They are never
  // enqueued or run, so they are marked background-mode.
  for (const queueItem of stepItems) {
    if (!stepsNeedingCreation.has(queueItem.correlationId)) continue;
    ops.push(
      (async () => {
        let dehydratedInput: SerializedData;
        try {
          dehydratedInput = await dehydrateInput(
            {
              args: queueItem.args,
              closureVars: queueItem.closureVars,
              thisVal: queueItem.thisVal,
            },
            {
              source: 'step_input',
              correlationId: queueItem.correlationId,
            }
          );
        } catch (err) {
          // The drain has nothing to observe a finalization, so an input
          // that does not serialize leaves no rows (the drain's own catch
          // swallows the error).
          throw err;
        }
        try {
          await createGuarded(
            {
              eventType: 'step_created' as const,
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: queueItem.correlationId,
              eventData: {
                stepName: queueItem.stepName,
                workflowName: run.workflowName,
                input: dehydratedInput,
                inline: false,
              },
            },
            { requestId }
          );
          createdStepCorrelationIds.add(queueItem.correlationId);
        } catch (err) {
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            runtimeLogger.info('Step not recorded by the drain, continuing', {
              workflowRunId: runId,
              correlationId: queueItem.correlationId,
              message: err.message,
            });
          } else {
            throw err;
          }
        }
      })()
    );
  }

  for (const queueItem of waitItems) {
    if (queueItem.hasCreatedEvent) continue;
    ops.push(
      (async () => {
        try {
          await createGuarded(
            {
              eventType: 'wait_created' as const,
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: queueItem.correlationId,
              eventData: { resumeAt: queueItem.resumeAt },
            },
            { requestId }
          );
        } catch (err) {
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            runtimeLogger.info('Wait not recorded by the drain, continuing', {
              workflowRunId: runId,
              correlationId: queueItem.correlationId,
              message: err.message,
            });
          } else {
            throw err;
          }
        }
      })()
    );
  }

  for (const queueItem of attributeItems) {
    ops.push(
      (async () => {
        try {
          // Guarded like every other suspension write: an attr_set is a
          // replay-derived event with a correlation id from this replay's
          // seeded sequence, so it must not land on a log the replay never
          // saw. Rejecting it is cheap: a run with attribute events already
          // forces an in-process replay, so the restart costs the replay it
          // was going to do anyway.
          await createGuarded(
            {
              eventType: 'attr_set',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: queueItem.correlationId,
              eventData: {
                changes: queueItem.changes,
                writer: { type: 'workflow' },
                ...(queueItem.allowReservedAttributes
                  ? { allowReservedAttributes: true }
                  : {}),
              },
            },
            { requestId }
          );
        } catch (err) {
          if (EntityConflictError.is(err)) {
            runtimeLogger.info(
              'Workflow attribute event already exists, continuing',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              }
            );
          } else if (isWorldValidationFailure(err)) {
            // Deterministic validation rejection from the World, e.g. the
            // cumulative per-run attribute cap, which only the World can
            // check against the run's existing attributes. Redelivering the
            // orchestrator message replays the workflow into the exact same
            // write and the exact same rejection, so retrying can never
            // succeed. Surface it as a FatalError so the caller fails the
            // run with a clear error instead of wedging it in redelivery.
            const fatal = new FatalError(
              `setAttributes failed World validation: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            fatal.cause = err;
            throw fatal;
          } else {
            throw err;
          }
        }
      })()
    );
  }

  // Await the step_created / wait_created event creates before returning.
  // The caller (workflowEntrypoint) only enqueues the step-dispatch queue
  // messages AFTER handleSuspension resolves, and the queue handler acks
  // the orchestrator message only after the caller resolves. So the step_created
  // events must be durable here, and the dispatch sends must complete in the caller,
  // all before ack. If the process crashes before this resolves, the orchestrator
  // message is not acked and VQS redelivers, re-creates the (idempotent)
  // step_created and re-dispatches, and recovers the run instead of orphaning it.
  const nonHookOpsSettled = Promise.allSettled(
    ops.filter((op) => op !== hookOp)
  ).then(() => Date.now());
  try {
    await settlePhase(ops);
  } finally {
    await owedVictimWakes;
  }

  // The hook writes' share of this suspension's wall time: only the stretch
  // they held it after every other write had settled, since until then the
  // suspension was waiting on those writes too.
  if (hookGroupsWindow?.endMs !== undefined) {
    const blockedFromMs = Math.max(
      hookGroupsWindow.startMs,
      await nonHookOpsSettled
    );
    hookCreationMs += Math.max(0, hookGroupsWindow.endMs - blockedFromMs);
  }

  // Rebuild the inline batch in deterministic order. `lazyInlineCorrelationIds`
  // is a Set seeded from the ordered first-N slice, so iterating it preserves
  // stepItems order; every id in it was set by the lazy branch above.
  const now = Date.now();
  let soonestWait:
    | { seconds: number; correlationId: string; resumeAtMs: number }
    | undefined;
  for (const queueItem of waitItems) {
    const resumeAtMs = queueItem.resumeAt.getTime();
    const delayMs = Math.max(1000, resumeAtMs - now);
    const timeoutSeconds = Math.ceil(delayMs / 1000);
    if (!soonestWait || timeoutSeconds < soonestWait.seconds) {
      soonestWait = {
        seconds: timeoutSeconds,
        correlationId: queueItem.correlationId,
        resumeAtMs,
      };
    }
  }

  span?.setAttributes({
    ...Attribute.WorkflowRunStatus('workflow_suspended'),
    ...Attribute.WorkflowStepsCreated(stepItems.length),
    ...Attribute.WorkflowHooksCreated(hooksNeedingCreation.length),
    ...Attribute.WorkflowWaitsCreated(waitItems.length),
    ...(failedStepCorrelationIds.size > 0
      ? Attribute.WorkflowStepsFailedSerialization(
          failedStepCorrelationIds.size
        )
      : {}),
  });

  return {
    pendingSteps: stepItems,
    createdStepCorrelationIds,
    failedStepCorrelationIds,
    // On hook conflict the caller advances the workflow over the conflict
    // before scheduling anything and never reads the wait timeout, so don't
    // report one. The next pass, which sees the conflict settled, reports it.
    waitTimeout:
      hookConflictCorrelationIds.length > 0 ? undefined : soonestWait,
    hasHookConflict: hookConflictCorrelationIds.length > 0,
    hookConflictCorrelationIds,
    hasAwaitedHookCreation: awaitedHookCorrelationIds.length > 0,
    awaitedHookCorrelationIds,
    // The delta accounts for the whole log only if the write that returned it
    // was this suspension's only one — any other write may have landed above
    // the delta and be missing from the caller's log.
    eventLogCarriedForward: deltaAbsorbed && eventWrites === 1,
    hasAttributeEvents: attributeItems.length > 0,
    hasHookEvents: hooksNeedingCreation.length > 0,
    hookCreationMs,
    serializationBlockerCount,
    serializationBlockers,
    reportedEventCount: reportedEvents,
  };
}

/**
 * Whether an `events.create` rejection is deterministic World validation
 * rather than a transient/storage error. Local Worlds
 * (world-local, world-postgres) throw `AttributeValidationError` directly;
 * remote Worlds surface the equivalent server-side rejection as a
 * `WorkflowWorldError` with HTTP status 400. The name check covers
 * `AttributeValidationError` instances from a different copy of
 * `@workflow/world` than the one this package resolved.
 */
function isWorldValidationFailure(err: unknown): boolean {
  if (err instanceof AttributeValidationError) return true;
  if (err instanceof Error && err.name === 'AttributeValidationError') {
    return true;
  }
  return WorkflowWorldError.is(err) && err.status === 400;
}
