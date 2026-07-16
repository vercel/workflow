import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  FatalError,
  HookNotFoundError,
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
import { dehydrateStepArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getAbortStreamIdFromToken } from '../util.js';
import { getMaxInlineSteps } from './constants.js';
import { type MutableEventLog, withPreconditionRetry } from './helpers.js';

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  span?: Span;
  requestId?: string;
  /**
   * The runtime's loaded event log. Each event creation is sent with this
   * snapshot's `stateUpdatedAt` and, if the backend rejects it as stale (412),
   * the log is reloaded in place and the create is retried — see
   * `withPreconditionRetry`. Guarding per-create (rather than the whole
   * suspension) ensures a retry never re-issues an already-created event.
   */
  eventLog?: MutableEventLog;
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

  // Create an event with the optimistic-concurrency guard when the caller
  // supplied a loaded event log; otherwise create it directly (callers without
  // a replay snapshot, e.g. tests). The guard reloads + retries on a stale
  // (412) rejection, keeping `eventLog` current in place. All suspension events
  // are non-run_created events on this run's `runId`.
  const createGuarded = (
    data: CreateEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> => {
    if (!eventLog) {
      return world.events.create(runId, data, params);
    }
    return withPreconditionRetry(runId, eventLog, (stateUpdatedAt) =>
      world.events.create(runId, data, { ...params, stateUpdatedAt })
    );
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

  // Gate payload compression on the run's specVersion: only runs marked
  // as possibly containing compressed payloads (spec >= 5) get gzip data.
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
    await Promise.all(
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
    await Promise.all(
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

  // Steps: create step_created events (no queuing — V2 returns pending steps to caller)
  for (const queueItem of stepItems) {
    if (stepsNeedingCreation.has(queueItem.correlationId)) {
      ops.push(
        (async () => {
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
            compression
          );
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
        })()
      );
    }
  }

  // Create wait events (same as V1)
  for (const queueItem of waitItems) {
    if (!queueItem.hasCreatedEvent) {
      ops.push(
        (async () => {
          const waitEvent: CreateEventRequest = {
            eventType: 'wait_created' as const,
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: queueItem.correlationId,
            eventData: {
              resumeAt: queueItem.resumeAt,
            },
          };
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

  for (const queueItem of attributeItems) {
    ops.push(
      (async () => {
        try {
          await ensureRunReady();
          await world.events.create(
            runId,
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
          } else if (isAttributeValidationFailure(err)) {
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
  await Promise.all(ops);

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
  });

  return {
    pendingSteps: stepItems,
    createdStepCorrelationIds,
    lazyInlineSteps,
    // On hook conflict the caller re-invokes immediately and never reads
    // the wait timeout, so don't report one.
    waitTimeout: hasHookConflict ? undefined : soonestWait,
    hasHookConflict,
    hasAwaitedHookCreation,
    hasAttributeEvents: attributeItems.length > 0,
    hasHookEvents: hooksNeedingCreation.length > 0,
    hookCreationMs,
  };
}

/**
 * Whether an `events.create` rejection is a deterministic attribute
 * validation failure rather than a transient/storage error. Local Worlds
 * (world-local, world-postgres) throw `AttributeValidationError` directly;
 * remote Worlds surface the equivalent server-side rejection as a
 * `WorkflowWorldError` with HTTP status 400. The name check covers
 * `AttributeValidationError` instances from a different copy of
 * `@workflow/world` than the one this package resolved.
 */
function isAttributeValidationFailure(err: unknown): boolean {
  if (err instanceof AttributeValidationError) return true;
  if (err instanceof Error && err.name === 'AttributeValidationError') {
    return true;
  }
  return WorkflowWorldError.is(err) && err.status === 400;
}
