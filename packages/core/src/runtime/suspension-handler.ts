import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
} from '@workflow/errors';
import {
  type CreateEventRequest,
  type Event,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { importKey } from '../encryption.js';
import type {
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import { runtimeLogger } from '../logger.js';
import { dehydrateStepArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getAbortStreamIdFromToken } from '../util.js';
import { fencedEventCreate } from './fenced-write.js';
import { loadWorkflowRunEvents } from './helpers.js';

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  span?: Span;
  requestId?: string;
  /**
   * Caller's most recent view of the event log (tail eventId), used as
   * the OCC fence on every branch-decision write below. Pass `undefined`
   * when the caller has no events loaded yet; the writes will then be
   * unfenced (still atomically advance `run.lastKnownEventId` on the
   * server side so future fenced writers chain off the new value).
   *
   * Conceptually identical to the elapsed-wait scan fence. See
   * `fenced-write.ts` for the rationale for extending it to
   * step/wait/hook `_created` and `hook_disposed`.
   */
  fenceEventId?: string;
  /**
   * Caller's events-cursor token (from `loadWorkflowRunEvents`). Used to
   * refresh the fence after a CAS conflict — the handler pulls fresh
   * events from this cursor, takes the new tail as the next fence, and
   * retries.
   */
  eventsCursor?: string | null;
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
  /** Timeout from waits, if any */
  timeoutSeconds?: number;
  /** Whether a hook conflict was detected (should re-invoke immediately) */
  hasHookConflict: boolean;
}

/**
 * Handles a workflow suspension by processing all pending operations (hooks, steps, waits).
 * Creates events for all operations but does NOT queue step messages — returns the pending
 * steps so the caller can decide which to execute inline vs queue to background.
 *
 * Processing order:
 * 1. Hooks are processed first to prevent race conditions with webhook receivers
 * 2. Writes that advance the event-log fence are issued in DB-order from this
 *    replay turn, so the next local write chains off the previous event ID.
 */
export async function handleSuspension({
  suspension,
  world,
  run,
  span,
  requestId,
  fenceEventId: initialFenceEventId,
  eventsCursor: initialEventsCursor,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  const runId = run.runId;

  // Per-suspension shared fence state. Each successful fenced write advances
  // `fenceEventId` so subsequent writes from this handler chain off it.
  // Branch-decision event writes must not race each other locally: the server
  // fence is a single-tip CAS, so parallel sibling writes from one replay turn
  // would force self-conflicts against the same starting fence.
  let fenceEventId = initialFenceEventId;
  let eventsCursor = initialEventsCursor;

  /**
   * Reloads events from the cursor and returns the new tail as a fresh
   * fence. Also returns the freshly-loaded events so callers can run
   * idempotency checks (e.g. "is this `wait_created` already in the log?
   * → abort the write").
   *
   * NOTE: when `eventsCursor` is unset the reload is a full re-read of
   * the run's log, matching the elapsed-wait scan fallback.
   */
  async function refreshFence(): Promise<{
    fenceEventId: string | undefined;
    loadedEvents: Event[];
  }> {
    const loaded = eventsCursor
      ? await loadWorkflowRunEvents(runId, eventsCursor)
      : await loadWorkflowRunEvents(runId);
    eventsCursor = loaded.cursor ?? eventsCursor;
    const tail =
      loaded.events[loaded.events.length - 1]?.eventId ?? fenceEventId;
    return { fenceEventId: tail, loadedEvents: loaded.events };
  }
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

  // Split hooks by what actions they need
  const hooksNeedingCreation = allHookItems.filter(
    (item) => !item.hasCreatedEvent
  );
  const hooksNeedingDisposal = allHookItems.filter((item) => item.disposed);

  // Resolve encryption key for this run
  const rawKey = await world.getEncryptionKeyForRun?.(run);
  const encryptionKey = rawKey ? await importKey(rawKey) : undefined;

  // Build and process hook_created events (same as V1)
  const hookEvents: CreateEventRequest[] = await Promise.all(
    hooksNeedingCreation.map(async (queueItem) => {
      const hookMetadata: SerializedData | undefined =
        typeof queueItem.metadata === 'undefined'
          ? undefined
          : ((await dehydrateStepArguments(
              queueItem.metadata,
              runId,
              encryptionKey,
              suspension.globalThis
            )) as SerializedData);
      return {
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
    })
  );

  // Process hooks first to prevent race conditions with webhook receivers.
  // Track any hook conflicts that occur — these are returned to the caller
  // so the V2 handler can re-invoke immediately.
  let hasHookConflict = false;

  for (const hookEvent of hookEvents) {
    try {
      const writeResult = await fencedEventCreate({
        world,
        runId,
        event: hookEvent,
        requestId,
        fenceEventId,
        onConflictRefresh: async () => {
          const { fenceEventId: fresh, loadedEvents } = await refreshFence();
          // Idempotency: if the hook was already created (by us in a
          // previous attempt that 412'd then succeeded server-side,
          // or by a concurrent handler), don't retry.
          const alreadyCreated = loadedEvents.some(
            (e) =>
              (e.eventType === 'hook_created' ||
                e.eventType === 'hook_conflict') &&
              e.correlationId === hookEvent.correlationId
          );
          if (alreadyCreated) {
            return { kind: 'abort' };
          }
          return { kind: 'retry', fenceEventId: fresh };
        },
        onEntityConflict: () => 'abort',
      });
      if (writeResult.newFenceEventId) {
        fenceEventId = writeResult.newFenceEventId;
      }
      if (!writeResult.written) {
        // Already created concurrently — surface as info, same shape
        // as the pre-fence "EntityConflictError → skip" branch did.
        runtimeLogger.info(
          'Workflow run already completed or hook already created, skipping',
          {
            workflowRunId: runId,
            correlationId: hookEvent.correlationId,
          }
        );
        continue;
      }
      // Preserve the "world resolved hook_created → hook_conflict"
      // short-circuit. The hook_conflict event lives in the log and
      // will be replayed; the immediate signal lets the caller
      // re-invoke right away rather than waiting on the queue.
      if (writeResult.event?.eventType === 'hook_conflict') {
        hasHookConflict = true;
      }
    } catch (err) {
      if (RunExpiredError.is(err)) {
        runtimeLogger.info('Workflow run already completed, skipping hook', {
          workflowRunId: runId,
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // Process hook disposals — these release hook tokens for reuse by other workflows.
  for (const queueItem of hooksNeedingDisposal) {
    const hookDisposedEvent: CreateEventRequest = {
      eventType: 'hook_disposed' as const,
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: queueItem.correlationId,
      eventData: {
        token: queueItem.token,
      },
    };
    try {
      const writeResult = await fencedEventCreate({
        world,
        runId,
        event: hookDisposedEvent,
        requestId,
        fenceEventId,
        onConflictRefresh: async () => {
          const { fenceEventId: fresh, loadedEvents } = await refreshFence();
          // Idempotency: if already disposed, abort.
          const alreadyDisposed = loadedEvents.some(
            (e) =>
              e.eventType === 'hook_disposed' &&
              e.correlationId === queueItem.correlationId
          );
          if (alreadyDisposed) {
            return { kind: 'abort' };
          }
          return { kind: 'retry', fenceEventId: fresh };
        },
        onEntityConflict: () => 'abort',
      });
      if (writeResult.newFenceEventId) {
        fenceEventId = writeResult.newFenceEventId;
      }
    } catch (err) {
      if (RunExpiredError.is(err)) {
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

  // Process abort requests — resume the hook with abort payload and write stream packet
  const hooksNeedingAbort = allHookItems.filter(
    (item) => item.abortRequested && !item.disposed
  );

  for (const queueItem of hooksNeedingAbort) {
    try {
      // Dehydrate the abort payload for storage
      const abortPayload = await dehydrateStepArguments(
        { aborted: true, reason: queueItem.abortReason },
        runId,
        encryptionKey,
        suspension.globalThis
      );

      // Create hook_received event with abort payload. This event is
      // deliberately unfenced because it represents signal delivery, but
      // successful writes still advance the server's run.lastKnownEventId.
      const abortEventResult = await world.events.create(runId, {
        eventType: 'hook_received' as const,
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: queueItem.correlationId,
        eventData: {
          token: queueItem.token,
          payload: abortPayload,
        },
      });
      if (abortEventResult.event?.eventId) {
        fenceEventId = abortEventResult.event.eventId;
      }

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
        runtimeLogger.info('Workflow run already completed, skipping abort', {
          workflowRunId: runId,
          correlationId: queueItem.correlationId,
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // Create step events for steps that don't have them yet.
  // Unlike V1, we do NOT queue step messages from here — the caller
  // decides which steps to execute inline vs. queue to background.
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

  const ops: Array<() => Promise<void>> = [];

  // Steps: create step_created events (no queuing — V2 returns pending
  // steps to caller).
  //
  // Fenced: under concurrent replay, two invocations with diverging
  // event-log snapshots can pick different branch decisions for the same
  // deterministic correlationId (e.g. a hook/sleep race that one replay
  // saw resolve to "wake" and another to "sleep"). The fence rejects the
  // stale-view writer so only the authoritative replay's step_created
  // lands; the other invocation reloads and retries against the new tail.
  for (const queueItem of stepItems) {
    if (stepsNeedingCreation.has(queueItem.correlationId)) {
      ops.push(async () => {
        const dehydratedInput = await dehydrateStepArguments(
          {
            args: queueItem.args,
            closureVars: queueItem.closureVars,
            thisVal: queueItem.thisVal,
          },
          runId,
          encryptionKey,
          suspension.globalThis
        );
        const stepEvent: CreateEventRequest = {
          eventType: 'step_created' as const,
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: queueItem.correlationId,
          eventData: {
            stepName: queueItem.stepName,
            input: dehydratedInput as SerializedData,
          },
        };
        const writeResult = await fencedEventCreate({
          world,
          runId,
          event: stepEvent,
          requestId,
          fenceEventId,
          onConflictRefresh: async () => {
            const { fenceEventId: fresh, loadedEvents } = await refreshFence();
            // Idempotency: if step_created for this correlationId is
            // already in the log, abort. Distinct from the
            // EntityConflictError-on-duplicate-stepId case (that's
            // handled by onEntityConflict below) — this branch
            // catches the case where _our_ stale-snapshot CAS lost
            // to a concurrent writer for the same correlationId.
            const alreadyCreated = loadedEvents.some(
              (e) =>
                e.eventType === 'step_created' &&
                e.correlationId === queueItem.correlationId
            );
            if (alreadyCreated) {
              return { kind: 'abort' };
            }
            return { kind: 'retry', fenceEventId: fresh };
          },
          onEntityConflict: () => 'abort',
        });
        if (writeResult.newFenceEventId) {
          fenceEventId = writeResult.newFenceEventId;
        }
        if (writeResult.written) {
          createdStepCorrelationIds.add(queueItem.correlationId);
        } else {
          runtimeLogger.info(
            'Step already exists (post-fence-conflict), continuing',
            {
              workflowRunId: runId,
              correlationId: queueItem.correlationId,
            }
          );
        }
      });
    }
  }

  // Create wait events. Same fencing rationale as `step_created`: a
  // stale-view replay can otherwise call `sleep(...)` on a code path
  // that the authoritative replay doesn't take, landing a `wait_created`
  // that future replays will see as an orphan.
  for (const queueItem of waitItems) {
    if (!queueItem.hasCreatedEvent) {
      ops.push(async () => {
        const waitEvent: CreateEventRequest = {
          eventType: 'wait_created' as const,
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: queueItem.correlationId,
          eventData: {
            resumeAt: queueItem.resumeAt,
          },
        };
        const writeResult = await fencedEventCreate({
          world,
          runId,
          event: waitEvent,
          requestId,
          fenceEventId,
          onConflictRefresh: async () => {
            const { fenceEventId: fresh, loadedEvents } = await refreshFence();
            const alreadyCreated = loadedEvents.some(
              (e) =>
                e.eventType === 'wait_created' &&
                e.correlationId === queueItem.correlationId
            );
            if (alreadyCreated) {
              return { kind: 'abort' };
            }
            return { kind: 'retry', fenceEventId: fresh };
          },
          onEntityConflict: () => 'abort',
        });
        if (writeResult.newFenceEventId) {
          fenceEventId = writeResult.newFenceEventId;
        }
        if (!writeResult.written) {
          runtimeLogger.info('Wait already exists, continuing', {
            workflowRunId: runId,
            correlationId: queueItem.correlationId,
          });
        }
      });
    }
  }

  for (const op of ops) {
    await op();
  }

  // Calculate minimum timeout from waits
  const now = Date.now();
  const minTimeoutSeconds = waitItems.reduce<number | null>(
    (min, queueItem) => {
      const resumeAtMs = queueItem.resumeAt.getTime();
      const delayMs = Math.max(1000, resumeAtMs - now);
      const timeoutSeconds = Math.ceil(delayMs / 1000);
      if (min === null) return timeoutSeconds;
      return Math.min(min, timeoutSeconds);
    },
    null
  );

  span?.setAttributes({
    ...Attribute.WorkflowRunStatus('workflow_suspended'),
    ...Attribute.WorkflowStepsCreated(stepItems.length),
    ...Attribute.WorkflowHooksCreated(hooksNeedingCreation.length),
    ...Attribute.WorkflowWaitsCreated(waitItems.length),
  });

  return {
    pendingSteps: stepItems,
    createdStepCorrelationIds,
    timeoutSeconds: hasHookConflict ? 0 : (minTimeoutSeconds ?? undefined),
    hasHookConflict,
  };
}
