/**
 * Cross-invocation event-log prefix cache: the client half of the tail-only
 * preload.
 *
 * Every wake of a running run (a sleep or hook wake, an inline-budget
 * reinvoke, a redelivery) loads the run's whole log through the `run_started`
 * or lazy `hook_received` preload, even when this process held most of it
 * from the previous invocation a moment earlier. This cache keeps, per run,
 * the dense prefix of the log the last invocation replayed over, and offers
 * it to the World on the next preload (`CreateEventParams.preloadPrefix`). A
 * World that declares `eventLogPrefixPreload` turns it into a claim its
 * backend verifies; when the backend honors it, only the tail crosses the
 * wire and the World hands the runtime the same log a full load would have.
 *
 * The rules for what may be cached are the ones model-checked in
 * workflow-server `specs/LogPrefixCache.tla` (and `docs/log-prefix-cache.md`):
 *
 * - only the maximal DENSE prefix from slot 1, with slot 1 present
 *   (`CacheDenseOnly`; the client's own write can sit above a young hole, and
 *   the backend's slot-N anchor cannot see a hole below N);
 * - only from an invocation whose FIRST load held `run_started`
 *   (`StartInFirstLoad`; a wedged invocation that read `[run_created]` alone
 *   must never cache that row once a reset rewrites it);
 * - `run_started` inside the prefix (`StartInPrefix`, what the SDK ships);
 * - only events a World load returned (preload, list, inline delta, skipped
 *   slot report), never an event built locally or read off a write response;
 * - only sealed-log runs (spec >= 7), whose slot ids the backend can check.
 *
 * The backend's checks (version, retention, sealed log, anchor) are its own,
 * so a stale or wrong entry costs a refused claim and a full load, never a
 * wrong replay. The entry is evicted on a terminal run, a slot-gap trip, a
 * failed preload, and idle expiry; LRU-by-bytes bounds the whole cache.
 *
 * Holds events as the World returned them: payloads are the ciphertext the
 * backend stored, never plaintext (decryption happens later, per invocation,
 * in the replay payload cache).
 *
 * Per-process state lives on `globalThis` (`globalSingleton`) so every bundled
 * copy of `@workflow/core` in one process shares one cache and one budget.
 */
import { globalSingleton } from '@workflow/utils';
import {
  type Event,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  isTerminalRunEventType,
  type PreloadPrefix,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
} from '@workflow/world';

/** Kill switch / opt-in. Default OFF; `1` or `true` enables. */
export const EVENT_LOG_PREFIX_CACHE_ENV = 'WORKFLOW_EVENT_LOG_PREFIX_CACHE';
/** Process-wide byte budget across all runs. */
export const EVENT_LOG_PREFIX_CACHE_MAX_BYTES_ENV =
  'WORKFLOW_EVENT_LOG_PREFIX_CACHE_MAX_BYTES';
/** Smallest cached prefix worth claiming. */
export const EVENT_LOG_PREFIX_CACHE_MIN_BYTES_ENV =
  'WORKFLOW_EVENT_LOG_PREFIX_CACHE_MIN_BYTES';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MIN_BYTES = 16 * 1024;
/** Entries idle longer than this are dropped on access. */
export const EVENT_LOG_PREFIX_CACHE_IDLE_TTL_MS = 5 * 60_000;
/** Fixed per-event overhead added to its payload bytes in the estimate. */
const EVENT_OVERHEAD_BYTES = 256;

export function isEventLogPrefixCacheEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env[EVENT_LOG_PREFIX_CACHE_ENV];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function readBytes(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export interface EventLogPrefixCacheLimits {
  /** Total budget. An entry may use at most a quarter of it. */
  maxBytes: number;
  /** Prefixes estimated below this are not offered (the claim saves little). */
  minBytes: number;
  idleTtlMs: number;
}

export function eventLogPrefixCacheLimits(
  env: Record<string, string | undefined> = process.env
): EventLogPrefixCacheLimits {
  return {
    maxBytes: readBytes(
      env,
      EVENT_LOG_PREFIX_CACHE_MAX_BYTES_ENV,
      DEFAULT_MAX_BYTES
    ),
    minBytes: readBytes(
      env,
      EVENT_LOG_PREFIX_CACHE_MIN_BYTES_ENV,
      DEFAULT_MIN_BYTES
    ),
    idleTtlMs: EVENT_LOG_PREFIX_CACHE_IDLE_TTL_MS,
  };
}

/** Rough in-memory size of an event: its binary/string payload fields. */
export function estimateEventBytes(event: Event): number {
  let bytes = EVENT_OVERHEAD_BYTES;
  const data = (event as { eventData?: unknown }).eventData;
  if (data && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (value instanceof Uint8Array) bytes += value.byteLength;
      else if (typeof value === 'string') bytes += value.length;
    }
  }
  return bytes;
}

/**
 * A detached copy of an event: its own object and its own `eventData`
 * object, so neither the cache nor an invocation can see the other's
 * property writes. Payload bytes are shared; nothing writes into them.
 */
function copyEvent(event: Event): Event {
  const data = (event as { eventData?: unknown }).eventData;
  return (
    data && typeof data === 'object'
      ? { ...event, eventData: { ...(data as object) } }
      : { ...event }
  ) as Event;
}

/**
 * The prefix of `events` the fill rules allow caching, in slot order, or
 * undefined when none is: a non-slot id anywhere (a ULID run), no
 * `run_created` at slot 1, a run below the sealed log, no `run_started` in
 * the dense run from slot 1, or a terminal run event anywhere in the log.
 *
 * Order-independent: logs are assembled from pages, deltas and reports, and
 * only slot numbers say where an event sits.
 */
