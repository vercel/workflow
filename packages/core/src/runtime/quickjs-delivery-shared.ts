/**
 * What both orchestrators' QuickJS deliveries share (`spec8/quickjs-entrypoint.ts`,
 * `spec9/quickjs-entrypoint.ts`): snapshot latches, log listing and small helpers.
 */
/**
 * QuickJS WebAssembly (WASM) VM integration with the Workflow DevKit.
 *
 * This module provides the entry point for running workflows in the
 * QuickJS VM engine instead of the `node:vm` engine. Both engines
 * implement the same event-replay execution model, where every invocation:
 *
 * 1. Loads the full event log for the run
 * 2. Runs the workflow function from the top in a fresh QuickJS VM,
 *    replaying the event log to resolve awaited primitives
 * 3. On suspension: creates events + queues steps for new pending ops
 * 4. On completion: creates run_completed
 * 5. On failure: creates run_failed
 */

import { globalSingleton } from '@workflow/utils';

import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
} from '@workflow/world';

import { REPLAY_RESOLVE_DATA } from './helpers.js';

import { QuickJSLogView } from './quickjs-log-view.js';

import { MAX_SNAPSHOT_PLAINTEXT_BYTES } from './quickjs-snapshot-codec.js';

import type { getWorld } from './world.js';

/**
 * Runs whose heap exceeded {@link MAX_SNAPSHOT_PLAINTEXT_BYTES} at some
 * suspension. WASM linear memory never shrinks, so a run that crossed
 * the ceiling once will exceed it at EVERY later suspension — without
 * this latch each of those would re-pay `session.snapshot()` (two full
 * copies of the heap) just to discard the result. Process-local by
 * design: the warm instance replaying the same run repeatedly is where
 * the repeated cost lives; a cold instance pays one probe and re-latches.
 * Bounded defensively (a process rarely sees many distinct oversized
 * runs).
 */
export const oversizedSnapshotRuns = globalSingleton(
  '@workflow/core//quickjsOversizedSnapshotRuns',
  1,
  () => new Set<string>()
);

export const OVERSIZED_SNAPSHOT_RUNS_MAX = 1024;

/**
 * Runs this process has observed with a log still below the snapshot
 * threshold at the end of an invocation, and no snapshot restored or
 * saved. A snapshot is only ever saved once a run's log has reached the
 * threshold (the save gate counts every event the saving VM processed),
 * so for these runs the next invocation's `snapshots.load` would be a
 * guaranteed miss: an awaited round-trip on the resume's critical path
 * that short runs, by design, should never pay. The next invocation in
 * this process skips the probe instead.
 *
 * Staleness is safe in the only direction it can go: another instance may
 * have grown the log past the threshold and saved a snapshot since, and
 * skipping the load then costs one full replay (always correct). That
 * invocation sees a log at or above the threshold and clears the entry,
 * so the next one probes again. Bounded like the oversized latch.
 */
export const runsBelowSnapshotThreshold = globalSingleton(
  '@workflow/core//quickjsRunsBelowSnapshotThreshold',
  1,
  () => new Set<string>()
);

export const RUNS_BELOW_SNAPSHOT_THRESHOLD_MAX = 4096;

export const snapshotWarnings = globalSingleton(
  '@workflow/core//quickjsSnapshotWarnings',
  1,
  () => new Set<string>()
);

/** Tiny ms timer using performance.now(), already monotonic on Node. */
export function tick(): number {
  return performance.now();
}

/** An `events.create` bound to the run; see `dispatchPendingOps.createEvent`. */
export type EventCreator = (
  data: CreateEventRequest,
  params?: CreateEventParams
) => Promise<EventResult>;

/**
 * Returns true when the supplied preloaded events indicate this is the
 * first workflow handler invocation for the run, i.e. the log contains
 * nothing beyond `run_created` / `run_started`. In that case the
 * preloaded events ARE the complete event log and the `events.list`
 * round-trips can be skipped entirely.
 *
 * Crucially, if the world backfilled a missing `run_created` via the
 * resilient start path, `preloadedEvents` contains it even when a fresh
 * `events.list` might not (eventual consistency), so preferring the
 * preloaded events on first invocation is also the more correct choice.
 *
 * Returns false when `preloadedEvents` is missing/empty so the caller
 * falls back to the normal fetch path.
 *
 * Exported for unit testing.
 */
