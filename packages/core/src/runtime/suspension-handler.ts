import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  FatalError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  SerializationError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  AttributeValidationError,
  type CreateEventParams,
  type CreateEventRequest,
  type EventResult,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  type StartedStep,
  type TraceCarrier,
  type ValidQueueName,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { isRetryableWorldError } from '../classify-error.js';
import { importKey } from '../encryption.js';
import type {
  AttributeInvocationQueueItem,
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import { runtimeLogger } from '../logger.js';
import type { GuestCodeStats } from '../serialization/hardened.js';
import {
  dehydrateStepArguments,
  dehydrateStepError,
} from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getAbortStreamIdFromToken } from '../util.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import {
  getMaxInlineSteps,
  isBatchTransitionsEnabled,
  isResilientStepDispatchEnabled,
  MAX_BATCH_FANOUT_EVENTS,
  MAX_RESILIENT_STEP_INPUT_BYTES,
} from './constants.js';
import {
  absorbSkippedSlotReport,
  type EventCreator,
  type LoadedEventLog,
  maxEventSlot,
  queueMessage,
  slotSnapshotParams,
  stepDispatchIdempotencyKey,
} from './helpers.js';
import { ReplayRecoveryReporter } from './replay-recovery-reporter.js';
import type { PreclaimedInlineStart } from './step-executor.js';
import { unserializableStepInputPlaceholder } from './unserializable-step.js';

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
   */
  eventLog?: LoadedEventLog;
  /**
   * Turbo mode only: a promise that resolves once the backgrounded
   * `run_started` has landed (the run exists). When present, every world write
   * this suspension performs (`hook_created`, `wait_created`, eager overflow
   * `step_created`, …) is gated on it so the write never races ahead of the
   * run's creation. The pure inline hot path defers all of its steps and writes
   * nothing here, so it never awaits this barrier. `undefined` outside turbo,
   * where `run_started` was already awaited up front.
   */
  runReadyBarrier?: Promise<unknown>;
  /** One-shot telemetry reporter, activated only after replay has recovered. */
  replayRecoveryReporter?: ReplayRecoveryReporter;
  /**
   * Resilient step dispatch: when provided (and the per-step eligibility gates
   * pass, see the step ops below), each newly created non-inline step's
   * `step_created` write is parallelized with its step-execution queue
   * publish, and the queue message carries the serialized step input
   * (`stepInput`) so the consumer can idempotently re-ensure the event if the
   * direct write failed transiently. Steps queued this way are reported in
   * {@link SuspensionHandlerResult.queuedStepCorrelationIds} so the caller
   * skips them in its own dispatch pass. Omitted by callers that must not
   * queue (terminal drain, tests); creates then behave exactly as before.
   */
  stepDispatch?: {
    /** The unified workflow queue this run's step messages are published to. */
    queueName: ValidQueueName;
    /**
     * Lazily resolves the trace carrier to stamp on the step messages.
     * Called at most once per suspension (memoized here).
     */
    getTraceCarrier: () => Promise<TraceCarrier>;
  };
  /**
   * Inline step ownership: the queue message ID of the invocation this
   * suspension runs in (the queue handler's meta). When present AND the
   * batched fan-out engages, the lazy-inline steps' deferred writes are
   * folded into the batch as `step_created` + `step_started` pairs (the
   * started row stamped with this ID, exactly like the lazy claim it
   * replaces), pre-claiming the steps the caller is about to run inline. See
   * {@link SuspensionHandlerResult.inlineClaims}. Callers that never
   * inline-execute (terminal drain) omit it, keeping their lazy steps on the
   * plain deferred path.
   */
  ownerMessageId?: string;
  /**
   * Lets the batched fan-out return before every chunk has committed: only
   * the chunk carrying the pre-claimed inline pairs gates the handler's
   * return (its claims are what the caller starts bodies from), while the
   * trailing chunks' commits (and every chunk's in-flush step-message
   * publishes) ride {@link SuspensionHandlerResult.deferredBatchWork}. A
   * caller that opts in MUST await that promise before acking its delivery:
   * the durability contract ("every create durable before ack") moves from
   * the handler's return to that join, and nothing else re-drives a lost
   * trailing chunk. Callers that don't opt in (terminal drain, default)
   * keep the everything-durable-at-return behavior.
   */
  allowDeferredBatchWork?: boolean;
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
   * Correlation IDs of steps this suspension call already published
   * step-execution queue messages for, via resilient step dispatch (the
   * `step_created` write parallelized with a `stepInput`-carrying queue
   * publish). The caller MUST NOT dispatch these again: the message is
   * already out (a duplicate would be deduped by its idempotency key, but
   * costs a wasted round-trip). Empty when {@link SuspensionHandlerParams.stepDispatch}
   * was not provided or no step was eligible.
   */
  queuedStepCorrelationIds: Set<string>;
  /**
   * How many events this phase's writes reported back as occupying slots they
   * skipped over, already merged into the caller's `eventLog.events`. Nonzero
   * means the array was reordered to restore slot order, so any index the
   * caller cached into it (payload prewarm scan position) is stale.
   */
  reportedEventCount: number;
  /**
   * The steps whose `step_created` writes were intentionally deferred so the
   * caller can run them inline via lazy `step_started` events (which create
   * the step on the fly), saving one world round-trip per inline step. Up to
   * `getMaxInlineSteps()` steps are deferred; the caller runs them inline in
   * parallel and queues the rest. Empty when no step was deferred (nothing
   * pending, or a `hook.getConflict()` awaiter is present so nothing is
   * executed inline). The caller passes each `dehydratedInput` straight to
   * `executeStep`, which sends it as the `step_started` payload. The atomic
   * create-claim inside each `step_started` is the exactly-one-owner gate that
   * the standalone `step_created` provided before: the loser of the race gets
   * `EntityConflictError` → `skipped` and does not run the body.
   */
  lazyInlineSteps: Array<{
    correlationId: string;
    stepName: string;
    dehydratedInput: SerializedData;
  }>;
  /**
   * Pre-claimed inline starts, by correlation id: the per-step verdicts of
   * the `step_created` + `step_started` pairs the batched fan-out committed
   * for the lazy-inline steps. A step with an entry here is passed to
   * `executeStep` as `preclaimedStart` INSTEAD of `lazyStepInput`: its
   * input already rode the pair, and the claim is settled: `owned: true`
   * carries the started attempt-1 entity (input re-attached) so the body
   * runs straight off the batch commit with no start write of its own;
   * `owned: false` lost the pair's atomic create-claim to a concurrent
   * writer, and executeStep returns `skipped` without running the body,
   * the same outcome as losing the lazy claim. Empty whenever the fold did
   * not engage (batching off, no `ownerMessageId`, or the lone-inline case,
   * which keeps the optimistic lazy path and its claim/body overlap).
   *
   * Crash window: the pair commits before the caller runs the body, so a
   * crash between them leaves a started step stamped with this message's
   * ID. Redelivery of the same message re-executes it via the owned-recovery
   * path, the exact machinery the lazy claim's crash window already uses.
   */
  inlineClaims: Map<string, PreclaimedInlineStart>;
  /**
   * The highest slot the batched fan-out committed, when it ran. The batch's
   * own events are not in the caller's loaded log (the next reload picks
   * them up), so the caller folds this ceiling into the slot snapshot it
   * hands the inline executions; otherwise every inline terminal write
   * would name a pre-batch position and be answered with a skipped-slot
   * report echoing the events this suspension just wrote. Under
   * {@link SuspensionHandlerParams.allowDeferredBatchWork} this covers the
   * chunks that had committed by the handler's return (always the pair
   * chunk); a trailing chunk that commits later is echoed back on the
   * terminal writes like any foreign event: reports the executor reads for
   * position and discards.
   *
   * So the echo is only fully suppressed for a SINGLE-chunk fold. On a
   * multi-chunk fan-out the bodies start off the pair chunk while trailing
   * chunks are still in flight, and an inline terminal write issued in that
   * window still names a position below them and still draws a report for
   * their events. Bounded (trailing chunks only, large fan-outs only) and
   * self-correcting on the next reload, and recorded so a report seen there
   * reads as expected rather than as a bug.
   */
  batchCommittedSlotCeiling?: number;
  /**
   * The batched fan-out's deferred work, present only when the caller opted
   * in via {@link SuspensionHandlerParams.allowDeferredBatchWork} and
   * trailing work exists: the commits of every chunk except the pair chunk,
   * plus every chunk's step-message publishes (each chained on ITS OWN
   * chunk's commit, so publish-after-create holds per step). The caller
   * MUST await it before acking: a rejection here is a failed suspension
   * write and fails the delivery exactly as it would have at the handler's
   * return. Steps whose messages this work publishes are already in
   * {@link queuedStepCorrelationIds} at return time.
   */
  deferredBatchWork?: Promise<void>;
  /**
   * The soonest pending wait, if any: seconds until it elapses and the
   * correlationId of the wait that produced that timeout. The
   * correlationId seeds the idempotency key for the wait-continuation
   * queue message so that repeated suspension passes over the same
   * pending wait collapse into a single delayed continuation.
   */
  waitTimeout?: { seconds: number; correlationId: string };
  /** Whether a hook conflict was detected (should re-invoke immediately) */
  hasHookConflict: boolean;
  /** Whether a `hook.getConflict()` awaiter needs the workflow to continue immediately */
  hasAwaitedHookCreation: boolean;
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
   * Wall-clock ms spent committing this suspension's `hook_created` events
   * (0 when it created none). The caller accumulates this across iterations
   * and subtracts it from the TTFS latency measurement, so time spent
   * durably creating the user's hooks doesn't count as runtime overhead.
   */
  hookCreationMs: number;
  /** Whether serializing new step and hook data was passive. */
  serializationWasPassive: boolean;
}

