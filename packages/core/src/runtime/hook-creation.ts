import {
  EntityConflictError,
  FatalError,
  RunExpiredError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  AttributeValidationError,
  type CreateEventParams,
  type CreateEventRequest,
  type EventResult,
  type World,
} from '@workflow/world';

import type { HookInvocationQueueItem } from '../global.js';
import { runtimeLogger } from '../logger.js';

import { publishForceClaimVictimWake } from './hook-wake.js';

/**
 * Writes one hook's `hook_created`, for either orchestrator's suspension: the
 * World answers a taken token with a `hook_conflict`, and a forced creation
 * that took the token over wakes the run it was taken from.
 */
export async function createHookEvent({
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
  /**
   * Hooks whose force-claim victim wake this invocation already sent (see
   * `forceClaimVictimWakes` on each orchestrator's `handleSuspension`).
   */
  forceClaimVictimWakes?: Set<string>;
  /**
   * Cursor to ask the World for the event-log delta against, or undefined to
   * not ask. See `hookDeltaCursor` in each orchestrator's `handleSuspension`
   * for when it is
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
 * Whether an `events.create` rejection is deterministic World validation
 * rather than a transient/storage error. Local Worlds
 * (world-local, world-postgres) throw `AttributeValidationError` directly;
 * remote Worlds surface the equivalent server-side rejection as a
 * `WorkflowWorldError` with HTTP status 400. The name check covers
 * `AttributeValidationError` instances from a different copy of
 * `@workflow/world` than the one this package resolved.
 */
export function isWorldValidationFailure(err: unknown): boolean {
  if (err instanceof AttributeValidationError) return true;
  if (err instanceof Error && err.name === 'AttributeValidationError') {
    return true;
  }
  return WorkflowWorldError.is(err) && err.status === 400;
}
