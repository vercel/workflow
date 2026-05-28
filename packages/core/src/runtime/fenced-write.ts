/**
 * Helper for "branch-decision" event writes that need OCC fencing.
 *
 * Applies the same fence-and-retry pattern the elapsed-wait scan uses for
 * `wait_completed` to every other write whose outcome depends on a branch
 * decision the workflow VM made from its loaded event log:
 *
 *   suspension-handler.ts:
 *     - step_created
 *     - hook_created
 *     - hook_disposed
 *     - wait_created
 *
 *   runtime.ts terminal writes:
 *     - run_completed
 *     - run_failed
 *
 * `hook_received` is deliberately NOT fenced: fencing the user's signal
 * would drop it on contention; stale-snapshot protection belongs on the
 * writes that consume hooks, not the writes that deliver them.
 *
 * Each fenced write tries up to MAX_FENCE_RETRIES times. On a fence
 * conflict, the caller is expected to refresh `fenceEventId` from a fresh
 * event log read. The `onConflictRefresh` callback gives the caller a
 * chance to do that, and to decide whether to give up (e.g. when an
 * idempotency check confirms the write is no longer needed).
 */
import { EntityConflictError } from '@workflow/errors';
import type { CreateEventRequest, World } from '@workflow/world';
import { runtimeLogger } from '../logger.js';

const MAX_FENCE_RETRIES = 5;

/**
 * Returns true when an EntityConflictError carries the fence-conflict
 * shape. Anything else with a 409/410/etc shape is some other kind of
 * conflict (entity already exists, run already terminal, hook token taken)
 * that the caller's existing handlers want to keep dealing with.
 *
 * TODO: switch to a typed error class once the wire format exposes one.
 */
function isFenceConflict(err: unknown): boolean {
  return (
    EntityConflictError.is(err) &&
    typeof err.message === 'string' &&
    /fence conflict/i.test(err.message)
  );
}

export interface FencedWriteParams {
  world: World;
  runId: string;
  event: CreateEventRequest;
  requestId?: string;
  /**
   * Caller-provided fence value. Pass `undefined` for the first attempt
   * if no fence has been observed yet (e.g. on a fresh resume); the
   * helper will then issue an unfenced write — which still atomically
   * advances `run.lastKnownEventId` on the server side so future fenced
   * writers see the materialized value.
   *
   * After a successful fenced write, the caller should update its
   * tracked fence to the returned `newFenceEventId`.
   */
  fenceEventId: string | undefined;
  /**
   * Called when the server rejects the write with a fence conflict.
   * Implementations should:
   *  1. Reload events from the cursor.
   *  2. Check whether the write is still necessary (e.g. wait_completed
   *     idempotency — if the event already exists in the reloaded log,
   *     return `'abort'` so we don't retry pointlessly).
   *  3. Return `{ kind: 'retry', fenceEventId: <fresh-tail> }` to retry
   *     against the new tail, or `{ kind: 'abort' }` to give up.
   *
   * Receives the attempt number (1-indexed) so backoff can be tuned by
   * the caller if it wants.
   */
  onConflictRefresh: (
    attempt: number
  ) => Promise<
    { kind: 'retry'; fenceEventId: string | undefined } | { kind: 'abort' }
  >;
  /**
   * Called when the server rejects with a *non-fence* EntityConflictError
   * (e.g. the entity already exists because a concurrent handler beat us
   * to it). Returning `'abort'` is the typical answer — the existing
   * handlers in suspension-handler / runtime already log + skip. Returning
   * `'rethrow'` re-throws so the caller can deal with it.
   */
  onEntityConflict: (err: EntityConflictError) => 'abort' | 'rethrow';
}

export interface FencedWriteResult {
  /** Whether the event was actually written (false = aborted via dedup). */
  written: boolean;
  /**
   * eventId of the newly-written event (when `written` is true), so
   * the caller can advance its tracked fence value.
   */
  newFenceEventId?: string;
  /**
   * The server's response event, when `written` is true. Allows callers
   * to read fields like the resolved eventType (e.g. `hook_conflict`
   * instead of `hook_created` when the server detected a token clash).
   */
  event?: { eventType: string; eventId: string };
}

/**
 * Issues `world.events.create(runId, event, { requestId, lastKnownEventId })`
 * with up to MAX_FENCE_RETRIES retries on fence conflict.
 *
 * On any non-fence EntityConflictError, defers to `onEntityConflict` for
 * the abort-vs-rethrow decision (preserves the existing
 * "EntityConflictError → log and skip" behavior for callers that want it).
 */
export async function fencedEventCreate(
  params: FencedWriteParams
): Promise<FencedWriteResult> {
  const {
    world,
    runId,
    event,
    requestId,
    onConflictRefresh,
    onEntityConflict,
  } = params;
  let fenceEventId = params.fenceEventId;
  let attempt = 0;
  // biome-ignore lint/correctness/noConstantCondition: bounded by MAX_FENCE_RETRIES
  while (true) {
    try {
      const result = await world.events.create(runId, event, {
        requestId,
        ...(fenceEventId ? { lastKnownEventId: fenceEventId } : {}),
      });
      return {
        written: true,
        newFenceEventId: result.event?.eventId ?? fenceEventId,
        event: result.event
          ? {
              eventType: result.event.eventType,
              eventId: result.event.eventId,
            }
          : undefined,
      };
    } catch (err) {
      if (isFenceConflict(err)) {
        attempt += 1;
        if (attempt > MAX_FENCE_RETRIES) {
          runtimeLogger.warn(
            'Branch-decision write gave up after fence retries',
            {
              workflowRunId: runId,
              eventType: event.eventType,
              correlationId: event.correlationId,
              attempts: attempt,
            }
          );
          throw err;
        }
        const decision = await onConflictRefresh(attempt);
        if (decision.kind === 'abort') {
          return { written: false };
        }
        fenceEventId = decision.fenceEventId;
        await new Promise((r) => setTimeout(r, 25 * attempt));
        continue;
      }
      if (EntityConflictError.is(err)) {
        const decision = onEntityConflict(err);
        if (decision === 'abort') {
          return { written: false };
        }
        throw err;
      }
      throw err;
    }
  }
}
