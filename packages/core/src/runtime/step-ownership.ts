import type { Event } from '@workflow/world';
import { SPEC_VERSION_SUPPORTS_SLOT_IDENTITY } from '@workflow/world';
import type { StepInvocationQueueItem } from '../global.js';
import { getInlineOwnershipLeaseSeconds } from './constants.js';

/**
 * Inline step ownership helpers for the pending-step dispatch decision table
 * in runtime.ts (workflow#2780). Ownership state itself is derived per-replay
 * from the event log by the step consumer in step.ts and surfaced on
 * StepInvocationQueueItem; these functions interpret that state at dispatch
 * time.
 */

/**
 * Whether inline step ownership is active for a pending step: created,
 * latest `step_started` carries an owner stamp, and no `step_retrying` has
 * been observed (from `step_retrying` on, the step is queue-owned by its
 * delayed retry handoff / replay requeue, so ownership is permanently
 * lapsed for the correlation ID).
 */
export function isStepOwnershipActive(step: StepInvocationQueueItem): boolean {
  return (
    step.hasCreatedEvent === true &&
    step.ownerMessageId !== undefined &&
    step.sawRetrying !== true
  );
}

/**
 * Lowest run `specVersion` whose runtime is known to stamp `ownerMessageId`
 * on every inline `step_started`. Ownership stamps shipped in
 * vercel/workflow#2848 while runs were still minted at spec version 5, so a
 * spec-5 run may predate them; spec version 6 (slot identity, #3389) shipped
 * after, so every runtime that mints a spec-6+ run also stamps its inline
 * starts. A run's spec version is fixed at `start()` and its deliveries are
 * pinned to one deployment, so within a run the runtime is one version: the
 * run's spec version stands for the version of every start in its log.
 */
export const QUEUE_OWNED_RUNNING_MIN_SPEC_VERSION =
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY;

/**
 * Whether a pending step is queue-owned and running: created, its latest
 * `step_started` is bare (unstamped, so written by a queue delivery of the
 * step message rather than by an inline owner), and no `step_retrying` has
 * been observed. Such a step's body is being executed by a queue consumer
 * that has not acked its message. On a World whose queue redelivers unacked
 * messages (`capabilities.queueRedeliversUnacked`) that message is the
 * step's crash recovery, so a replay need not re-enqueue it and arms a
 * delayed backstop wake instead (see the dispatch loop in runtime.ts).
 *
 * A bare start only PROVES a queue delivery on a run whose runtime stamps
 * inline starts: the replay contract tolerates an unstamped inline start
 * from an older runtime (step.ts), and treating one as queue-owned would
 * delay a dead inline step's recovery by a lease. So the predicate also
 * requires `runSpecVersion >= QUEUE_OWNED_RUNNING_MIN_SPEC_VERSION`; older
 * or unknown runs keep the immediate re-enqueue.
 *
 * `step_retrying` excludes the step deliberately, mirroring
 * {@link isStepOwnershipActive}: from there the step rides its delayed retry
 * handoff, which stays on the immediate re-enqueue path. The two predicates
 * are mutually exclusive, since ownership requires a stamped start.
 */
export function isQueueOwnedRunning(
  step: StepInvocationQueueItem,
  runSpecVersion: number | undefined
): boolean {
  return (
    runSpecVersion !== undefined &&
    runSpecVersion >= QUEUE_OWNED_RUNNING_MIN_SPEC_VERSION &&
    step.hasCreatedEvent === true &&
    step.lastStartedAt !== undefined &&
    step.ownerMessageId === undefined &&
    step.sawRetrying !== true
  );
}

/**
 * Seconds left on a liveness lease anchored at `startedAtMs`, with the same
 * rounding and clamp as {@link stepLeaseRemainingSeconds}.
 */
export function leaseRemainingSeconds(
  startedAtMs: number,
  nowMs: number
): number {
  const leaseSeconds = getInlineOwnershipLeaseSeconds();
  const remainingMs = startedAtMs + leaseSeconds * 1000 - nowMs;
  return Math.min(leaseSeconds, Math.max(0, Math.ceil(remainingMs / 1000)));
}

/**
 * Idempotency key for a run's queue-owned backstop wake: ONE delayed run
 * continuation per replay pass covering every queue-owned running step seen
 * in that pass, delayed to the latest of their lease expiries.
 *
 * The key is scoped to the run plus that latest bare-start timestamp (the
 * run's queue-ownership epoch), for the reasons {@link backstopIdempotencyKey}
 * gives per step: replays of an unchanged log derive the same key, so
 * concurrent invocations collapse onto one pending wake server-side, and
 * the invocation itself skips the send outright once it has armed an epoch
 * (see the dispatch loop). A later bare start moves the epoch and so the
 * key, which is what keeps the new step covered: a wake keyed to a coarser
 * window would be deduped against the one already in flight while firing
 * BEFORE the new step's lease expires, and a window wide enough to always
 * fire after it would exceed the queue's per-message delay cap that
 * `stepLeaseRemainingSeconds` clamps to. The timestamp is the persisted
 * event's `createdAt`, so every replayer derives the same key.
 */
