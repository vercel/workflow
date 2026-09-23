import { HookNotFoundError, WorkflowRuntimeError } from '@workflow/errors';
import {
  type Event,
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

/**
 * The forced hook creation whose victim wake this run still owes, if any: the
 * forced `hook_created` is the last event the run's own replay appended.
 *
 * A forced creation is followed by a wake of the run it took the token from.
 * If the invocation died between the two, the creation is in the log and the
 * victim was never told; the row itself is the durable record of that debt.
 * As long as it is the last event THIS RUN wrote, the run has made no progress
 * since, so the invocation that should have woken the victim did not finish,
 * and the replay republishes (under the hook's idempotency key, so a wake that
 * did go out is not duplicated). The first event the run appends after it
 * ends the republishing.
 *
 * "This run wrote" matters: a delivery appends `hook_received` to this log
 * from another request, a sealed-log World appends `noop`, and a LATER
 * claimer taking the token from this run appends
 * `hook_disposed{forceClaimedBy}`. None is progress of this run — the model
 * (`ForceWakeOnce.cfg`'s sibling trace) has a delivery land between the crash
 * and the retry, and a rule that looked at the bare tail would then never
 * wake the victim. The foreign disposal is the chain case: this run took the
 * token from A, died before waking A, and was itself taken from by C. Its own
 * wake (from C) is the very invocation that must repay A's — the run's own
 * `hook_disposed` (a `dispose()` in its code) IS its progress and still ends
 * the debt, but a row another run put here does not. Both engines call this
 * on the log they loaded for the invocation, before writing anything.
 *
 * Reading only the last own row is sound because both engines keep every
 * other write of the invocation off that tail until the wake is out: a token
 * group holding a forced creation runs first, one group at a time, publishing
 * its wake before its next write, and nothing else is dispatched until those
 * groups have settled. Were a sibling hook's creation (or, in QuickJS, a step
 * or wait) allowed to land concurrently, a crash before the publish would
 * leave that row last and hide the debt.
 */
export function forcedCreationOwingWake(
  events: readonly Event[] | undefined
): (Event & { eventType: 'hook_created' }) | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.eventType === 'hook_received' ||
      event.eventType === 'noop' ||
      (event.eventType === 'hook_disposed' &&
        event.eventData?.forceClaimedBy !== undefined)
    ) {
      continue;
    }
    return event.eventType === 'hook_created' &&
      event.eventData.forceClaimedFrom !== undefined
      ? event
      : undefined;
  }
  return undefined;
}

/**
 * Republish the wake {@link forcedCreationOwingWake} says is owed. Shared by
 * the node:vm suspension handler and the QuickJS entrypoint so the two engines
 * cannot drift on the durability contract.
 */
export async function republishOwedForceClaimVictimWake(
  world: World,
  runId: string,
  events: readonly Event[] | undefined
): Promise<void> {
  const owed = forcedCreationOwingWake(events);
  if (!owed) return;
  const claimedFrom = owed.eventData.forceClaimedFrom as HookClaimedFrom;
  const outcome = await publishForceClaimVictimWake(world, runId, {
    hookId: owed.correlationId,
    claimedFrom,
  });
  if (outcome !== 'skipped') {
    runtimeLogger.info('Republished the wake of a force-claimed hook victim', {
      workflowRunId: runId,
      hookId: owed.correlationId,
      victimRunId: claimedFrom.runId,
      victimWake: outcome,
    });
  }
}
