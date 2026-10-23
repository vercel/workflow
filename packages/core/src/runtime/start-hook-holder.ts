import { WorkflowRunNotFoundError } from '@workflow/errors';
import type { WorkflowInvokePayload, World } from '@workflow/world';
import {
  getRunQueueNamespace,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { getWorkflowQueueName } from './helpers.js';
import { withRunSpecVersion } from './run-spec-routing.js';

/**
 * How long a start Hook's holder may stay `pending` before a refused
 * duplicate re-publishes its orchestrator message. A normal start is picked
 * up within seconds (a cold deployment within tens of seconds), so a holder
 * still pending past this has most likely lost its message: a boot crash
 * loop past the queue's retention, a message dropped after an uncertain
 * enqueue. Re-publishing sooner would only double a startup in flight.
 */
export const START_HOOK_HOLDER_WAKE_AFTER_MS = 60_000;

/**
 * Re-publishes from one spec-8 holder at most once per this window, whatever
 * the number of duplicates refused in it: the re-publish's queue idempotency
 * key is bucketed by it. (A spec-9 holder's wake carries no key.) It is deliberately not the original start message's
 * key, whose deduplication (up to 24h on Vercel Queues) would swallow a wake
 * for the very message that was lost.
 */
export const START_HOOK_HOLDER_WAKE_WINDOW_MS = 60_000;

/** The queue idempotency key for a holder's re-publish in this window. */
export function startHookHolderWakeKey(runId: string, nowMs: number): string {
  return `start-hook-wake-${runId}-${Math.floor(
    nowMs / START_HOOK_HOLDER_WAKE_WINDOW_MS
  )}`;
}

/**
 * A refused `start({ hook })` names the token's holder. When that holder is
 * a run still `pending` well past a normal startup, its first orchestrator
 * message was most likely lost and nothing else will start it, so the token
 * would stay held by a run that never runs. Re-publish a plain orchestrator
 * message for it (no `runInput`: the run exists), to its own deployment,
 * namespace and spec version, the same message a re-enqueue sends.
 *
 * Best effort and never in the caller's way: a holder that is not pending,
 * not old enough, or not found (a refusal can name an accepted candidate
 * whose run was never created) publishes nothing, and any failure is logged
 * and swallowed. The caller still throws its `HookConflictError`.
 */
export async function wakePendingStartHookHolder(
  world: World,
  holderRunId: string,
  traceCarrier: Record<string, string>
): Promise<'woken' | 'skipped'> {
  try {
    const holder = await world.runs.get(holderRunId, { resolveData: 'none' });
    const nowMs = Date.now();
    if (
      holder.status !== 'pending' ||
      nowMs - new Date(holder.createdAt).getTime() <
        START_HOOK_HOLDER_WAKE_AFTER_MS
    ) {
      return 'skipped';
    }
    await world.queue(
      getWorkflowQueueName(
        holder.workflowName,
        getRunQueueNamespace(holder.executionContext)
      ),
      // Stamped with the holder's spec version: a World that keys a
      // single-orchestrator run's messages (world-vercel's concurrency key)
      // reads it from the payload, not the send options.
      withRunSpecVersion(
        { runId: holder.runId, traceCarrier } satisfies WorkflowInvokePayload,
        holder.specVersion
      ),
      {
        deploymentId: holder.deploymentId,
        ...(holder.specVersion !== undefined
          ? { specVersion: holder.specVersion }
          : {}),
        // A spec-9 run's wakes carry no idempotency key (see
        // `QueueOptions.idempotencyKey`): its concurrency key already
        // coalesces concurrent refusals' wakes, and a key could be absorbed
        // by a delivery that is already exiting.
        ...((holder.specVersion ?? 0) < SPEC_VERSION_SINGLE_ORCHESTRATOR && {
          idempotencyKey: startHookHolderWakeKey(holder.runId, nowMs),
        }),
      }
    );
    runtimeLogger.info(
      'Re-published the orchestrator message of a start Hook holder stuck pending',
      { workflowRunId: holder.runId }
    );
    return 'woken';
  } catch (error) {
    if (!WorkflowRunNotFoundError.is(error)) {
      runtimeLogger.warn(
        'Could not check or wake the holder of a refused start Hook',
        {
          workflowRunId: holderRunId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
    return 'skipped';
  }
}
