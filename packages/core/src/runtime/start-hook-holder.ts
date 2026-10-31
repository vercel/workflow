import { WorkflowRunNotFoundError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import type { WorkflowInvokePayload, World } from '@workflow/world';
import {
  getRunQueueNamespace,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
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
 * number of duplicates refused in it. For a holder before spec 9 the
 * re-publish's queue idempotency key is bucketed by it, which holds across
 * processes. It is deliberately not the original start message's key, whose
 * deduplication (up to 24h on Vercel Queues) would swallow a wake for the
 * very message that was lost. A single-orchestrator holder's wake carries no
 * key (see `wakePendingStartHookHolder`), so each process holds it to the
 * window instead (`singleOrchestratorWakes`).
 */
export const START_HOOK_HOLDER_WAKE_WINDOW_MS = 60_000;

/** The window a wake at `nowMs` falls in. */
function wakeWindow(nowMs: number): number {
  return Math.floor(nowMs / START_HOOK_HOLDER_WAKE_WINDOW_MS);
}

/**
 * The window of each single-orchestrator holder this process last woke. On
 * `globalThis` (see `globalSingleton`): one process must hold a holder to one
 * wake per window across every bundler layer that refuses a start.
 */
const singleOrchestratorWakes = globalSingleton(
  '@workflow/core//startHookHolderWakes',
  1,
  () => ({ byRunId: new Map<string, number>() })
);

/** Entries kept before the windows that have passed are dropped. */
const MAX_TRACKED_WAKES = 1_000;

/**
 * Claims this process's wake of a single-orchestrator holder for the window
 * of `nowMs`: false when this process already woke it in that window.
 */
function claimSingleOrchestratorWake(runId: string, nowMs: number): boolean {
  const { byRunId } = singleOrchestratorWakes;
  const window = wakeWindow(nowMs);
  if (byRunId.get(runId) === window) return false;
  if (byRunId.size >= MAX_TRACKED_WAKES) {
    for (const [id, woken] of byRunId) {
      if (woken < window) byRunId.delete(id);
    }
  }
  byRunId.set(runId, window);
  return true;
}

/** Gives back a claim whose publish failed. */
function releaseSingleOrchestratorWake(runId: string, nowMs: number): void {
  const { byRunId } = singleOrchestratorWakes;
  if (byRunId.get(runId) === wakeWindow(nowMs)) byRunId.delete(runId);
}

/** Forgets every claimed single-orchestrator wake. For tests. */
export function resetStartHookHolderWakes(): void {
  singleOrchestratorWakes.byRunId.clear();
}

/** The queue idempotency key for a holder's re-publish in this window. */
export function startHookHolderWakeKey(runId: string, nowMs: number): string {
  return `start-hook-wake-${runId}-${wakeWindow(nowMs)}`;
}

/**
 * What a holder wake did: `woken` (re-published), `not_pending` (the holder
 * is running or ended), `too_young` (still within a normal startup),
 * `throttled` (a single-orchestrator holder this process already woke in this
 * window), `not_found` (no such run: the refusal named an accepted candidate
 * whose run was never created) or `error` (the check or the publish failed).
 */
export type StartHookHolderWakeResult =
  | 'woken'
  | 'not_pending'
  | 'too_young'
  | 'throttled'
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
  const skipped = (
    reason: 'not_pending' | 'too_young' | 'throttled' | 'not_found'
  ) => {
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
    // A single-orchestrator run's orchestrator messages travel one at a time
    // on the run's own channel, which `runSpecVersion` routes to. A key would
    // also move the wake off that channel, so the window is held in process
    // instead: a holder whose deployment cannot boot would otherwise take a
    // wake, and its redeliveries, from every refused duplicate.
    const singleOrchestrator =
      (holder.specVersion ?? SPEC_VERSION_LEGACY) >=
      SPEC_VERSION_SINGLE_ORCHESTRATOR;
    if (
      singleOrchestrator &&
      !claimSingleOrchestratorWake(holder.runId, nowMs)
    ) {
      return skipped('throttled');
    }
    const publish = world.queue(
      getWorkflowQueueName(
        holder.workflowName,
        getRunQueueNamespace(holder.executionContext)
      ),
      {
        runId: holder.runId,
        traceCarrier,
        ...(singleOrchestrator
          ? { requestedAt: new Date(nowMs), runSpecVersion: holder.specVersion }
          : {}),
      } satisfies WorkflowInvokePayload,
      {
        deploymentId: holder.deploymentId,
        ...(holder.specVersion !== undefined
          ? { specVersion: holder.specVersion }
          : {}),
        ...(singleOrchestrator
          ? {}
          : { idempotencyKey: startHookHolderWakeKey(holder.runId, nowMs) }),
      }
    );
    // A failed publish gives the window back, so the next duplicate retries.
    await publish.catch((error: unknown) => {
      if (singleOrchestrator) {
        releaseSingleOrchestratorWake(holder.runId, nowMs);
      }
      throw error;
    });
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
