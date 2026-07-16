import type { Event } from '@workflow/world';
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
 * Seconds left on an owned step's liveness lease, anchored at its latest
 * `step_started`. 0 means the lease has expired (or the start timestamp is
 * missing — the degraded mode for worlds whose events lack usable
 * timestamps), in which case dispatch falls back to the immediate enqueue.
 *
 * The result is clamped to the configured lease: `lastStartedAt` is the
 * server-stamped event `createdAt` while `nowMs` is the local clock, so a
 * client running behind the server would otherwise compute a remainder
 * LONGER than the lease itself — and with the lease tuned to the 900s cap,
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
  const leaseSeconds = getInlineOwnershipLeaseSeconds();
  const remainingMs = step.lastStartedAt + leaseSeconds * 1000 - nowMs;
  return Math.min(leaseSeconds, Math.max(0, Math.ceil(remainingMs / 1000)));
}

/**
 * Idempotency key for the delayed backstop wake of an inline-owned step.
 *
 * The key is scoped to the current OWNERSHIP EPOCH — the timestamp of the
 * latest `step_started` — not just the correlation ID. Within one epoch,
 * every wake replay derives the same key, so fan-out stays capped at one
 * pending backstop per step. But when owner recovery re-stamps the step
 * (queue redelivery of the owning message → new `step_started` → new
 * `lastStartedAt`), the key CHANGES. This is load-bearing for liveness:
 * queues dedupe an idempotency key for the lifetime of the original
 * message — including while a delivery of it is in flight — so a backstop
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
 * would absorb the retry — turning a 1s backoff into a full-lease stall.
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
  // semantics of the replay consumer in step.ts) — from that point the step
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
