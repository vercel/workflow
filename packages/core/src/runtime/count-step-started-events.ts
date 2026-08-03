import type { Event } from '@workflow/world';

/**
 * Scope for {@link countStepStartedEvents}:
 * - `{ type: 'ownedBy', messageId }` counts only starts whose
 *   `eventData.ownerMessageId` matches — i.e. attempts performed by that
 *   owning queue message (inline lazy starts and owned-recovery re-stamps).
 * - `{ type: 'totalAttempts' }` estimates the step's genuine attempt total
 *   across its whole lifecycle: unstamped (bare) starts — which only real
 *   queue-dispatched background deliveries write — plus the starts of the
 *   single most-started owner. A genuine lifecycle has at most one inline
 *   owner phase (ownership is claimed atomically at step creation and
 *   lapses permanently at `step_retrying` or on any bare start), so taking
 *   the max over owners counts that phase's real attempts while invocations
 *   racing on the same batch — which stamp their own one-off message IDs —
 *   contribute at most their single largest count instead of accumulating.
 */
export type StepStartScope =
  | { type: 'ownedBy'; messageId: string }
  | { type: 'totalAttempts' };

const ownerOf = (e: Event): string | undefined =>
  'eventData' in e &&
  e.eventData &&
  'ownerMessageId' in e.eventData &&
  typeof e.eventData.ownerMessageId === 'string'
    ? e.eventData.ownerMessageId
    : undefined;

/**
 * Number of `step_started` events already recorded for a step, used as the
 * authoritative attempt count for the maxRetries ceiling (the only bound for
 * steps that time out without writing a `step_failed`).
 *
 * IMPORTANT: the raw (unscoped) count is NOT a reliable attempt number.
 * Concurrent invocations racing on the same pending batch (stale replays,
 * wake replays, a step message dispatched by a replay that lost the
 * create-claim race, ...) can each write a `step_started` for the same
 * logical attempt — worlds without an atomic start guard (world-local) let
 * all of them through. Counting those duplicates as "attempts" made the
 * maxRetries ceiling fire on healthy runs and fail them with a false
 * "exceeded max retries" (see workflow#3069).
 *
 * Callers therefore scope the count to the starts their ceiling is actually
 * about via `scope`:
 * - the inline owned-recovery ceiling counts only THIS message's starts
 *   (`ownedBy`) — each real (re)delivery of the owning message stamps its
 *   `ownerMessageId` on the start it writes, while racing invocations stamp
 *   their own IDs (or none), so they no longer inflate the count;
 * - the background-step ceiling counts the lifecycle attempt total
 *   (`totalAttempts`: bare starts plus the largest single owner's starts) —
 *   so a step that exhausted part of its budget under inline ownership
 *   before transitioning to queued/bare retries still trips the combined
 *   ceiling, while racers' one-off stamped duplicates don't accumulate, and
 *   throttle/too-early redeliveries (which write no start at all) stay
 *   excluded as before.
 */
export function countStepStartedEvents(
  events: Event[] | null | undefined,
  stepId: string,
  scope?: StepStartScope
): number {
  if (!events) {
    return 0;
  }
  let bare = 0;
  const byOwner = new Map<string, number>();
  for (const e of events) {
    if (e.eventType !== 'step_started' || e.correlationId !== stepId) {
      continue;
    }
    const owner = ownerOf(e);
    if (owner === undefined) {
      bare++;
    } else {
      byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
    }
  }
  if (scope === undefined) {
    let total = bare;
    for (const count of byOwner.values()) {
      total += count;
    }
    return total;
  }
  if (scope.type === 'ownedBy') {
    return byOwner.get(scope.messageId) ?? 0;
  }
  // totalAttempts
  let maxOwner = 0;
  for (const count of byOwner.values()) {
    if (count > maxOwner) {
      maxOwner = count;
    }
  }
  return bare + maxOwner;
}
