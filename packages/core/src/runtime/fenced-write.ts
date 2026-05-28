/**
 * Helper for "branch-decision" event writes that need OCC fencing.
 *
 * Used by the writes whose outcome depends on a branch decision the
 * workflow VM made from its loaded event log:
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
 * On a fence conflict, this helper **bails the current write** rather
 * than retrying in place. A fence conflict means some other invocation
 * has already advanced the event log past our snapshot, so the work
 * implied by our snapshot is either already done or will be done by
 * whoever advanced the log. Retrying in place caused two problems:
 *
 *  1. Under high contention (e.g. a hook flood firing many concurrent
 *     ticks), the retry loop became a stuck-fence spin: lambdas would
 *     spend their budget retrying against an ever-changing tail and
 *     either succeed by luck or exhaust MAX_FENCE_RETRIES and throw.
 *     A thrown EntityConflictError surfaces as `run_failed` (a
 *     transient infra issue mis-classified as terminal failure).
 *
 *  2. The retries-against-the-same-fence shape, paired with the
 *     server-side patch-then-PUT non-atomicity, made stuck-fence runs
 *     measurably worse: every retry attempt against an already-advanced
 *     fence is wasted compute, and the spin keeps the run stuck
 *     longer in the affected-runs-per-stress-cycle window.
 *
 * The simpler model matches Peter's existing workflow-server comment
 * ("the @workflow/core suspension handler swallows it"): a fence
 * conflict signals "another replay is canonical; this one isn't" —
 * exit cleanly, trust the canonical replay, no error, no retry, no
 * re-enqueue.
 */
import { EntityConflictError } from '@workflow/errors';
import type { CreateEventRequest, World } from '@workflow/world';
import { runtimeLogger } from '../logger.js';

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
   */
  fenceEventId: string | undefined;
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
  /**
   * Whether the event was actually written.
   *
   * `false` covers two cases the caller usually wants to treat the same
   * way (no further action required for this write):
   *  - Fence conflict — another invocation has the canonical view.
   *  - Non-fence EntityConflictError with `onEntityConflict: 'abort'`
   *    (entity already exists, run already terminal, etc.).
   */
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
 * once. On fence conflict, returns `{ written: false }` immediately
 * (no retry, no throw, no re-enqueue) — see the file-level comment for
 * the reasoning.
 *
 * On any non-fence EntityConflictError, defers to `onEntityConflict` for
 * the abort-vs-rethrow decision (preserves the existing
 * "EntityConflictError → log and skip" behavior for callers that want it).
 */
export async function fencedEventCreate(
  params: FencedWriteParams
): Promise<FencedWriteResult> {
  const { world, runId, event, requestId, fenceEventId, onEntityConflict } =
    params;
  try {
    const result = await world.events.create(runId, event, {
      requestId,
      ...(fenceEventId ? { lastKnownEventId: fenceEventId } : {}),
    });
    // The server response schema marks `event` as optional for legacy
    // compatibility. In practice creates always return the persisted
    // event, but if it's missing we keep the caller's fence at its
    // prior value rather than silently advancing to a value we didn't
    // observe on the wire.
    if (!result.event) {
      runtimeLogger.warn(
        'Branch-decision write missing event in response; keeping prior fence',
        {
          workflowRunId: runId,
          eventType: event.eventType,
          correlationId: event.correlationId,
          fenceEventId,
        }
      );
    }
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
      // Another invocation has the canonical view of the event log.
      // Bail out cleanly: no retry, no throw. The canonical invocation
      // is responsible for whatever progress the workflow needs.
      runtimeLogger.info(
        'Branch-decision write fence conflict; yielding to canonical replay',
        {
          workflowRunId: runId,
          eventType: event.eventType,
          correlationId: event.correlationId,
        }
      );
      return { written: false };
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
