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
 * nothing of the claimer's is wrong, every later replay of the claimer inside
 * the republish window tries again ({@link forcedCreationsOwingWake}), and
 * the victim reads the row on its next invocation for any reason. The
 * idempotency key is the claimer's hook id, so those republishes collapse
 * into one wake.
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
 * How long after a forced `hook_created` a replay of the claimer keeps
 * republishing its victim's wake: 24 hours, measured from the row's
 * `createdAt`.
 *
 * The bound has to outlast every redelivery of the invocation that journaled
 * the creation, because that redelivery is the replay that must repay a wake
 * the invocation died before publishing. A queue message is retained for 24
 * hours from its send and the creation is written after the send, so any such
 * redelivery arrives within 24 hours of the creation. The same 24 hours is the
 * Vercel queue's idempotency window (`min(retention, 24h)`), so every
 * republish inside it collapses, under `hook-force-claim-<hookId>`, into the
 * one wake that was (or now is) delivered. Past it a republish would be a
 * genuinely new message, which is what the bound saves. world-postgres
 * remembers a completed key in-process to the same effect; world-local
 * dedupes a key only while its message is in flight, so there a republish can
 * deliver the victim one more replay, which reads nothing new.
 */
export const FORCE_CLAIM_WAKE_REPUBLISH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The forced hook creations whose victim wake this run may still owe: every
 * forced `hook_created` (one carrying `forceClaimedFrom`) in the log whose
 * `createdAt` is within {@link FORCE_CLAIM_WAKE_REPUBLISH_WINDOW_MS} of
 * `nowMs`.
 *
 * A forced creation is followed by a wake of the run it took the token from.
 * If the invocation died between the two, the creation is in the log and the
 * victim was never told; the row itself is the durable record of that debt,
 * and nothing records that the wake went out. So the replay does not try to
 * infer it: it republishes for every recent forced creation, and the hook's
 * idempotency key collapses a wake that did go out (a duplicate that slips
 * past a World's dedupe is one harmless replay of the victim).
 *
 * The rule reads nothing written after the creation, which is what makes it
 * sound. Any row can land between the creation and the wake: a step, wait,
 * attribute or other hook row the same suspension writes concurrently
 * (neither engine holds those for the wake), a step or wait terminal from
 * another invocation, a delivery's `hook_received`, a sealed-log `noop`, or a
 * later claimer's `hook_disposed{forceClaimedBy}` taking the token from this
 * run. None of them says the wake was published. The last is the chain case:
 * this run took the token from A, died before waking A, and was taken from by
 * C; C's wake of this run is the invocation that repays A's.
 *
 * The time is the row's `createdAt`, never one decoded from its event id (a
 * slot-numbered id carries none). Under slot identity it is the writer's
 * client clock, clamped by the World to at most an hour ahead of its own, so
 * skew moves the window's edge by at most that much; a creation dated ahead of
 * `nowMs` counts as recent, and one whose time cannot be read is treated as
 * recent too, erring toward a wake rather than a stranded victim.
 */
export function forcedCreationsOwingWake(
  events: readonly Event[] | undefined,
  nowMs: number = Date.now()
): (Event & { eventType: 'hook_created' })[] {
  const owed: (Event & { eventType: 'hook_created' })[] = [];
  if (!events) return owed;
  for (const event of events) {
    if (
      event.eventType !== 'hook_created' ||
      event.eventData?.forceClaimedFrom === undefined
    ) {
      continue;
    }
    const createdAtMs = new Date(event.createdAt).getTime();
    if (
      Number.isNaN(createdAtMs) ||
      nowMs - createdAtMs < FORCE_CLAIM_WAKE_REPUBLISH_WINDOW_MS
    ) {
      owed.push(event);
    }
  }
  return owed;
}

/**
 * Republish the wakes {@link forcedCreationsOwingWake} says may be owed.
 * Shared by the node:vm suspension handler and the QuickJS entrypoint so the
 * two engines cannot drift on the durability contract.
 *
 * `alreadyWoken` is the invocation's record of the hooks whose victim wake it
 * has already published or attempted, the forced creations it made itself
 * included: an engine that replays more than once per invocation passes the
 * same set every time, so each hook costs one send per invocation. Hooks this
 * call publishes are added to it.
 *
 * Self-claims and victims with no recorded `workflowName` are skipped
 * silently: the creating invocation already logged the latter, and a replay
 * repeating it would say nothing new. Never rejects; a publish that fails
 * after its retries is logged, and the next replay inside the window tries
 * again.
 */
export async function republishOwedForceClaimVictimWakes(
  world: World,
  runId: string,
  events: readonly Event[] | undefined,
  options: { alreadyWoken?: Set<string>; nowMs?: number } = {}
): Promise<void> {
  const { alreadyWoken } = options;
  const owed = forcedCreationsOwingWake(events, options.nowMs).filter(
    (event) => {
      const from = event.eventData.forceClaimedFrom as HookClaimedFrom;
      return (
        from.runId !== runId &&
        from.workflowName !== undefined &&
        !alreadyWoken?.has(event.correlationId)
      );
    }
  );
  if (owed.length === 0) return;
  await Promise.all(
    owed.map(async (event) => {
      alreadyWoken?.add(event.correlationId);
      const claimedFrom = event.eventData.forceClaimedFrom as HookClaimedFrom;
      const outcome = await publishForceClaimVictimWake(world, runId, {
        hookId: event.correlationId,
        claimedFrom,
      });
      runtimeLogger.debug(
        'Republished the wake of a force-claimed hook victim',
        {
          workflowRunId: runId,
          hookId: event.correlationId,
          victimRunId: claimedFrom.runId,
          victimWake: outcome,
        }
      );
    })
  );
}
