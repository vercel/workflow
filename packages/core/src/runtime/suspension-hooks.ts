/**
 * The hook half of a suspension, shared by both orchestrators'
 * `handleSuspension` (`spec8/suspension-handler.ts`,
 * `spec9/suspension-handler.ts`): hook creations, disposals and aborts, and the
 * serialization of their payloads.
 */
import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
} from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type EventResult,
  type SerializedData,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { importKey } from '../encryption.js';
import type { HookInvocationQueueItem, WorkflowSuspension } from '../global.js';
import { runtimeLogger } from '../logger.js';
import {
  GUEST_CODE_EXECUTION_SAMPLE_LIMIT,
  type GuestCodeStats,
} from '../serialization/hardened.js';
import { dehydrateStepArguments } from '../serialization.js';
import { getAbortStreamIdFromToken } from '../util.js';
import type { SuspensionSerializationBlocker } from './delivery.js';
import { createHookEvent } from './hook-creation.js';

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
export async function settlePhase(ops: Promise<unknown>[]): Promise<void> {
  const reasons = (await Promise.allSettled(ops))
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
  if (reasons.length === 0) return;
  throw reasons.find((r) => PreconditionFailedError.is(r)) ?? reasons[0];
}

/** What {@link startSuspensionHookWrites} hands back to its suspension. */
export interface SuspensionHookWrites {
  readonly encryptionKey: Awaited<ReturnType<typeof importKey>> | undefined;
  /** Whether payloads are compressed (gated on the run's spec version). */
  readonly compression: boolean;
  /** Serializes a payload of the suspension, counting the workflow code it ran. */
  dehydrateInput(
    value: unknown,
    context: Pick<SuspensionSerializationBlocker, 'source' | 'correlationId'>
  ): Promise<SerializedData>;
  /** Workflow-code executions observed while serializing (see `getRetentionDecision`). */
  readonly blockers: {
    count: number;
    sample: SuspensionSerializationBlocker[];
  };
  readonly hookConflictCorrelationIds: string[];
  readonly awaitedHookCorrelationIds: string[];
  /** The hook writes, already in flight; undefined when there are none. */
  readonly hookOp: Promise<void> | undefined;
  /** When the hook groups started and settled, for the hook creation time. */
  hookGroupsWindow(): { startMs: number; endMs?: number } | undefined;
}

/**
 * Starts a suspension's hook writes. They go out alongside the suspension's
 * other writes: the caller settles `hookOp` with the rest.
 */
export async function startSuspensionHookWrites({
  suspension,
  world,
  run,
  runId,
  requestId,
  allHookItems,
  hooksNeedingCreation,
  eventLog,
  forceClaimVictimWakes,
  createGuarded,
  hookCreateEvent,
  eventSpecVersion,
  beforeWrites,
}: {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  runId: string;
  requestId?: string;
  allHookItems: HookInvocationQueueItem[];
  hooksNeedingCreation: HookInvocationQueueItem[];
  /** The log the suspension's replay read; its cursor is the hook delta's. */
  eventLog?: { cursor: string | null };
  forceClaimVictimWakes?: Set<string>;
  createGuarded: (
    data: CreateEventRequest,
    params?: CreateEventParams
  ) => Promise<EventResult>;
  /**
   * The creator for one hook's `hook_created`, in place of `createGuarded`;
   * `undefined` keeps `createGuarded`. Spec 8 creates independent concurrent
   * registrations without their catch-up position and reconciles their
   * responses together (see its `handleSuspension`).
   */
  hookCreateEvent?: (
    queueItem: HookInvocationQueueItem
  ) =>
    | ((
        data: CreateEventRequest,
        params?: CreateEventParams
      ) => Promise<EventResult>)
    | undefined;
  /** The spec version the hook events are stamped with. */
  eventSpecVersion: number;
  /** Awaited before the first hook write. */
  beforeWrites?: () => Promise<unknown>;
}): Promise<SuspensionHookWrites> {
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

  const blockers = {
    count: 0,
    sample: [] as SuspensionSerializationBlocker[],
  };
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
      blockers.count += stats.totalExecutions ?? stats.executions.length;
      blockers.sample.push(
        ...stats.executions
          .slice(0, GUEST_CODE_EXECUTION_SAMPLE_LIMIT - blockers.sample.length)
          .map((execution) => ({ ...context, ...execution }))
      );
    }
  }

  async function disposeHook(
    queueItem: HookInvocationQueueItem
  ): Promise<void> {
    const hookDisposedEvent: CreateEventRequest = {
      eventType: 'hook_disposed' as const,
      specVersion: eventSpecVersion,
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
          specVersion: eventSpecVersion,
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
          createEvent: hookCreateEvent?.(queueItem) ?? createGuarded,
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
        specVersion: eventSpecVersion,
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
          await beforeWrites?.();
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

  return {
    encryptionKey,
    compression,
    dehydrateInput,
    blockers,
    hookConflictCorrelationIds,
    awaitedHookCorrelationIds,
    hookOp,
    hookGroupsWindow: () => hookGroupsWindow,
  };
}
