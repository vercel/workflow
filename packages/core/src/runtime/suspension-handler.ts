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
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
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
import { dehydrateStepArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getAbortStreamIdFromToken } from '../util.js';
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

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  span?: Span;
  requestId?: string;
  /**
   * The runtime's loaded event log. Every event creation this suspension makes
   * names the position it was derived from, so a backend that has recorded
   * events the replay did not see can report them back on the write — or, if
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
   * pass — see the step ops below), each newly created non-inline step's
   * `step_created` write is parallelized with its step-execution queue
   * publish, and the queue message carries the serialized step input
   * (`stepInput`) so the consumer can idempotently re-ensure the event if the
   * direct write failed transiently. Steps queued this way are reported in
   * {@link SuspensionHandlerResult.queuedStepCorrelationIds} so the caller
   * skips them in its own dispatch pass. Omitted by callers that must not
   * queue (terminal drain, tests) — creates then behave exactly as before.
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
   * step_created event should queue / inline-execute the step — this
   * guarantees a single owner per step, even when multiple handlers race
   * into the same batch boundary.
   */
  createdStepCorrelationIds: Set<string>;
  /**
   * Correlation IDs of steps this suspension call already published
   * step-execution queue messages for, via resilient step dispatch (the
   * `step_created` write parallelized with a `stepInput`-carrying queue
   * publish). The caller MUST NOT dispatch these again — the message is
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
  /**
   * Whether serializing this suspension's new step inputs was passive (did
   * not execute workflow-owned code such as getters, proxy traps, or custom
   * serializers). `false` means the retained VM may have diverged from what
   * a cold replay would compute, so the caller must demote to replay.
   */
  retainedStepInputsSafe: boolean;
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
 * Creates events for all operations but does NOT queue step messages — returns the pending
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
        // intentional: ordering barrier only — see above.
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
   * abandoned replay's seeded sequence — an event the fresh replay never
   * produces — and it races the restart's reload while doing so. Settling first
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
  // which restarts the replay from a corrected log — it is not retried here,
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
    // than at each call site means the rest of this phase's writes — which read
    // the same array to build their own snapshot — ask for a slot above them,
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
  // before a later same-token hook's creation is validated — otherwise the
  // new hook records a spurious hook_conflict against the run's own
  // disposed hook — while a hook created and disposed within the same
  // suspension is still created before it is disposed. Different tokens
  // have no claim interaction, so token groups are processed in parallel.
  const hookItemsByToken = new Map<string, HookInvocationQueueItem[]>();
  for (const item of allHookItems) {
    if (item.hasCreatedEvent && !item.disposed) {
      continue; // already committed and still live — nothing to do
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
        // Hook was already disposed by a concurrent invocation — safe to skip
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
  // Track any hook conflicts that occur — these are returned to the caller
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
            const hookMetadata: SerializedData | undefined =
              typeof queueItem.metadata === 'undefined'
                ? undefined
                : ((await dehydrateStepArguments(
                    queueItem.metadata,
                    runId,
                    encryptionKey,
                    suspension.globalThis,
                    false,
                    compression
                  )) as SerializedData);
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

  // Process abort requests — resume the hook with abort payload and write stream packet
  const hooksNeedingAbort = allHookItems.filter(
    (item) => item.abortRequested && !item.disposed
  );

  if (hooksNeedingAbort.length > 0) {
    await ensureRunReady();
    await settlePhase(
      hooksNeedingAbort.map(async (queueItem) => {
        try {
          // Dehydrate the abort payload for storage
          const abortPayload = await dehydrateStepArguments(
            { aborted: true, reason: queueItem.abortReason },
            runId,
            encryptionKey,
            suspension.globalThis,
            false,
            compression
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
            // Best-effort stream write — hook event provides the durable fallback
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
  // Unlike V1, we do NOT queue step messages from here — the caller
  // decides which steps to execute inline vs. queue to background.
  // Wait events are also created in parallel below.
  const stepsNeedingCreation = new Set(
    stepItems
      .filter((queueItem) => !queueItem.hasCreatedEvent)
      .map((queueItem) => queueItem.correlationId)
  );

  // Correlation IDs for which THIS suspension call actually wrote the
  // step_created event. Populated by the ops below after a successful
  // events.create — used by the caller to claim ownership and avoid
  // racing with concurrent handlers on step execution.
  const createdStepCorrelationIds = new Set<string>();

  // Serialization always runs through the one ordinary path below, so the
  // durable bytes cannot depend on retention. What retention needs to know is
  // whether that serialization *executed* workflow code (getters, proxy
  // traps, custom serializers) — side effects a cold replay would not
  // repeat, since a replay skips dehydration for already-recorded steps.
  // The hardened serializer records exactly that into this sink (see
  // ../serialization/hardened.ts); when any input in the batch records an
  // execution, the caller demotes the session so the side effects land in a
  // VM that is about to be discarded, exactly like the pre-retention
  // runtime.
  const guestCodeStats: GuestCodeStats = { executions: [] };

  // Lazy inline start: defer the step_created write for up to
  // `getMaxInlineSteps()` steps the caller will run inline (in parallel). Each
  // step is created on the fly by the lazy `step_started` executeStep sends
  // (saving a round-trip per step). We never defer when a `hook.getConflict()`
  // awaiter is present, because in that case the caller executes nothing inline
  // (it re-invokes immediately to resolve the awaiter), so deferring would
  // leave the steps uncreated and unqueued. We pick the first N uncreated steps
  // — matching the caller's inline-candidate selection — and dehydrate their
  // input here so executeStep can ship it as the step_started payload.
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
  //  - The caller provided a dispatch target (`stepDispatch`) — terminal
  //    drains and other create-only callers never queue.
  //  - The feature is enabled (`WORKFLOW_RESILIENT_STEP_DISPATCH` opt-in).
  //    It is off by default because the publish races the create's verdict,
  //    and a create can come back refused: as a duplicate the replay should
  //    stop pursuing, or — on a World that would rather refuse a stale write
  //    than report what it missed — as a 412. Either way the queue message
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
  // fan-out — no attribute writes, no hook writes, no resilient dispatch
  // (whose creates are each paired with a queue publish) — on a World that
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
    kind: 'step' | 'wait';
    correlationId: string;
    event: CreateEventRequest;
  }[] = [];
  const batchPreps: Promise<void>[] = [];

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

  // Steps: create step_created events (no queuing — V2 returns pending steps
  // to caller — EXCEPT on the resilient dispatch path, which parallelizes the
  // create with the step's queue publish and reports it in
  // `queuedStepCorrelationIds`).
  let batchOrderCounter = 0;
  for (const queueItem of stepItems) {
    if (stepsNeedingCreation.has(queueItem.correlationId)) {
      // Deterministic position in the batched fold (assigned in stepItems
      // order, before the concurrent dehydration runs).
      const stepOrder = batchOrderCounter++;
      const stepOp = (async () => {
        // Per-step sink, merged below: the dehydrate wrapper emits span
        // attributes from the sink it is handed, so sharing one across
        // steps would re-emit (and misattribute) earlier steps' entries.
        const stepGuestCode: GuestCodeStats = { executions: [] };
        const dehydratedInput = await dehydrateStepArguments(
          {
            args: queueItem.args,
            closureVars: queueItem.closureVars,
            thisVal: queueItem.thisVal,
          },
          runId,
          encryptionKey,
          suspension.globalThis,
          false,
          compression,
          stepGuestCode
        );
        guestCodeStats.executions.push(...stepGuestCode.executions);
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
            dehydratedInput: dehydratedInput as SerializedData,
          });
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
        // step-execution queue publish in parallel — the message carries the
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
              // handler's — redundant publishes for this step dedupe. The
              // key is step-identity-scoped so a revoked message for a
              // reassigned correlation id cannot absorb the corrected
              // schedule's dispatch — see stepDispatchIdempotencyKey.
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
          // re-creates the (idempotent) step_created and re-dispatches —
          // the same recovery as the sequential path.
          if (queueResult.status === 'rejected') {
            throw queueResult.reason;
          }
          queuedStepCorrelationIds.add(queueItem.correlationId);
          if (createResult.status === 'rejected') {
            const err = createResult.reason;
            if (EntityConflictError.is(err)) {
              // Concurrent handler wrote it first — same as the sequential
              // path. The step message is already out; a duplicate publish
              // by that handler dedupes on the shared idempotency key.
              runtimeLogger.info('Step already exists, continuing', {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              });
            } else if (isRetryableWorldError(err)) {
              // Resilient: the write failed transiently (429 / 5xx /
              // transport) but the step message — carrying the same
              // serialized input — was published, so the consumer
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
        // swallows it and commits whatever was successfully enqueued —
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
        // Waits need no dehydration, so they enqueue synchronously — after
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

  // The batched fold's flush: ONE durable write for the whole clean fan-out
  // (chunked at MAX_BATCH_FANOUT_EVENTS), joining `ops` like the per-event
  // writes it replaces so settlePhase semantics are unchanged. Each event
  // reports the outcome its own single create would have had: a 409 is the
  // same already-exists tolerance as the single path, anything else fails
  // the op the way a single-path rejection would.
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
        // createGuarded provides — so a lone eager event takes the ordinary
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
        for (
          let start = 0;
          start < entries.length;
          start += MAX_BATCH_FANOUT_EVENTS
        ) {
          const chunk = entries.slice(start, start + MAX_BATCH_FANOUT_EVENTS);
          const expectedFirstSlot = eventLog
            ? (maxEventSlot(eventLog.events) ?? 0) + 1
            : undefined;
          // biome-ignore lint/style/noNonNullAssertion: batchFanoutEligible implies presence
          const { results } = await world.events.createBatch!(
            runId,
            chunk.map((entry) => ({ event: entry.event }))
          );
          for (const [index, item] of results.entries()) {
            const entry = chunk[index];
            if (item.error === undefined) {
              if (entry.kind === 'step') {
                createdStepCorrelationIds.add(entry.correlationId);
              }
              continue;
            }
            if (item.status === 409) {
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
          // Slot-bump visibility: the batch endpoint has no bump-and-report,
          // so a foreign event landing between our snapshot and the commit
          // pushes the whole batch to higher slots WITHOUT handing us the
          // skipped events. That is the same accepted exposure as a dropped
          // truncated report on the single path (absorbSkippedSlotReport
          // drops those whole): the local log continues without the foreign
          // events and the next reload sees them. Logged so a bump is
          // diagnosable rather than silent.
          const firstCommitted = results.find(
            (item) => item.error === undefined
          )?.event;
          if (expectedFirstSlot !== undefined && firstCommitted) {
            const firstSlot = maxEventSlot([firstCommitted]);
            if (firstSlot !== undefined && firstSlot > expectedFirstSlot) {
              runtimeLogger.debug('Batched fan-out committed above snapshot', {
                workflowRunId: runId,
                expectedFirstSlot,
                firstSlot,
                skipped: firstSlot - expectedFirstSlot,
              });
            }
          }
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
          // saw. Rejecting it is cheap — a run with attribute events already
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
            // Deterministic validation rejection from the World — e.g. the
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

  // The step-input dehydrations above have settled, so the sink is final.
  const retainedStepInputsSafe = guestCodeStats.executions.length === 0;
  if (!retainedStepInputsSafe) {
    runtimeLogger.debug(
      'Serializing step inputs executed workflow code; falling back to replay instead of retaining the VM',
      {
        workflowRunId: runId,
        executions: guestCodeStats.executions
          .slice(0, 5)
          .map((e) => (e.detail ? `${e.kind}(${e.detail})` : e.kind)),
      }
    );
  }

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
    ...(resilientDispatchRecovered > 0
      ? Attribute.StepResilientDispatchRecovered(resilientDispatchRecovered)
      : {}),
  });

  return {
    pendingSteps: stepItems,
    createdStepCorrelationIds,
    queuedStepCorrelationIds,
    lazyInlineSteps,
    // On hook conflict the caller re-invokes immediately and never reads
    // the wait timeout, so don't report one.
    waitTimeout: hasHookConflict ? undefined : soonestWait,
    hasHookConflict,
    hasAwaitedHookCreation,
    hasAttributeEvents: attributeItems.length > 0,
    hasHookEvents: hooksNeedingCreation.length > 0,
    hookCreationMs,
    retainedStepInputsSafe,
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
