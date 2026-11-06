/**
 * Consecutive in-band fence refusals per run in this process, so that a run
 * whose every pass is refused is reported at warn level instead of only at
 * info on each pass.
 *
 * One refusal is expected (an overlap the queue let through, or the World
 * sealing a slow writer's own position). Many in a row point at a World-side
 * fault or a pathological write latency: each pass asks for a redelivery of
 * its message, and nothing else surfaces the loop until the delivery cap
 * fails the run (on a World that counts such a redelivery as an attempt).
 * Bounded: the oldest run is
 * forgotten past {@link MAX_TRACKED_RUNS}.
 */
// per-copy-ok: a diagnostic streak of one run's deliveries, which run in the
// copy of the orchestrator module that handles the run's queue route. A
// streak split across copies only delays the warning.
const refusals = new Map<string, number>();

/** Consecutive refusals of one run after which a refusal is logged at warn. */
export const REPEATED_FENCE_REFUSAL_WARN_THRESHOLD = 3;

const MAX_TRACKED_RUNS = 1_000;

/** Records one refusal of `runId`'s delivery; returns the run's streak. */
export function noteFenceRefusal(runId: string): number {
  const count = (refusals.get(runId) ?? 0) + 1;
  refusals.delete(runId);
  refusals.set(runId, count);
  if (refusals.size > MAX_TRACKED_RUNS) {
    const oldest = refusals.keys().next().value;
    if (oldest !== undefined) refusals.delete(oldest);
  }
  return count;
}

/** Ends `runId`'s streak: one of its deliveries finished without a refusal. */
export function clearFenceRefusals(runId: string): void {
  refusals.delete(runId);
}

/**
 * Whether a streak of `count` refusals is logged at warn: at the threshold,
 * then at every power of two above it, so a long loop logs O(log n) lines.
 */
export function warnsOnFenceRefusal(count: number): boolean {
  if (count < REPEATED_FENCE_REFUSAL_WARN_THRESHOLD) return false;
  return (
    count === REPEATED_FENCE_REFUSAL_WARN_THRESHOLD ||
    (count & (count - 1)) === 0
  );
}

/**
 * The delay of the redelivery a fence-refused orchestrator delivery asks for
 * (`{ timeoutSeconds }`) instead of acknowledging its message: long enough
 * for a second delivery of the message that is still running to commit or
 * fail, short enough that a refusal no other delivery explains costs about
 * a second.
 */
export const FENCE_REFUSAL_REDELIVERY_SECONDS = 1;
