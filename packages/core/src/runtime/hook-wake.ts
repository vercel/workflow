import { HookNotFoundError, WorkflowRuntimeError } from '@workflow/errors';
import {
  type Hook,
  type HookClaimedFrom,
  SPEC_VERSION_LEGACY,
  type WorkflowInvokePayload,
  type World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';

import { getWorkflowQueueName } from './helpers.js';

const HOOK_WAKE_RETRY_DELAYS_MS = [25, 100] as const;

/**
 * A wake failure worth retrying is transport-shaped (network error, 5xx,
 * throttle). A definitive rejection will not change on a 25ms retry, so
 * spending the budget on it only delays the caller's error.
 *
 * `@vercel/queue` errors carry no `status` field — they are bare `Error`
 * subclasses distinguished by `name` — so classification checks the World's
 * deployment-unavailable hook first (a deployment the queue cannot discover
 * will not come back within this function's ~125ms budget), then a numeric
 * status when one exists (non-Vercel queue implementations), then the queue
 * client's definitive-4xx error names.
 */
export function isRetryableWakeError(
  error: unknown,
  isDeploymentUnavailableError?: (error: unknown) => boolean
): boolean {
  if (isDeploymentUnavailableError?.(error)) return false;
  const status = (error as { status?: unknown; statusCode?: unknown }) ?? {};
  const code = status.status ?? status.statusCode;
  if (typeof code === 'number') {
    return code >= 500 || code === 408 || code === 429;
  }
  const name = (error as Error | null)?.name;
  return (
    name !== 'BadRequestError' &&
    name !== 'UnauthorizedError' &&
    name !== 'ForbiddenError'
  );
}

/**
 * Publish a workflow wake, retrying transport-shaped failures.
 *
 * A publish may succeed even when its response is lost, so a retry can
 * enqueue a duplicate wake. That is harmless: the event the wake exists to
 * deliver is already durable, and deterministic replay makes a second
 * delivery of the same run a no-op.
 */
export async function publishHookWakeWithRetry(
  publish: () => Promise<unknown>,
  isDeploymentUnavailableError?: (error: unknown) => boolean
): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= HOOK_WAKE_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    try {
      await publish();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableWakeError(error, isDeploymentUnavailableError)) break;
      const delayMs = HOOK_WAKE_RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // The wake only runs after the hook_received write committed, so a wake
  // failure here is necessarily "durable but not yet dispatched": the event
  // survives, and any later wake of the run delivers it. Do not let a queue
  // implementation reuse HookNotFoundError and accidentally imply that no
  // hook_received exists.
  if (HookNotFoundError.is(lastError)) {
    throw new WorkflowRuntimeError(
      'The hook resume was committed, but its workflow wake could not be published',
      { cause: lastError }
    );
  }
  throw lastError;
}

/**
 * Wake the run a force-claimed hook took its token from.
 *
 * The takeover left a `hook_disposed{forceClaimedBy}` in that run's log, and
 * a run suspended on `await hook` reads it only when something invokes it.
 * The World cannot publish that wake (it has no queue), so the claimer's
 * runtime does, right after its `hook_created` returns, from the victim's
 * `workflowName` / `deploymentId` the World recorded on `hook.claimedFrom`.
 *
 * Same durability contract as `resumeHook()`'s wake: the row is durable
 * before this runs, the publish is retried on transport-shaped failures, and
 * a publish that still fails is logged rather than failing the claimer —
 * nothing of the claimer's is wrong, and the victim reads the row on its
 * next invocation for any reason. The idempotency key is the claimer's hook
 * id, so a claimer retrying its creation republishes at most one wake.
 *
 * Skipped when the victim is the claimer itself (a run taking over its own
 * earlier hook is already running) and when the World recorded no
 * `workflowName` for the victim (a legacy hook; nothing to address a queue
 * message to).
 */
export async function publishForceClaimVictimWake(
  world: World,
  claimerRunId: string,
  hook: Pick<Hook, 'hookId' | 'claimedFrom'>
): Promise<'published' | 'skipped' | 'failed'> {
  const from: HookClaimedFrom | undefined = hook.claimedFrom;
  if (!from || from.runId === claimerRunId) return 'skipped';
  if (from.workflowName === undefined) {
    runtimeLogger.warn(
      'Force-claimed a hook from a run whose workflow name is unknown; not waking it',
      { workflowRunId: claimerRunId, victimRunId: from.runId }
    );
    return 'skipped';
  }
  try {
    await publishHookWakeWithRetry(
      () =>
        world.queue(
          getWorkflowQueueName(from.workflowName as string),
          { runId: from.runId } satisfies WorkflowInvokePayload,
          {
            ...(from.deploymentId !== undefined && {
              deploymentId: from.deploymentId,
            }),
            specVersion: from.runSpecVersion ?? SPEC_VERSION_LEGACY,
            idempotencyKey: `hook-force-claim-${hook.hookId}`,
          }
        ),
      world.isDeploymentUnavailableError?.bind(world)
    );
    return 'published';
  } catch (error) {
    runtimeLogger.error(
      'Force-claimed a hook token but could not wake the run it was taken from; it will read the disposal on its next invocation',
      {
        workflowRunId: claimerRunId,
        victimRunId: from.runId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return 'failed';
  }
}
