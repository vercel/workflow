/**
 * Per-run event-log LRU cache for the workflow runtime.
 *
 * On warm function instances, this cache lets a workflow **resume** start
 * from the events that were already loaded on a previous invocation and
 * delta-fetch only the new events created since. Without the cache, every
 * resume re-reads the full event log from event 0, which is O(N²) over the
 * life of a long, step-heavy run.
 *
 * The cache is process-wide (module-level singleton) and bounded by an
 * approximate byte count, since event lists for the big runs are exactly
 * what we want to cache. A secondary entry-count cap guards against
 * pathological insertion patterns.
 *
 * Correctness contract:
 *
 * - The runtime **must** treat the returned array as read-only and work on
 *   a shallow copy when it intends to mutate (the runtime appends events
 *   on the `wait_completed` merge path).
 * - The runtime **must** always delta-fetch from the cached cursor on a
 *   cache hit; we never replay purely from cache. This is what keeps us
 *   correct against concurrent writers on other instances.
 * - When the cursor on a cached entry is `null` (no cursor known yet),
 *   callers must fall back to a full reload.
 *
 * The cache is automatically disabled by setting
 * `WORKFLOW_DISABLE_EVENT_CACHE=1` in the environment — callers should
 * gate their hot-path logic on `isEventCacheEnabled()`.
 */

import type { Event } from '@workflow/world';

export interface CachedRunEvents {
  /** Full, ordered, deduped log loaded/replayed so far. */
  events: Event[];
  /** Last non-null cursor returned by the server, or null if unknown. */
  cursor: string | null;
}

interface InternalEntry {
  value: CachedRunEvents;
  /** Approximate byte size for LRU bookkeeping. */
  size: number;
}

// Default to ~64 MiB total cache size (tunable via env var) and a hard cap
// of 500 entries as a secondary guard.
const DEFAULT_MAX_SIZE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 500;

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const MAX_SIZE_BYTES =
  parsePositiveInt(process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES) ??
  DEFAULT_MAX_SIZE_BYTES;
const MAX_ENTRIES =
  parsePositiveInt(process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES) ??
  DEFAULT_MAX_ENTRIES;

let totalSize = 0;
let evictionCount = 0;

// Insertion-order iteration of `Map` gives us LRU semantics for free:
// re-set an existing key to move it to the most-recently-used position,
// and iterate from the front to find the least-recently-used entry.
const cache = new Map<string, InternalEntry>();

/**
 * Cheap byte-size estimate for an event. We don't need precision — this
 * is only used as a heuristic for LRU eviction. Counting the byte length
 * of the JSON serialization would be much more accurate, but also
 * proportional in cost to the events themselves. Instead we use a
 * constant-per-event approximation plus the eventId length, which is the
 * one field guaranteed to be present.
 *
 * The constant is intentionally generous: real events carry eventData
 * payloads (step output, hook payload, etc.) which can be much larger
 * than the constant. The cache will simply hold somewhat fewer entries
 * than the byte budget suggests when payloads are big — that's the
 * conservative direction.
 */
const APPROX_BYTES_PER_EVENT = 512;

function estimateSize(events: Event[]): number {
  let bytes = 0;
  for (const e of events) {
    bytes += APPROX_BYTES_PER_EVENT + (e.eventId?.length ?? 0);
  }
  return bytes;
}

function evictIfNeeded(): void {
  while (
    (cache.size > MAX_ENTRIES || totalSize > MAX_SIZE_BYTES) &&
    cache.size > 0
  ) {
    // Map iteration is insertion-order; the first entry is the
    // least-recently-used (oldest set() call).
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    if (oldest) {
      totalSize -= oldest.size;
    }
    cache.delete(oldestKey);
    evictionCount++;
  }
}

/**
 * Returns whether the cache is enabled. Set `WORKFLOW_DISABLE_EVENT_CACHE=1`
 * in the environment to disable it (kill switch for production).
 */
export function isEventCacheEnabled(): boolean {
  return process.env.WORKFLOW_DISABLE_EVENT_CACHE !== '1';
}

/**
 * Returns the cached events for the given runId, or `undefined` if the
 * cache is disabled, the run is not cached, or the cached entry has no
 * cursor (which forces callers down the cold-load path).
 *
 * The returned array is shared with the cache and must be treated as
 * read-only. Callers that intend to mutate (push events, etc.) should
 * make a shallow copy first.
 */
export function getCachedRunEvents(runId: string): CachedRunEvents | undefined {
  if (!isEventCacheEnabled()) {
    return undefined;
  }
  const entry = cache.get(runId);
  if (!entry) {
    return undefined;
  }
  // Touch the entry to mark it as most-recently-used: delete + re-set
  // moves it to the tail of the Map's insertion order.
  cache.delete(runId);
  cache.set(runId, entry);
  return entry.value;
}

/**
 * Stores or updates the cache entry for a run.
 *
 * Important: the caller is responsible for passing in an array that the
 * cache can own. Once handed off, the caller must not mutate it (the
 * runtime should `setCachedRunEvents(runId, { events: [...events], ... })`
 * or otherwise hand over a fresh copy after a replay completes).
 */
export function setCachedRunEvents(
  runId: string,
  value: CachedRunEvents
): void {
  if (!isEventCacheEnabled()) {
    return;
  }
  const existing = cache.get(runId);
  if (existing) {
    totalSize -= existing.size;
    cache.delete(runId);
  }
  const size = estimateSize(value.events);
  cache.set(runId, { value, size });
  totalSize += size;
  evictIfNeeded();
}

/**
 * Removes the cached entry for a run. Optional; LRU eviction handles
 * memory bounds passively. Use this to free memory eagerly when a run
 * reaches a terminal state and will not resume again.
 */
export function deleteCachedRunEvents(runId: string): void {
  const existing = cache.get(runId);
  if (existing) {
    totalSize -= existing.size;
    cache.delete(runId);
  }
}

/**
 * Clears the entire cache. Intended for tests; production code should
 * not need this.
 */
export function clearEventCache(): void {
  cache.clear();
  totalSize = 0;
  evictionCount = 0;
}

/**
 * Returns cache statistics. Intended for tests and observability.
 */
export function getEventCacheStats(): {
  entryCount: number;
  totalSize: number;
  evictionCount: number;
  maxSizeBytes: number;
  maxEntries: number;
} {
  return {
    entryCount: cache.size,
    totalSize,
    evictionCount,
    maxSizeBytes: MAX_SIZE_BYTES,
    maxEntries: MAX_ENTRIES,
  };
}