async function createHookEvent({
  runId,
  hookEvent,
  queueItem,
  requestId,
  createEvent,
}: {
  runId: string;
  hookEvent: CreateEventRequest;
  queueItem: HookInvocationQueueItem;
  requestId?: string;
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
    });

    // Check if the world returned a hook_conflict event instead of hook_created.
    // The hook_conflict event is stored in the event log and will be replayed
    // on the next workflow invocation, causing the hook's promise to reject.
    if (result.event?.eventType === 'hook_conflict') {
      return {
        hasHookConflict: true,
        hasAwaitedHookCreation: false,
      };
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
 * Processing order:
 * 1. Hooks are processed first to prevent race conditions with webhook receivers
 * 2. Step events and wait events are created in parallel
 */
export async function handleSuspension({
  suspension,
  world,
  run,
  span,
  requestId,
  eventLog,
  runReadyBarrier,
  replayRecoveryReporter,
  stepDispatch,
  ownerMessageId,
  allowDeferredBatchWork,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  const runId = run.runId;

  // Turbo mode: hold every world write below until the backgrounded
  // `run_started` has *settled*, so we never write a step/hook/wait event for a
  // run that does not exist yet. A no-op outside turbo (barrier undefined) and
  // on the pure inline hot path, which defers all steps and writes nothing.
  // Awaiting the same (usually already-settled) promise more than once is cheap.
  // A barrier rejection is swallowed for ordering only: if `run_started` truly
  // failed the run does not exist, so the subsequent write surfaces the real
  // error (run not found / gone) and the message redelivers.
  const ensureRunReady = async (): Promise<void> => {
    if (runReadyBarrier) {
      try {
        await runReadyBarrier;
      } catch {
        // intentional: ordering barrier only, see above.
      }
    }
  };

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
      world.events.create(runId, data, p)
    );
  // Adds the optimistic-concurrency guard when the caller supplied a loaded
  // event log; without one it creates directly (callers with no replay
  // snapshot, e.g. tests). A stale (412) rejection propagates to the caller,
  // which restarts the replay from a corrected log. It is not retried here,
  // because the event's correlation id was minted by *this* replay's seeded
  // sequence, so re-committing it against a corrected log would persist an
  // event no correct replay produces.
  let reportedEvents = 0;
  const createGuarded: EventCreator = async (data, params) => {
    if (!eventLog) {
      return createEvent(data, params);
    }
    const log = eventLog;
    const result = await createEvent(data, {
      ...params,
      ...slotSnapshotParams(log.events),
    });
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
  const stepItems = suspension.steps.filter(
    (item): item is StepInvocationQueueItem => item.type === 'step'
  );
  const allHookItems = suspension.steps.filter(
    (item): item is HookInvocationQueueItem => item.type === 'hook'
  );
  const waitItems = suspension.steps.filter(
    (item): item is WaitInvocationQueueItem => item.type === 'wait'
  );
  const attributeItems = suspension.steps.filter(
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

  let serializationWasPassive = true;
  async function dehydrateInput(value: unknown): Promise<SerializedData> {
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
      if (stats.executions.length > 0) serializationWasPassive = false;
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

  // Process hooks first to prevent race conditions with webhook receivers.
  // Track any hook conflicts that occur: these are returned to the caller
  // so the V2 handler can re-invoke immediately.
  let hasHookConflict = false;
  let hasAwaitedHookCreation = false;
  let hookCreationMs = 0;

  if (hookItemsByToken.size > 0) {
    const hookPhaseStart = Date.now();
    await ensureRunReady();
    await settlePhase(
      [...hookItemsByToken.values()].map(async (items) => {
        for (const queueItem of items) {
          let creationConflicted = false;

          if (!queueItem.hasCreatedEvent) {
            const hookMetadata =
              typeof queueItem.metadata === 'undefined'
                ? undefined
                : await dehydrateInput(queueItem.metadata);
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
              },
            };
            const result = await createHookEvent({
              runId,
              hookEvent,
              queueItem,
              requestId,
              createEvent: createGuarded,
            });
            hasHookConflict ||= result.hasHookConflict;
            hasAwaitedHookCreation ||= result.hasAwaitedHookCreation;
            creationConflicted = result.hasHookConflict;
          }

          // Dispose after creation for hooks born and disposed within this
          // batch. A hook whose creation conflicted was never created, so
          // there is nothing to dispose.
          if (queueItem.disposed && !creationConflicted) {
            await disposeHook(queueItem);
          }
        }
      })
    );
    hookCreationMs = Date.now() - hookPhaseStart;
  }

  // Process abort requests: resume the hook with abort payload and write stream packet
  const hooksNeedingAbort = allHookItems.filter(
    (item) => item.abortRequested && !item.disposed
  );

  if (hooksNeedingAbort.length > 0) {
    await ensureRunReady();
    await settlePhase(
      hooksNeedingAbort.map(async (queueItem) => {
        try {
          // Dehydrate the abort payload for storage
          const abortPayload = await dehydrateInput({
            aborted: true,
            reason: queueItem.abortReason,
          });

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
            runtimeLogger.info(
              'Workflow run already completed, skipping abort',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              }
            );
          } else {
            throw err;
          }
        }
      })
    );
  }

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

  /**
   * A step whose arguments fail to serialize is deterministic: every replay
   * re-derives the same unserializable value, so redelivering the
   * orchestrator message can never succeed. Instead of rejecting the whole
   * suspension (which fails the run from the outside, where no user code can
   * observe it), treat it exactly like a step-body failure: write
   * `step_created` with a placeholder input (every World requires the step
   * entity to exist before a terminal step event, and the real input is
   * precisely what refused to serialize) followed by `step_failed` carrying
   * the SerializationError. The next replay rejects the step's promise with
   * it, so a try/catch around the step call observes the error; uncaught, it
   * propagates out of the workflow body and fails the run as a USER_ERROR,
   * without burning queue redeliveries either way.
   */
  const finalizeUnserializableStep = async (
    queueItem: StepInvocationQueueItem,
    error: SerializationError
  ): Promise<void> => {
    runtimeLogger.warn(
      'Step arguments failed to serialize; failing the step so the ' +
        'workflow can observe the error',
      {
        workflowRunId: runId,
        correlationId: queueItem.correlationId,
        stepName: queueItem.stepName,
        error: error.message,
      }
    );
    await ensureRunReady();
    // Marker placeholder (not empty args): byte-identical-to-zero-args would
    // make `workflow inspect steps` show "no arguments" for the one step
    // whose entire problem was its arguments.
    const placeholderInput = (await dehydrateStepArguments(
      unserializableStepInputPlaceholder(),
      runId,
      encryptionKey,
      suspension.globalThis,
      false,
      compression
    )) as SerializedData;
    try {
      await createGuarded(
        {
          eventType: 'step_created' as const,
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: queueItem.correlationId,
          eventData: {
            stepName: queueItem.stepName,
            workflowName: run.workflowName,
            input: placeholderInput,
          },
        },
        { requestId }
      );
    } catch (createErr) {
      if (EntityConflictError.is(createErr)) {
        // A concurrent handler already created the step: the failure is
        // deterministic, so it is racing toward the same step_failed below.
        runtimeLogger.info('Step already exists, continuing', {
          workflowRunId: runId,
          correlationId: queueItem.correlationId,
          message: createErr.message,
        });
      } else if (RunExpiredError.is(createErr)) {
        // Run already finished: nothing to observe the failure.
        return;
      } else {
        throw createErr;
      }
    }
    try {
      await createGuarded(
        {
          eventType: 'step_failed' as const,
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: queueItem.correlationId,
          eventData: {
            stepName: queueItem.stepName,
            // The error itself is a plain WorkflowError (name, message with
            // framed hint, cause chain), serializable even though the step
            // input was not. Error detection is realm-independent
            // (types.isNativeError), so the host-created error serializes
            // the same under either global; the VM global is passed for
            // consistency with every other dehydration in this file and so
            // any VM-realm values guest code threw into the cause chain
            // (getters/proxies executed during the failed dehydration) are
            // detected by the realm-sensitive reducers.
            error: await dehydrateStepError(
              error,
              runId,
              encryptionKey,
              [],
              suspension.globalThis,
              compression
            ),
          },
        },
        { requestId }
      );
    } catch (failErr) {
      if (EntityConflictError.is(failErr) || RunExpiredError.is(failErr)) {
        // Step already terminal (a concurrent handler wrote the same
        // deterministic failure) or the run already finished.
        runtimeLogger.info(
          'Tried failing step, but step or run has already finished.',
          {
            workflowRunId: runId,
            correlationId: queueItem.correlationId,
            message: failErr.message,
          }
        );
      } else {
        throw failErr;
      }
    }
    failedStepCorrelationIds.add(queueItem.correlationId);
    // Release the inline slot bookkeeping: the step never runs, so it must
    // not appear in the rebuilt `lazyInlineSteps`. (Its slot in the first-N
    // selection and in `inlinePairFoldEligible`'s arithmetic was consumed
    // before dehydration could reveal the failure, inherent to selecting
    // before serializing, and bounded to one wasted slot on a pass that
    // ends in a forced replay anyway.)
    lazyInlineCorrelationIds.delete(queueItem.correlationId);
  };

  // Lazy inline start: defer the step_created write for up to
  // `getMaxInlineSteps()` steps the caller will run inline (in parallel). Each
  // step is created on the fly by the lazy `step_started` executeStep sends
  // (saving a round-trip per step). We never defer when a `hook.getConflict()`
  // awaiter is present, because in that case the caller executes nothing inline
  // (it re-invokes immediately to resolve the awaiter), so deferring would
  // leave the steps uncreated and unqueued. We pick the first N uncreated
  // steps (matching the caller's inline-candidate selection) and dehydrate
  // their input here so executeStep can ship it as the step_started payload.
  const lazyInlineCorrelationIds = new Set<string>(
    hasAwaitedHookCreation === false
      ? stepItems
          .filter((item) => stepsNeedingCreation.has(item.correlationId))
          .slice(0, getMaxInlineSteps())
          .map((item) => item.correlationId)
      : []
  );
  // Collected by correlationId because the per-step ops below run concurrently
  // and settle out of order. We rebuild the array in deterministic
  // `lazyInlineCorrelationIds` order (the ordered slice above) after the ops
  // settle, so the inline batch order is stable regardless of dehydration timing.
  const lazyInlineByCorrelationId = new Map<
    string,
    SuspensionHandlerResult['lazyInlineSteps'][number]
  >();

  const ops: Promise<void>[] = [];

  // Correlation IDs of steps whose step-execution queue message was already
  // published by the resilient-dispatch ops below (alongside the step_created
  // write). Reported to the caller so its dispatch pass skips them.
  const queuedStepCorrelationIds = new Set<string>();

  // Resilient step dispatch eligibility, shared by every step op below (the
  // per-step input-size check is applied inside the op). All must hold:
  //
  //  - The caller provided a dispatch target (`stepDispatch`): terminal
  //    drains and other create-only callers never queue.
  //  - The feature is enabled (`WORKFLOW_RESILIENT_STEP_DISPATCH` opt-in).
  //    It is off by default because the publish races the create's verdict,
  //    and a create can come back refused: as a duplicate the replay should
  //    stop pursuing, or (on a World that would rather refuse a stale write
  //    than report what it missed) as a 412. Either way the queue message
  //    carrying the payload is already out, and the consumer can materialize a
  //    step whose create was refused. Nothing orders that verdict before the
  //    consumer's redelivery re-ensure, so no backend-side revocation
  //    bookkeeping can close the window: a best-effort marker that fails open
  //    cannot carry a correctness property. The sequential path is the only
  //    thing that gives the message a happens-after edge over the verdict.
  //  - The run's queue transport preserves binary payloads (CBOR,
  //    specVersion >= 3): `stepInput.input` is the serialized (possibly
  //    encrypted) input bytes, which the JSON transport would mangle.
  const resilientDispatchEligible =
    stepDispatch !== undefined &&
    isResilientStepDispatchEnabled() &&
    (run.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT;

  // Batched fan-out: fold this suspension's step_created + wait_created
  // writes into one `events.createBatch` call (one durable write, per-event
  // outcomes) instead of one write per event. Engages only for a CLEAN
  // fan-out (no attribute writes, no hook writes, no resilient dispatch
  // whose creates are each paired with a queue publish) on a World that
  // implements the optional method and a run whose events are slot-numbered.
  // Everything outside the gate keeps the single-event path byte-for-byte.
  const batchFanoutEligible =
    isBatchTransitionsEnabled() &&
    typeof world.events.createBatch === 'function' &&
    (run.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_SLOT_IDENTITY &&
    !resilientDispatchEligible &&
    allHookItems.length === 0 &&
    attributeItems.length === 0;
  /**
   * The fold's collection, in scheduling order (steps in stepItems order,
   * then waits). Step entries are enqueued by their prep promises (input
   * dehydration runs concurrently, so entries are ordered by `order`, not by
   * completion); the single flush op below awaits every prep, sorts, and
   * commits the whole set through `createBatch`.
   */
  const batchQueue: {
    order: number;
    kind: 'step' | 'wait' | 'inline-created' | 'inline-started';
    correlationId: string;
    /** The step's name, set on step-carrying kinds (the in-flush publishes
     *  and the dispatch idempotency key need it). */
    stepName?: string;
    event: CreateEventRequest;
  }[] = [];
  const batchPreps: Promise<void>[] = [];

  // Pre-claimed inline pairs: fold each lazy-inline step's deferred
  // `step_created` (carrying its input) AND its `step_started` claim (bare,
  // ownership-stamped) into the batch, so the whole fan-out (the inline
  // steps' claims included) commits in the one durable write and the caller
  // starts the bodies straight off that commit instead of posting one claim
  // per inline step. The lone-inline case (nothing else to batch with) is
  // excluded: a pair-only batch costs the same round trip as the single lazy
  // claim while giving up the optimistic claim/body overlap and the
  // bump-and-report that `createGuarded` provides, so it stays on the lazy
  // path. Requires the caller's `ownerMessageId`: the started row must
  // stamp ownership exactly like the lazy claim it replaces (and a caller
  // that does not inline-execute never provides one).
  const uncreatedWaitCount = waitItems.filter(
    (item) => !item.hasCreatedEvent
  ).length;
  const inlinePairFoldEligible =
    batchFanoutEligible &&
    ownerMessageId !== undefined &&
    lazyInlineCorrelationIds.size > 0 &&
    (lazyInlineCorrelationIds.size >= 2 ||
      stepsNeedingCreation.size -
        lazyInlineCorrelationIds.size +
        uncreatedWaitCount >=
        1);
  const inlineClaims: SuspensionHandlerResult['inlineClaims'] = new Map();
  let batchCommittedSlotCeiling: number | undefined;

  // The trace carrier for resilient step dispatches, resolved at most once per
  // suspension (the per-step ops run concurrently and share it).
  let stepDispatchTraceCarrier: Promise<TraceCarrier> | undefined;
  const getStepDispatchTraceCarrier = (): Promise<TraceCarrier> => {
    stepDispatchTraceCarrier ??=
      stepDispatch?.getTraceCarrier() ?? Promise.resolve({});
    return stepDispatchTraceCarrier;
  };

  // Producer-side resilient recovery count for the suspension span attribute.
  let resilientDispatchRecovered = 0;

  // Steps: create step_created events (no queuing, V2 returns pending steps
  // to caller, EXCEPT on the resilient dispatch path, which parallelizes the
  // create with the step's queue publish and reports it in
  // `queuedStepCorrelationIds`).
  let batchOrderCounter = 0;
  for (const queueItem of stepItems) {
    if (stepsNeedingCreation.has(queueItem.correlationId)) {
      // Deterministic position in the batched fold (assigned in stepItems
      // order, before the concurrent dehydration runs). A pair-folded inline
      // step occupies two consecutive positions (created row then started
      // row), which the flush keeps adjacent and never splits across chunks,
      // so a World can fold them into one born-running create.
      const pairFolded =
        inlinePairFoldEligible &&
        lazyInlineCorrelationIds.has(queueItem.correlationId);
      const stepOrder = batchOrderCounter;
      batchOrderCounter += pairFolded ? 2 : 1;
      const stepOp = (async () => {
        let dehydratedInput: SerializedData;
        try {
          dehydratedInput = await dehydrateInput({
            args: queueItem.args,
            closureVars: queueItem.closureVars,
            thisVal: queueItem.thisVal,
          });
        } catch (err) {
          if (!SerializationError.is(err)) {
            // e.g. RuntimeDecryptionError: an SDK fault, not a user value
            // problem. Keep its identity (RUNTIME_ERROR) and current
            // fail-the-suspension behavior.
            throw err;
          }
          if (!stepDispatch) {
            // No dispatch target means no replay will observe a
            // finalization: this is the terminal drain (or a create-only
            // test caller). The run is already completing/failing, so
            // writing step_created + step_failed here would leave e.g. a
            // COMPLETED run carrying a failed step nothing can ever
            // observe, reading as a bug from the dashboard. Rethrow
            // instead; the drain's own catch swallows it, preserving its
            // pre-existing behavior (no rows for the unawaited step).
            throw err;
          }
          await finalizeUnserializableStep(queueItem, err);
          return;
        }
        // Deferred (lazy) inline step: skip the step_created write — the
        // caller's inline executeStep will send a lazy step_started carrying
        // this input, and the world creates the step (entity + synthetic
        // step_created event) atomically. We do NOT add it to
        // createdStepCorrelationIds; ownership is decided by that lazy
        // step_started's atomic create-claim instead.
        if (lazyInlineCorrelationIds.has(queueItem.correlationId)) {
          lazyInlineByCorrelationId.set(queueItem.correlationId, {
            correlationId: queueItem.correlationId,
            stepName: queueItem.stepName,
            dehydratedInput,
          });
          if (pairFolded) {
            // Enqueue the pair the deferral would otherwise leave to the
            // caller's lazy `step_started`: the created row carries the
            // input (payloads ride creates in a batch), the started row is
            // bare and stamps this invocation's ownership, the same claim
            // shape the lazy start would have sent, settled by the batch.
            batchQueue.push({
              order: stepOrder,
              kind: 'inline-created',
              correlationId: queueItem.correlationId,
              event: {
                eventType: 'step_created',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: queueItem.correlationId,
                eventData: {
                  stepName: queueItem.stepName,
                  workflowName: run.workflowName,
                  input: dehydratedInput as SerializedData,
                },
              },
            });
            batchQueue.push({
              order: stepOrder + 1,
              kind: 'inline-started',
              correlationId: queueItem.correlationId,
              event: {
                eventType: 'step_started',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: queueItem.correlationId,
                eventData: {
                  stepName: queueItem.stepName,
                  // Checked by inlinePairFoldEligible; spread keeps the
                  // narrow-through-closure problem away from the type.
                  ...(ownerMessageId !== undefined ? { ownerMessageId } : {}),
                },
              },
            });
          }
          return;
        }
        const stepEvent: CreateEventRequest = {
          eventType: 'step_created' as const,
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: queueItem.correlationId,
          eventData: {
            stepName: queueItem.stepName,
            workflowName: run.workflowName,
            input: dehydratedInput as SerializedData,
          },
        };

        // Resilient step dispatch: fire the step_created write and the
        // step-execution queue publish in parallel: the message carries the
        // same serialized input (`stepInput`) so the consumer can
        // idempotently re-ensure the event if the direct write failed
        // transiently. Mirrors the resilient start (`runInput`) and
        // resilient hook resume (`hookInput`) patterns. Only for inputs the
        // queue message can safely carry (binary, under the VQS size cap).
        if (
          resilientDispatchEligible &&
          dehydratedInput instanceof Uint8Array &&
          dehydratedInput.byteLength <= MAX_RESILIENT_STEP_INPUT_BYTES
        ) {
          await ensureRunReady();
          const traceCarrier = await getStepDispatchTraceCarrier();
          const [createResult, queueResult] = await Promise.allSettled([
            createGuarded(stepEvent, { requestId }),
            queueMessage(
              world,
              // biome-ignore lint/style/noNonNullAssertion: implied by resilientDispatchEligible
              stepDispatch!.queueName,
              {
                runId,
                stepId: queueItem.correlationId,
                stepName: queueItem.stepName,
                traceCarrier,
                requestedAt: new Date(),
                stepInput: { input: dehydratedInput },
              },
              // Same key as the caller's dispatch pass and any concurrent
              // handler's, so redundant publishes for this step dedupe. The
              // key is step-identity-scoped so a revoked message for a
              // reassigned correlation id cannot absorb the corrected
              // schedule's dispatch: see stepDispatchIdempotencyKey.
              {
                idempotencyKey: stepDispatchIdempotencyKey(
                  queueItem.correlationId,
                  queueItem.stepName
                ),
              }
            ),
          ]);
          // Queue failure is always fatal for this suspension pass: without
          // the message the step would rely on the create alone, and if the
          // create ALSO failed there would be no durable record at all.
          // Propagating redelivers the orchestrator message, which
          // re-creates the (idempotent) step_created and re-dispatches,
          // the same recovery as the sequential path.
          if (queueResult.status === 'rejected') {
            throw queueResult.reason;
          }
          queuedStepCorrelationIds.add(queueItem.correlationId);
          if (createResult.status === 'rejected') {
            const err = createResult.reason;
            if (EntityConflictError.is(err)) {
              // Concurrent handler wrote it first, same as the sequential
              // path. The step message is already out; a duplicate publish
              // by that handler dedupes on the shared idempotency key.
              runtimeLogger.info('Step already exists, continuing', {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              });
            } else if (isRetryableWorldError(err)) {
              // Resilient: the write failed transiently (429 / 5xx /
              // transport) but the step message (carrying the same
              // serialized input) was published, so the consumer
              // idempotently re-ensures the step_created before executing.
              resilientDispatchRecovered++;
              runtimeLogger.warn(
                'Step creation event write failed, but the step was ' +
                  'dispatched via the queue. The step_created event will ' +
                  'be ensured by the queue consumer.',
                {
                  workflowRunId: runId,
                  correlationId: queueItem.correlationId,
                  stepName: queueItem.stepName,
                  error: err instanceof Error ? err.message : String(err),
                }
              );
            } else {
              throw err;
            }
          } else {
            createdStepCorrelationIds.add(queueItem.correlationId);
          }
          return;
        }

        if (batchFanoutEligible) {
          // Fold into the batch instead of writing here. The enclosing
          // promise joins `batchPreps` (see the loop below), so the flush
          // op cannot run before this step's input finished dehydrating.
          batchQueue.push({
            order: stepOrder,
            kind: 'step',
            correlationId: queueItem.correlationId,
            stepName: queueItem.stepName,
            event: stepEvent,
          });
          return;
        }

        try {
          await ensureRunReady();
          await createGuarded(stepEvent, { requestId });
          createdStepCorrelationIds.add(queueItem.correlationId);
        } catch (err) {
          if (EntityConflictError.is(err)) {
            runtimeLogger.info('Step already exists, continuing', {
              workflowRunId: runId,
              correlationId: queueItem.correlationId,
              message: err.message,
            });
          } else {
            throw err;
          }
        }
      })();
      ops.push(stepOp);
      if (batchFanoutEligible) {
        // The flush op waits for every prep before committing; a prep that
        // rejected already surfaces through `ops`, so the flush's own wait
        // swallows it and commits whatever was successfully enqueued,
        // preserving today's per-op independence.
        batchPreps.push(stepOp.catch(() => {}));
      }
    }
  }

  // Create wait events (same as V1)
  for (const queueItem of waitItems) {
    if (!queueItem.hasCreatedEvent) {
      const waitEvent: CreateEventRequest = {
        eventType: 'wait_created' as const,
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: queueItem.correlationId,
        eventData: {
          resumeAt: queueItem.resumeAt,
        },
      };
      if (batchFanoutEligible) {
        // Waits need no dehydration, so they enqueue synchronously, after
        // every step's order slot, preserving steps-then-waits scheduling
        // order in the log.
        batchQueue.push({
          order: batchOrderCounter++,
          kind: 'wait',
          correlationId: queueItem.correlationId,
          event: waitEvent,
        });
        continue;
      }
      ops.push(
        (async () => {
          try {
            await ensureRunReady();
            await createGuarded(waitEvent, { requestId });
          } catch (err) {
            if (EntityConflictError.is(err)) {
              runtimeLogger.info('Wait already exists, continuing', {
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
  }

  // The batched fold's flush: the clean fan-out commits through
  // `createBatch` in chunks of MAX_BATCH_FANOUT_EVENTS, all chunks IN
  // FLIGHT CONCURRENTLY. Slot assignment is the server's, so parallel
  // chunks race for slot ranges exactly like the pre-fold path's parallel
  // single writes did; entity conditions, not commit order, carry
  // correctness (sibling fan-out events have no cross-order the replay
  // depends on; it matches by correlation id). Each event reports the
  // outcome its own single create would have had: a 409 is the same
  // already-exists tolerance as the single path, anything else fails the
  // delivery the way a single-path rejection would.
  //
  // Latency shape: only the chunk carrying the pre-claimed inline pairs
  // gates the handler's return (the caller starts bodies off its claims).
  // Every other chunk's commit (and every chunk's step-message publishes,
  // which fire the moment ITS creates are durable) rides
  // `deferredBatchWork` when the caller opted in, joined before ack. A slow
  // sibling chunk therefore delays neither the inline bodies nor another
  // chunk's queue messages, while publish-after-create still holds per
  // step: a step's message is only ever sent after the chunk carrying its
  // create has committed.
  let deferredBatchWork: Promise<void> | undefined;
  if (batchFanoutEligible) {
    ops.push(
      (async () => {
        // Preps that rejected already surface through their own `ops`
        // entries; the fold commits whatever was successfully enqueued,
        // preserving today's per-op independence.
        await Promise.all(batchPreps);
        if (batchQueue.length === 0) {
          return;
        }
        const entries = [...batchQueue].sort((a, b) => a.order - b.order);
        await ensureRunReady();
        // A batch of ONE gains nothing over the single write (same round
        // trip) and loses the slot-snapshot params + bump-and-report that
        // createGuarded provides, so a lone eager event takes the ordinary
        // single path, with the same conflict tolerance and ownership
        // bookkeeping it would have had without the fold.
        if (entries.length === 1) {
          const [entry] = entries;
          try {
            await createGuarded(entry.event, { requestId });
            if (entry.kind === 'step') {
              createdStepCorrelationIds.add(entry.correlationId);
            }
          } catch (err) {
            if (EntityConflictError.is(err)) {
              runtimeLogger.info(
                entry.kind === 'step'
                  ? 'Step already exists, continuing'
                  : 'Wait already exists, continuing',
                {
                  workflowRunId: runId,
                  correlationId: entry.correlationId,
                  message: err.message,
                }
              );
            } else {
              throw err;
            }
          }
          return;
        }
        // Seed for the foreign-interleaving diagnostic below. With chunks
        // committing in parallel there is no per-chunk "expected next slot";
        // the whole fold's committed span is compared against the seed
        // once every chunk has settled: committed slots are dense per the
        // World's invariant, so any excess of (max committed slot − seed +
        // 1) over the fold's own committed count is events OTHER writers
        // landed in between.
        const expectedFirstSlot = eventLog
          ? (maxEventSlot(eventLog.events) ?? 0) + 1
          : undefined;
        // Pair-aware chunking: a pre-claimed pair's two rows must land in
        // the same createBatch call (adjacent, so a World can fold them
        // into one born-running create) and never straddle a chunk
        // boundary, which would turn the started row into a standalone
        // claim racing its own create's commit.
        const chunks: (typeof entries)[] = [];
        {
          let current: typeof entries = [];
          for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            const next = entries[index + 1];
            const pairLead =
              entry.kind === 'inline-created' &&
              next?.kind === 'inline-started' &&
              next.correlationId === entry.correlationId;
            const take = pairLead ? 2 : 1;
            if (
              current.length > 0 &&
              current.length + take > MAX_BATCH_FANOUT_EVENTS
            ) {
              chunks.push(current);
              current = [];
            }
            current.push(entry);
            if (pairLead) {
              current.push(next);
              index++;
            }
          }
          if (current.length > 0) chunks.push(current);
        }
        // Steps whose queue messages THIS FLUSH will publish (the eager
        // creates), recorded before any chunk settles so the caller's
        // dispatch pass (which runs off the handler's return) skips them.
        // The sends are guaranteed-or-failed by the trailing work the
        // caller joins before acking, so "will be published by this flush"
        // and "already published" are equivalent from the caller's side.
        const publishEagerSteps = stepDispatch !== undefined;
        if (publishEagerSteps) {
          for (const entry of entries) {
            if (entry.kind === 'step') {
              queuedStepCorrelationIds.add(entry.correlationId);
            }
          }
        }

        // Tallies for the foreign-interleaving diagnostic, folded across
        // the concurrent chunks and read once all of them settled.
        let committedCount = 0;
        let maxCommittedSlot: number | undefined;

        const commitChunk = async (chunk: typeof entries): Promise<void> => {
          // Anchors for the pre-claimed steps' telemetry: the POST instant
          // is the claim's "start POST sent" (RSFS's end), the return is the
          // claim's completion (TTR's T6), the same two instants the lazy
          // claim's own POST would have produced.
          const batchPostSentAtMs = Date.now();
          // biome-ignore lint/style/noNonNullAssertion: batchFanoutEligible implies presence
          const { results } = await world.events.createBatch!(
            runId,
            chunk.map((entry) => ({
              event: entry.event,
              // The started row is the step's executing claim, so it carries
              // the compute-instance attribution the single claim sends via
              // CreateEventParams.
              ...(entry.kind === 'inline-started'
                ? { computeInstanceId: COMPUTE_INSTANCE_ID }
                : {}),
            })),
            // Per-write request attribution, same as the single path's
            // createGuarded(…, { requestId }).
            { requestId }
          );
          const claimCompletedAtMs = Date.now();
          for (const [index, item] of results.entries()) {
            const entry = chunk[index];
            if (item.error === undefined) {
              if (entry.kind === 'step') {
                createdStepCorrelationIds.add(entry.correlationId);
              } else if (entry.kind === 'inline-started') {
                // The pair committed: this invocation owns the step and the
                // caller runs the body with no claim of its own. The
                // readback entity is authoritative where present; a World
                // that omitted it gets the same locally synthesized running
                // attempt-1 the optimistic path executes against. Either
                // way the input is re-attached locally: batch responses
                // return refs lazily, and the body's hydration wants the
                // exact bytes the pair's created row carried. (The created
                // row's success is deliberately NOT membership in
                // createdStepCorrelationIds: for inline steps ownership is
                // the started row's verdict, and the caller's dispatch pass
                // skips inline correlation ids regardless.)
                const dehydrated = lazyInlineByCorrelationId.get(
                  entry.correlationId
                );
                if (dehydrated === undefined) {
                  // Unreachable: the same prep op that enqueued the pair set
                  // this entry, and the flush awaited every prep above.
                  //
                  // Not free if it ever fires, though: the pair is already
                  // durable here, so this throws with the step claimed and
                  // its body never run. The delivery fails, and redelivery
                  // recovers it through owned-recovery (the step carries this
                  // message's ownership stamp) rather than the request just
                  // failing cleanly.
                  throw new WorkflowWorldError(
                    `no dehydrated input for pre-claimed step ${entry.correlationId}`,
                    { status: 500 }
                  );
                }
                const now = new Date();
                const startedStep: StartedStep = item.step?.startedAt
                  ? { ...item.step, startedAt: item.step.startedAt }
                  : {
                      runId,
                      stepId: entry.correlationId,
                      stepName: dehydrated.stepName,
                      status: 'running',
                      attempt: 1,
                      createdAt: now,
                      updatedAt: now,
                      startedAt: now,
                    };
                inlineClaims.set(entry.correlationId, {
                  owned: true,
                  step: {
                    ...startedStep,
                    input: dehydrated.dehydratedInput,
                  },
                  batchPostSentAtMs,
                  claimCompletedAtMs,
                });
              }
              continue;
            }
            if (item.status === 409) {
              if (
                entry.kind === 'inline-created' ||
                entry.kind === 'inline-started'
              ) {
                // The pair lost its atomic create-claim: a concurrent writer
                // already owns this step (an earlier delivery's create, or a
                // racing handler's claim). Recorded as a lost claim: the
                // caller's executeStep returns `skipped` without running the
                // body, the same outcome as losing the lazy claim. A World
                // that folds the pair reports the 409 on both rows (set
                // twice, harmless); one that evaluates rows independently
                // has the started row (processed second) decide, which is
                // exactly the single path's semantics (create lost + claim
                // won still runs the body; create won + claim lost skips).
                inlineClaims.set(entry.correlationId, { owned: false });
                runtimeLogger.info('Inline step pre-claim lost, continuing', {
                  workflowRunId: runId,
                  correlationId: entry.correlationId,
                  message: item.message,
                });
                continue;
              }
              // Same tolerance as the single path's EntityConflictError: a
              // concurrent or earlier delivery already created it.
              runtimeLogger.info(
                entry.kind === 'step'
                  ? 'Step already exists, continuing'
                  : 'Wait already exists, continuing',
                {
                  workflowRunId: runId,
                  correlationId: entry.correlationId,
                  message: item.message,
                }
              );
              continue;
            }
            throw new WorkflowWorldError(
              `batched ${entry.event.eventType} for ${entry.correlationId} ` +
                `failed: ${item.error}: ${item.message}`,
              { status: item.status }
            );
          }
          // Highest slot this chunk committed: the ceiling the caller folds
          // into the inline executions' slot snapshot (see
          // SuspensionHandlerResult.batchCommittedSlotCeiling) and one input
          // of the interleaving diagnostic.
          const chunkMaxSlot = maxEventSlot(
            results.flatMap((item) =>
              item.error === undefined && item.event ? [item.event] : []
            )
          );
          if (
            chunkMaxSlot !== undefined &&
            (batchCommittedSlotCeiling === undefined ||
              chunkMaxSlot > batchCommittedSlotCeiling)
          ) {
            batchCommittedSlotCeiling = chunkMaxSlot;
          }
          committedCount += results.filter(
            (item) => item.error === undefined
          ).length;
          if (
            chunkMaxSlot !== undefined &&
            (maxCommittedSlot === undefined || chunkMaxSlot > maxCommittedSlot)
          ) {
            maxCommittedSlot = chunkMaxSlot;
          }
        };

        // Publish the chunk's eager steps' queue messages the moment ITS
        // creates are durable, the per-chunk half of publish-after-create.
        // Same message shape and step-identity-scoped idempotency key as the
        // caller's dispatch pass, so anything double-published dedupes.
        const publishChunkSteps = async (
          chunk: typeof entries
        ): Promise<void> => {
          if (!publishEagerSteps) return;
          const stepEntries = chunk.filter((entry) => entry.kind === 'step');
          if (stepEntries.length === 0) return;
          const traceCarrier = await getStepDispatchTraceCarrier();
          await Promise.all(
            stepEntries.map((entry) =>
              queueMessage(
                world,
                // biome-ignore lint/style/noNonNullAssertion: publishEagerSteps implies presence
                stepDispatch!.queueName,
                {
                  runId,
                  stepId: entry.correlationId,
                  // biome-ignore lint/style/noNonNullAssertion: set on every 'step' entry at enqueue
                  stepName: entry.stepName!,
                  traceCarrier,
                  requestedAt: new Date(),
                },
                {
                  idempotencyKey: stepDispatchIdempotencyKey(
                    entry.correlationId,
                    // biome-ignore lint/style/noNonNullAssertion: set on every 'step' entry at enqueue
                    entry.stepName!
                  ),
                }
              )
            )
          );
        };

        // Launch every chunk's POST now; chain each chunk's publishes on its
        // OWN commit. A chunk whose commit rejected keeps its messages
        // unsent (the rejection fails the delivery; redelivery re-creates
        // and re-dispatches, deduped by the idempotency keys).
        const commits = chunks.map((chunk) => commitChunk(chunk));
        const publishes = chunks.map(async (chunk, index) => {
          await commits[index];
          await publishChunkSteps(chunk);
        });

        const trailing = (async () => {
          // Let every sibling settle before surfacing the first failure: a
          // chunk that committed must still get its publishes out even when
          // another chunk failed, and the caller acks only after this
          // resolves.
          const settled = await Promise.allSettled([...commits, ...publishes]);
          // Foreign-interleaving visibility: the batch endpoint has no
          // bump-and-report, so events other writers landed between the
          // snapshot and these commits pushed the fold to higher slots
          // WITHOUT handing us the skipped events. Same accepted exposure
          // as a dropped truncated report on the single path: the local
          // log stays a strict prefix and the next reload observes them.
          // Logged so a bump is diagnosable rather than silent.
          if (
            expectedFirstSlot !== undefined &&
            maxCommittedSlot !== undefined
          ) {
            const interleaved =
              maxCommittedSlot - expectedFirstSlot + 1 - committedCount;
            if (interleaved > 0) {
              runtimeLogger.debug('Batched fan-out committed above snapshot', {
                workflowRunId: runId,
                expectedFirstSlot,
                maxCommittedSlot,
                committedCount,
                interleaved,
              });
            }
          }
          const failure = settled.find(
            (outcome): outcome is PromiseRejectedResult =>
              outcome.status === 'rejected'
          );
          if (failure) throw failure.reason;
        })();

        // EVERY chunk carrying pairs gates the return, not just the first:
        // a pair whose commit the caller has not seen yields no
        // `inlineClaims` entry, so the caller falls back to a lazy
        // `step_started` that would race this same fold's still-in-flight
        // pair for the same step. Today pairs always land in one chunk
        // (they sort first, and two rows per inline step fit inside one
        // chunk, pinned by constants.test.ts), so this is at most one
        // commit; the filter is what keeps the property true if either cap
        // moves.
        const pairCommits = chunks.flatMap((chunk, index) =>
          chunk.some((entry) => entry.kind === 'inline-started')
            ? [commits[index]]
            : []
        );
        if (allowDeferredBatchWork) {
          // The trailing work is the caller's to join before ack. Attach a
          // handler now so a rejection that races that join (or a foreground
          // failure that prevents the caller from ever reaching it) is never
          // an unhandledRejection; awaiting the promise still observes it.
          trailing.catch(() => {});
          deferredBatchWork = trailing;
          // Only the pair chunks gate the return: their claims are what the
          // caller starts the inline bodies from. With no pairs there is
          // nothing the caller's post-return work reads from the commits,
          // so nothing gates.
          if (pairCommits.length > 0) {
            try {
              await Promise.all(pairCommits);
            } catch (err) {
              // A pair chunk failed, so this phase's write set is NOT the
              // caller's to join any more: `deferredBatchWork` never
              // reaches it once handleSuspension throws. Settle the rest
              // before the rejection escapes, for the reason `settlePhase`
              // gives: a sibling create landing after the throw commits an
              // event from the abandoned replay's seeded sequence and races
              // the caller's restart reload while doing so.
              await trailing.catch(() => {});
              throw err;
            }
          }
        } else {
          await trailing;
        }
      })()
    );
  }

  for (const queueItem of attributeItems) {
    ops.push(
      (async () => {
        try {
          await ensureRunReady();
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
  await settlePhase(ops);

  // Rebuild the inline batch in deterministic order. `lazyInlineCorrelationIds`
  // is a Set seeded from the ordered first-N slice, so iterating it preserves
  // stepItems order; every id in it was set by the lazy branch above.
  const lazyInlineSteps: SuspensionHandlerResult['lazyInlineSteps'] = [];
  for (const correlationId of lazyInlineCorrelationIds) {
    const lazyStep = lazyInlineByCorrelationId.get(correlationId);
    if (lazyStep) lazyInlineSteps.push(lazyStep);
  }

  // Find the soonest pending wait (minimum timeout)
  const now = Date.now();
  let soonestWait: { seconds: number; correlationId: string } | undefined;
  for (const queueItem of waitItems) {
    const resumeAtMs = queueItem.resumeAt.getTime();
    const delayMs = Math.max(1000, resumeAtMs - now);
    const timeoutSeconds = Math.ceil(delayMs / 1000);
    if (!soonestWait || timeoutSeconds < soonestWait.seconds) {
      soonestWait = {
        seconds: timeoutSeconds,
        correlationId: queueItem.correlationId,
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
    ...(resilientDispatchRecovered > 0
      ? Attribute.StepResilientDispatchRecovered(resilientDispatchRecovered)
      : {}),
  });

  return {
    pendingSteps: stepItems,
    createdStepCorrelationIds,
    failedStepCorrelationIds,
    queuedStepCorrelationIds,
    lazyInlineSteps,
    inlineClaims,
    batchCommittedSlotCeiling,
    deferredBatchWork,
    // On hook conflict the caller re-invokes immediately and never reads
    // the wait timeout, so don't report one.
    waitTimeout: hasHookConflict ? undefined : soonestWait,
    hasHookConflict,
    hasAwaitedHookCreation,
    hasAttributeEvents: attributeItems.length > 0,
    hasHookEvents: hooksNeedingCreation.length > 0,
    hookCreationMs,
    serializationWasPassive,
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