export function cacheablePrefix(
  events: readonly Event[]
): readonly Event[] | undefined {
  const bySlot = new Map<number, Event>();
  for (const event of events) {
    const slot = eventIdToSlot(event.eventId);
    if (slot === null) return undefined;
    if (isTerminalRunEventType(event.eventType)) return undefined;
    bySlot.set(slot, event);
  }
  const runCreated = bySlot.get(FIRST_EVENT_SLOT);
  if (
    runCreated?.eventType !== 'run_created' ||
    typeof runCreated.specVersion !== 'number' ||
    runCreated.specVersion < SPEC_VERSION_SUPPORTS_SEALED_LOG
  ) {
    return undefined;
  }
  const prefix: Event[] = [];
  let sawRunStarted = false;
  for (
    let slot = FIRST_EVENT_SLOT, event = bySlot.get(slot);
    event !== undefined;
    event = bySlot.get(++slot)
  ) {
    if (event.eventType === 'run_started') sawRunStarted = true;
    prefix.push(event);
  }
  return sawRunStarted ? prefix : undefined;
}

interface Entry {
  readonly events: readonly Event[];
  readonly bytes: number;
  lastUsedAt: number;
}

interface CacheState {
  /** Insertion order is LRU order: a hit re-inserts. */
  readonly entries: Map<string, Entry>;
  totalBytes: number;
}

const sharedState = globalSingleton(
  '@workflow/core//eventLogPrefixCache',
  1,
  (): CacheState => ({ entries: new Map(), totalBytes: 0 })
);

export type EventLogPrefixFillOutcome =
  | 'filled'
  | 'kept_longer'
  | 'ineligible'
  | 'too_large'
  | 'evicted_terminal';

/** The process-wide cache. Every method is synchronous and never throws. */
export class EventLogPrefixCache {
  private constructor(
    private readonly state: CacheState,
    private readonly limits: () => EventLogPrefixCacheLimits
  ) {}

  /** The cache shared by every copy of `@workflow/core` in this process. */
  static shared(): EventLogPrefixCache {
    return new EventLogPrefixCache(sharedState, eventLogPrefixCacheLimits);
  }

  /** A private cache, for tests. */
  static isolated(limits: Partial<EventLogPrefixCacheLimits> = {}) {
    return new EventLogPrefixCache(
      { entries: new Map(), totalBytes: 0 },
      () => ({
        ...eventLogPrefixCacheLimits({}),
        ...limits,
      })
    );
  }

  get size(): number {
    return this.state.entries.size;
  }

  get totalBytes(): number {
    return this.state.totalBytes;
  }

  /**
   * The prefix to offer on this run's next preload, as fresh copies (the
   * caller owns the array and every event in it), or undefined when there is
   * no live entry worth claiming. Concurrent invocations of one run each get
   * their own copy of the same immutable entry.
   */
  offer(runId: string, now = Date.now()): PreloadPrefix | undefined {
    const entry = this.state.entries.get(runId);
    if (!entry) return undefined;
    const limits = this.limits();
    if (now - entry.lastUsedAt > limits.idleTtlMs) {
      this.evict(runId);
      return undefined;
    }
    entry.lastUsedAt = now;
    this.state.entries.delete(runId);
    this.state.entries.set(runId, entry);
    if (entry.bytes < limits.minBytes) return undefined;
    return { events: entry.events.map(copyEvent) };
  }

  /**
   * Record the prefix of `events` the fill rules allow. `firstLoadHeldRunStarted`
   * is the invocation's `StartInFirstLoad` bit. A shorter prefix than the one
   * already cached is not stored: both are prefixes of the same log (rows of
   * a started run are never rewritten), and the longer saves more.
   */
  fill(
    runId: string,
    events: readonly Event[],
    firstLoadHeldRunStarted: boolean,
    now = Date.now()
  ): EventLogPrefixFillOutcome {
    if (events.some((event) => isTerminalRunEventType(event.eventType))) {
      this.evict(runId);
      return 'evicted_terminal';
    }
    if (!firstLoadHeldRunStarted) return 'ineligible';
    const prefix = cacheablePrefix(events);
    if (!prefix) return 'ineligible';
    const existing = this.state.entries.get(runId);
    if (existing && existing.events.length > prefix.length) {
      existing.lastUsedAt = now;
      return 'kept_longer';
    }
    const limits = this.limits();
    let bytes = 0;
    for (const event of prefix) bytes += estimateEventBytes(event);
    if (bytes > limits.maxBytes / 4) {
      this.evict(runId);
      return 'too_large';
    }
    this.evict(runId);
    this.state.entries.set(runId, {
      events: prefix.map(copyEvent),
      bytes,
      lastUsedAt: now,
    });
    this.state.totalBytes += bytes;
    for (const [oldest, entry] of this.state.entries) {
      if (this.state.totalBytes <= limits.maxBytes) break;
      if (oldest === runId) continue;
      this.state.entries.delete(oldest);
      this.state.totalBytes -= entry.bytes;
    }
    return 'filled';
  }

  evict(runId: string): void {
    const entry = this.state.entries.get(runId);
    if (!entry) return;
    this.state.entries.delete(runId);
    this.state.totalBytes -= entry.bytes;
  }

  /** Test hook: empty the cache. */
  clear(): void {
    this.state.entries.clear();
    this.state.totalBytes = 0;
  }
}