export function isFirstInvocation(
  preloadedEvents: readonly Event[] | undefined
): boolean {
  if (!Array.isArray(preloadedEvents) || preloadedEvents.length === 0) {
    return false;
  }
  return preloadedEvents.every(
    (e) => e.eventType === 'run_created' || e.eventType === 'run_started'
  );
}

export function latchOversizedSnapshotRun(runId: string): void {
  if (oversizedSnapshotRuns.size >= OVERSIZED_SNAPSHOT_RUNS_MAX) {
    oversizedSnapshotRuns.clear();
  }
  oversizedSnapshotRuns.add(runId);
}

export function noteSnapshotThresholdProgress(
  runId: string,
  belowThreshold: boolean
): void {
  if (!belowThreshold) {
    runsBelowSnapshotThreshold.delete(runId);
    return;
  }
  if (runsBelowSnapshotThreshold.size >= RUNS_BELOW_SNAPSHOT_THRESHOLD_MAX) {
    runsBelowSnapshotThreshold.clear();
  }
  runsBelowSnapshotThreshold.add(runId);
}

/** Test-only: forget the process-local snapshot latches. */
export function __resetSnapshotLatchesForTests(): void {
  oversizedSnapshotRuns.clear();
  runsBelowSnapshotThreshold.clear();
}

/**
 * Run a workflow using the QuickJS WASM VM engine.
 *
 * This replaces the `node:vm` replay path (runWorkflow + EventsConsumer)
 * with a QuickJS VM invocation that performs the same full event replay.
 *
 * Log position on writes. This engine follows the same rule as the node:vm
 * replay loop for which writes tell the World where the writer stood (see the
 * "Who names a position" table above `slotSnapshotParams` in `helpers.ts`):
 *
 * - Writes made from this invocation's view of the log (`step_created`,
 *   `wait_created`, `hook_created`, `hook_disposed`, `attr_set`, the abort
 *   `hook_received`, `wait_completed`, and the `step_created` + `step_failed`
 *   pair for an unserializable input) carry `eventCount`, and the page a
 *   World hands back is queued for the live VM through {@link QuickJSLogView}.
 * - A single inline step's terminal write asks for the inline delta
 *   (`sinceCursor`) through `executeStep`, and so does a lone `hook_created`
 *   (see `dispatchPendingOps.deltaCursor`); the delta is queued the same
 *   way. The step executor's other writes carry nothing: it holds no log.
 * - Run-terminal writes (`run_completed`, `run_failed`) and the terminal drain
 *   of pending ops carry nothing: nothing reads the log afterwards.
 *
 * What differs from the node engine is what "merge into the log" means. The
 * node engine merges a returned page into the array it replays from. This
 * engine holds a live VM that consumes events exactly once, in position
 * order, so a returned page is queued and delivered ahead of the next
 * `events.list`, which then only runs when the queue cannot account for the
 * next position. Both engines fall back to a list for anything a page did
 * not carry.
 */
/**
 * Read a run's event log in order from `cursor` (the start when `null`) to
 * its end. Returns the events, the cursor after the last page (`cursor` when
 * nothing new was read), and how many pages it took.
 */
export async function listRunLogFrom(
  world: Awaited<ReturnType<typeof getWorld>>,
  runId: string,
  cursor: string | null
): Promise<{
  events: Event[];
  cursor: string | null;
  pages: number;
  /** Whether every returned event is covered by the returned cursor. */
  covered: boolean;
}> {
  const events: Event[] = [];
  let pages = 0;
  let covered = true;
  let hasMore = true;
  while (hasMore) {
    const response = await world.events.list({
      runId,
      pagination: {
        sortOrder: 'asc',
        cursor: cursor ?? undefined,
        limit: 1000,
      },
      resolveData: REPLAY_RESOLVE_DATA,
    });
    pages++;
    events.push(...response.data);
    // Only move on a page that returned a cursor: the final empty page
    // returns `null`, which would reset the read position.
    if (response.cursor) {
      cursor = response.cursor;
    } else if (response.data.length > 0) {
      covered = false;
    }
    hasMore = response.data.length > 0 && response.cursor != null;
  }
  return { events, cursor, pages, covered };
}

/** Log a snapshot-configuration warning once per process per key. */
export function warnOnce(key: string, log: () => void): void {
  if (snapshotWarnings.has(key)) return;
  snapshotWarnings.add(key);
  log();
}
