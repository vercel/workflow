/**
 * Consecutive in-band fence refusals per run in this process, so that a run
 * whose every pass is refused is reported at warn level instead of only at
 * info on each pass.
 *
 * One refusal is expected (an overlap the queue let through, or the World
 * sealing a slow writer's own position). Many in a row point at a World-side
 * fault or a pathological write latency: each pass sends a wake and
 * acknowledges, and on a coalescing World the wake folds back into the same
 * delivery, so nothing else surfaces the loop. Bounded: the oldest run is
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
