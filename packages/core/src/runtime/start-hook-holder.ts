import { WorkflowRunNotFoundError } from '@workflow/errors';
import type { WorkflowInvokePayload, World } from '@workflow/world';
import { getRunQueueNamespace } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { getWorkflowQueueName } from './helpers.js';

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
 * Re-publishes from one holder at most once per this window, whatever the
 * number of duplicates refused in it: the re-publish's queue idempotency key
 * is bucketed by it. It is deliberately not the original start message's
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
 * What a holder wake did: `woken` (re-published), `not_pending` (the holder
 * is running or ended), `too_young` (still within a normal startup),
 * `not_found` (no such run: the refusal named an accepted candidate whose run
 * was never created) or `error` (the check or the publish failed).
 */
export type StartHookHolderWakeResult =
  | 'woken'
  | 'not_pending'
  | 'too_young'
  | 'not_found'
  | 'error';

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
 * and swallowed. The caller still throws its `HookConflictError`. Each result
 * is logged with its reason: at debug when nothing needed doing, at info when
 * it woke the holder, at warn on an error.
 */
export async function wakePendingStartHookHolder(
  world: World,
  holderRunId: string,
  traceCarrier: Record<string, string>
): Promise<StartHookHolderWakeResult> {
  const skipped = (reason: 'not_pending' | 'too_young' | 'not_found') => {
    runtimeLogger.debug('Start Hook holder not woken', {
      workflowRunId: holderRunId,
      reason,
    });
    return reason;
  };
  try {
    const holder = await world.runs.get(holderRunId, { resolveData: 'none' });
    const nowMs = Date.now();
    if (holder.status !== 'pending') return skipped('not_pending');
    if (
      nowMs - new Date(holder.createdAt).getTime() <
      START_HOOK_HOLDER_WAKE_AFTER_MS
    ) {
      return skipped('too_young');
    }
    await world.queue(
      getWorkflowQueueName(
        holder.workflowName,
        getRunQueueNamespace(holder.executionContext)
      ),
      { runId: holder.runId, traceCarrier } satisfies WorkflowInvokePayload,
      {
        deploymentId: holder.deploymentId,
        ...(holder.specVersion !== undefined
          ? { specVersion: holder.specVersion }
          : {}),
        idempotencyKey: startHookHolderWakeKey(holder.runId, nowMs),
      }
    );
    runtimeLogger.info(
      'Re-published the orchestrator message of a start Hook holder stuck pending',
      { workflowRunId: holder.runId, reason: 'woken' }
    );
    return 'woken';
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return skipped('not_found');
    runtimeLogger.warn(
      'Could not check or wake the holder of a refused start Hook',
      {
        workflowRunId: holderRunId,
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return 'error';
  }
}
