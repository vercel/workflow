import type { World } from '@workflow/world';

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
  /**
   * The run reached a terminal state in this process (see
   * {@link recordTerminalRun}): no later delivery has anything to do.
   */
  terminal?: true;
}

const MAX_ENTRIES = 10_000;
// Held per World instance: a position is only meaningful against the log of
// the World it was read from.
// per-copy-ok: a second copy of this module only misses positions the first
// recorded, which costs a normal replay and never skips work.
const positionsByWorld = new WeakMap<object, Map<string, ConsumedPosition>>();
function positionsFor(world: object): Map<string, ConsumedPosition> {
  let positions = positionsByWorld.get(world);
  if (!positions) {
    positions = new Map();
    positionsByWorld.set(world, positions);
  }
  return positions;
}

export function recordConsumedPosition(
  world: World,
  runId: string,
  position: ConsumedPosition
): void {
  const positions = positionsFor(world);
  positions.delete(runId);
  positions.set(runId, position);
  if (positions.size > MAX_ENTRIES) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

/**
 * Records that the run reached a terminal state (an orchestrator of this
 * process committed or read its terminal event). A run never leaves a
 * terminal state, and an orchestrator delivery of a terminal run returns
 * once it has read the run, so a later delivery (a timer the run armed
 * before it ended, a step outcome's wake) may return without reading
 * anything ({@link isTerminalRun}).
 */
export function recordTerminalRun(world: World, runId: string): void {
  recordConsumedPosition(world, runId, { slot: 0, terminal: true });
}

/** Whether this process recorded the run as terminal. */
export function isTerminalRun(world: World, runId: string): boolean {
  return positionsFor(world).get(runId)?.terminal === true;
}

export function hasConsumedPosition(world: World, runId: string): boolean {
  return positionsFor(world).has(runId);
}

export function forgetConsumedPosition(world: World, runId: string): void {
  positionsFor(world).delete(runId);
}

/**
 * Whether a delivery for `runId` whose log tail is at `tailSlot` has nothing
 * to do.
 */
export function isNoopDelivery(params: {
  world: World;
  runId: string;
  tailSlot: number | undefined;
  nowMs: number;
}): boolean {
  const recorded = positionsFor(params.world).get(params.runId);
  if (recorded?.terminal) return true;
  if (!recorded || params.tailSlot === undefined) return false;
  if (params.tailSlot !== recorded.slot) return false;
  return (
    recorded.nextTimerAtMs === undefined ||
    recorded.nextTimerAtMs > params.nowMs
  );
}

/**
 * Waits whose `wait_completed` an orchestrator of this process committed, by
 * run and correlation id, so that the wait's own timer, delivered after the
 * delivery completed the wait in process, can be acknowledged without a
 * replay (see {@link isCompletedWaitTimer}). Bounded to the
 * {@link MAX_ENTRIES} newest; a miss costs only the normal replay.
 */
// per-copy-ok: a second copy of this module only misses completions the first
// recorded, which costs a normal replay and never skips work.
const completedWaitsByWorld = new WeakMap<object, Set<string>>();
const completedWaitKey = (runId: string, correlationId: string) =>
  `${runId}\u0000${correlationId}`;

export function recordCompletedWait(
  world: World,
  runId: string,
  correlationId: string
): void {
  let completed = completedWaitsByWorld.get(world);
  if (!completed) {
    completed = new Set();
    completedWaitsByWorld.set(world, completed);
  }
  const key = completedWaitKey(runId, correlationId);
  completed.delete(key);
  completed.add(key);
  if (completed.size > MAX_ENTRIES) {
    const oldest = completed.values().next().value;
    if (oldest !== undefined) completed.delete(oldest);
  }
}

/**
 * Whether a timer delivery is the final timer of a wait this process already
 * completed. Such a timer has nothing left to do for its wait: the wait's
 * `wait_completed` is in the log, and the delivery that committed it armed
 * the next timer of the wait's chain before the commit. So it may take the
 * no-op check a plain wake takes ({@link isNoopDelivery}), which still reads
 * the log tail for anything else the delivery may carry. An intermediate hop
 * (`resumeAtMs` set) is never one: it only sends the next hop.
 */
export function isCompletedWaitTimer(
  world: World,
  runId: string,
  waitContinuation: { correlationId: string; resumeAtMs?: number }
): boolean {
  if (waitContinuation.resumeAtMs !== undefined) return false;
  return (
    completedWaitsByWorld
      .get(world)
      ?.has(completedWaitKey(runId, waitContinuation.correlationId)) ?? false
  );
}

/** Test hook. */
export function __resetConsumedPositionsForTests(world: World): void {
  positionsFor(world).clear();
  completedWaitsByWorld.get(world)?.clear();
}
