/**
 * Round-trip savings for QuickJS resumes of snapshotted runs.
 *
 * A resume of a snapshotted run used to pay three round trips one after the
 * other: the setup request (`run_started`, or the lazy hook `hook_received`)
 * streamed the whole log, then the engine read the snapshot, then it listed
 * the log again from the snapshot's cursor. Two things here remove the last
 * two from the critical path:
 *
 * - {@link prefetchQuickJSSnapshot}: the snapshot read depends on nothing but
 *   the run id, so when this process already knows the engine will read it,
 *   the queue handler starts the read at handler entry and it overlaps the
 *   setup request.
 * - {@link sliceSnapshotDelta}: the setup request already returned the log
 *   the second list would read, so the engine takes the events after the
 *   snapshot's position out of it instead of listing them again.
 *
 * Kept out of `quickjs-entrypoint.ts` on purpose: the handler consults it on
 * every delivery, before it knows which engine the run uses, and the
 * entrypoint's import chain embeds the QuickJS WASM binary.
 */
import { globalSingleton } from '@workflow/utils';
import {
  type Event,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  type SnapshotMetadata,
  type World,
} from '@workflow/world';

/** What `experimental_snapshots.load` resolves to. */
export type LoadedSnapshot = {
  data: Uint8Array;
  metadata: SnapshotMetadata;
} | null;

/**
 * Runs whose next QuickJS invocation in this process will read snapshot
 * storage: the engine saw the run suspend with snapshotting on and its log at
 * or past the threshold, or restored a snapshot for it. This is exactly the
 * condition under which the engine's own load gate would probe, so a prefetch
 * keyed on it only moves a read the engine was going to make earlier; it does
 * not add one.
 *
 * Staleness costs at most one read in either direction. A run another
 * instance finished keeps its entry here until this process sees it again,
 * and that delivery's prefetch reads a snapshot nothing uses. A run another
 * instance pushed past the threshold is absent, and its next resume here
 * reads the snapshot after setup, as before.
 *
 * Process-wide on purpose (see the module-scope-state rule in AGENTS.md): the
 * queue handler that reads it and the engine that writes it can sit in
 * different bundler copies of this module. Bounded like the engine's other
 * snapshot latches.
 */
const runsAtSnapshotThreshold = globalSingleton(
  '@workflow/core//quickjsRunsAtSnapshotThreshold',
  1,
  () => new Set<string>()
);
const RUNS_AT_SNAPSHOT_THRESHOLD_MAX = 4096;

/** The engine will read this run's snapshot on its next invocation. */
export function noteRunAtSnapshotThreshold(runId: string): void {
  if (runsAtSnapshotThreshold.has(runId)) return;
  if (runsAtSnapshotThreshold.size >= RUNS_AT_SNAPSHOT_THRESHOLD_MAX) {
    runsAtSnapshotThreshold.clear();
  }
  runsAtSnapshotThreshold.add(runId);
}

/** The engine will not read this run's snapshot (below threshold, or done). */
export function forgetRunAtSnapshotThreshold(runId: string): void {
  runsAtSnapshotThreshold.delete(runId);
}

/** Test-only: forget every run. */
export function __resetSnapshotPrefetchForTests(): void {
  runsAtSnapshotThreshold.clear();
}

/**
 * Whether resumes may read a snapshot ahead of their setup request.
 * `WORKFLOW_SNAPSHOT_PREFETCH=0` (or `false`) is the kill switch.
 */
export function isSnapshotPrefetchEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.WORKFLOW_SNAPSHOT_PREFETCH?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/**
 * Start reading the run's snapshot now, when this process knows the QuickJS
 * engine will read it during this delivery. Returns `undefined` otherwise.
 *
 * The returned promise never rejects unobserved: a failure is handed to the
 * engine, which treats it exactly like a failed load of its own (a full
 * replay), and a delivery that never reaches the engine drops it.
 */
export function prefetchQuickJSSnapshot(
  world: Pick<World, 'experimental_snapshots'>,
  runId: string
): Promise<LoadedSnapshot> | undefined {
  const storage = world.experimental_snapshots;
  if (
    !storage ||
    !isSnapshotPrefetchEnabled() ||
    !runsAtSnapshotThreshold.has(runId)
  ) {
    return undefined;
  }
  let pending: Promise<LoadedSnapshot>;
  try {
    pending = Promise.resolve(storage.load(runId));
  } catch (err) {
    pending = Promise.reject(err);
  }
  pending.catch(() => {});
  return pending;
}

/**
 * The events of a complete, top-of-log preload that a snapshot covering the
 * first `eventCount` events of the log has not consumed: what
 * `events.list` from the snapshot's cursor would return. `undefined` when
 * the preload cannot prove where the snapshot ends, and the caller lists.
 *
 * A snapshot persists its position as a cursor plus the number of log events
 * through that cursor, so the delta starts at index `eventCount` of a listing
 * from the top. That count is only trusted against the preload's own slot
 * numbers: every event up to and including the boundary must sit at the slot
 * its index implies, so the preload's first `eventCount` events are exactly
 * slots `1..eventCount`, with no gap a missing event could hide in. Returns
 * `undefined` when:
 *
 * - the ids are not slot-numbered (an older World or a mock), so nothing can
 *   be verified;
 * - the preload is shorter than the snapshot, i.e. the snapshot was saved
 *   after the preload was read (a concurrent invocation advanced the run);
 * - any id up to the boundary is out of place.
 */
export function sliceSnapshotDelta(
  preloaded: readonly Event[],
  eventCount: number
): Event[] | undefined {
  if (!Number.isSafeInteger(eventCount) || eventCount < 0) return undefined;
  if (preloaded.length < eventCount) return undefined;
  // Check through the first delta event too: it must be the next slot, or
  // the delta would start past an event the snapshot never saw.
  const checkThrough = Math.min(preloaded.length, eventCount + 1);
  for (let index = 0; index < checkThrough; index++) {
    const eventId = preloaded[index]?.eventId;
    if (
      typeof eventId !== 'string' ||
      eventIdToSlot(eventId) !== FIRST_EVENT_SLOT + index
    ) {
      return undefined;
    }
  }
  return preloaded.slice(eventCount);
}
