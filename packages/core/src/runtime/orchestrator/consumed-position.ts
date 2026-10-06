/**
 * The last position each run's orchestrator consumed in this process, so a
 * wake that finds nothing new can be acknowledged without a replay.
 *
 * Every out-of-band writer sends an unkeyed wake after it commits, and a live
 * orchestrator often consumes the event over the live feed before the wake is
 * delivered. That delivery then has nothing to do. It reads the log tail
 * (one small read), and when the tail slot equals the position recorded here
 * and no recorded timer is due, it exits. A miss (another process ran the
 * orchestrator, or this one restarted) costs only the normal replay.
 *
 * Recorded only after a delivery finished cleanly: its writes committed and
 * it scheduled what it had to (step messages, timers). A position recorded
 * before that would let a wake skip work the crashed delivery never did.
 */
export interface ConsumedPosition {
  /** Highest slot the orchestrator had consumed when it suspended. */
  slot: number;
  /** Earliest `resumeAt` among the run's open waits, epoch ms. */
  nextTimerAtMs?: number;
}

const MAX_ENTRIES = 10_000;
const positions = new Map<string, ConsumedPosition>();

export function recordConsumedPosition(
  runId: string,
  position: ConsumedPosition
): void {
  positions.delete(runId);
  positions.set(runId, position);
  if (positions.size > MAX_ENTRIES) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

export function hasConsumedPosition(runId: string): boolean {
  return positions.has(runId);
}

export function forgetConsumedPosition(runId: string): void {
  positions.delete(runId);
}

/**
 * Whether a delivery for `runId` whose log tail is at `tailSlot` has nothing
 * to do.
 */
export function isNoopDelivery(params: {
  runId: string;
  tailSlot: number | undefined;
  nowMs: number;
}): boolean {
  const recorded = positions.get(params.runId);
  if (!recorded || params.tailSlot === undefined) return false;
  if (params.tailSlot !== recorded.slot) return false;
  return (
    recorded.nextTimerAtMs === undefined ||
    recorded.nextTimerAtMs > params.nowMs
  );
}

/** Test hook. */
export function __resetConsumedPositionsForTests(): void {
  positions.clear();
}