export function queueOwnedBackstopIdempotencyKey(
  runId: string,
  latestStartedAtMs: number
): string {
  return `${runId}:queue-backstop:${latestStartedAtMs}`;
}

/**
 * Seconds left on an owned step's liveness lease, anchored at its latest
 * `step_started`. 0 means the lease has expired (or the start timestamp is
 * missing, the degraded mode for worlds whose events lack usable
 * timestamps), in which case dispatch falls back to the immediate enqueue.
 *
 * The result is clamped to the configured lease: `lastStartedAt` is the
 * server-stamped event `createdAt` while `nowMs` is the local clock, so a
 * client running behind the server would otherwise compute a remainder
 * LONGER than the lease itself, and with the lease tuned to the 900s cap,
 * a `delaySeconds` above the queue's per-message maximum, which SQS-backed
 * worlds reject outright (the wake replay's enqueue would throw and ride
 * the redelivery loop). The clamp makes skew strictly harmless; remaining
 * time can never legitimately exceed the full lease anyway.
 */
export function stepLeaseRemainingSeconds(
  step: StepInvocationQueueItem,
  nowMs: number
): number {
  if (step.lastStartedAt === undefined) return 0;
  return leaseRemainingSeconds(step.lastStartedAt, nowMs);
}

/**
 * Idempotency key for the delayed backstop wake of an inline-owned step.
 *
 * The key is scoped to the current OWNERSHIP EPOCH (the timestamp of the
 * latest `step_started`), not just the correlation ID. Within one epoch,
 * every wake replay derives the same key, so fan-out stays capped at one
 * pending backstop per step. But when owner recovery re-stamps the step
 * (queue redelivery of the owning message → new `step_started` → new
 * `lastStartedAt`), the key CHANGES. This is load-bearing for liveness:
 * queues dedupe an idempotency key for the lifetime of the original
 * message (including while a delivery of it is in flight), so a backstop
 * that fires during a refreshed lease and tries to re-arm under a fixed key
 * would dedupe against ITSELF and be dropped, leaving no escape hatch if
 * the recovered owner later dies without further redeliveries. The epoch
 * suffix gives the re-arm a fresh key. Pending backstops are bounded by the
 * number of ownership epochs, i.e. the queue's redelivery budget for the
 * owning message.
 *
 * The epoch value comes from the persisted event's `createdAt`, so every
 * replayer derives the same key. Callers only build backstops when the
 * lease has time remaining, which requires `lastStartedAt` to be set.
 *
 * The key must also never be the step message's own `idempotencyKey`
 * (the bare correlation ID): the owner's retry handoff enqueues the step
 * under that key with a short backoff, and a pending backstop sharing it
 * would absorb the retry, turning a 1s backoff into a full-lease stall.
 */
export function backstopIdempotencyKey(step: StepInvocationQueueItem): string {
  return `${step.correlationId}:backstop:${step.lastStartedAt}`;
}

/**
 * Whether any of the given pending correlation IDs is inline-owned by
 * `messageId` per the raw event log: its LATEST `step_started` carries
 * `ownerMessageId === messageId` and no `step_retrying` follows it. Used by
 * the background-step fast path, which sees raw events (not the replay's
 * queueItems), to decide whether to fall through to the main loop so this
 * invocation can recover a step it owns instead of returning and leaving it
 * to the delayed backstop.
 */
export function hasPendingStepOwnedByMessage(
  events: Event[],
  pendingCorrelationIds: Set<string | undefined>,
  messageId: string
): boolean {
  // Latest-wins scan: events are in log order, so later entries overwrite.
  // A step_retrying lapses ownership permanently (matching the sawRetrying
  // semantics of the replay consumer in step.ts): from that point the step
  // is queue-owned, whatever starts follow.
  const latestOwner = new Map<string, string | undefined>();
  const sawRetrying = new Set<string>();
  for (const e of events) {
    if (e.correlationId === undefined) continue;
    if (e.eventType === 'step_started') {
      const owner =
        'eventData' in e &&
        e.eventData &&
        'ownerMessageId' in e.eventData &&
        typeof e.eventData.ownerMessageId === 'string'
          ? e.eventData.ownerMessageId
          : undefined;
      latestOwner.set(e.correlationId, owner);
    } else if (e.eventType === 'step_retrying') {
      sawRetrying.add(e.correlationId);
    }
  }
  for (const id of pendingCorrelationIds) {
    if (
      id !== undefined &&
      !sawRetrying.has(id) &&
      latestOwner.get(id) === messageId
    ) {
      return true;
    }
  }
  return false;
}
