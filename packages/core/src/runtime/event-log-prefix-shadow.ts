/**
 * Event-log prefix shadow: measure what a cross-invocation prefix cache would
 * have saved, without building one.
 *
 * # What is being measured
 *
 * Every re-invocation of a running run (a sleep or hook wake, an inline-budget
 * reinvoke, a redelivery) asks for the whole log again: the `run_started`
 * preload (or the lazy `hook_received` preload) streams it from slot 1. A
 * process that ran the previous invocation of the same run seconds ago held a
 * dense prefix of that log and threw it away. The proposed fix (workflow-server
 * `docs/log-prefix-cache.md`, model `specs/LogPrefixCache.tla`) keeps that
 * prefix across invocations, claims it on the preload, and has the server send
 * only the tail. It is deferred until this measurement says the saving is worth
 * the complexity:
 *
 * 1. would-skip bytes on multi-page prefixes are at least 15% of all sealed
 *    re-invocation preload stream bytes, and
 * 2. the stream time up to the last cached frame is at least 100 ms at p90 of
 *    would-hit re-invocations.
 *
 * # How
 *
 * A per-process LRU of **metadata only**: for each run, the length of the dense
 * prefix the last invocation on this process held, what a real cache would have
 * spent holding it, the slot of `run_started`, the run's spec version and the
 * identity of the last cached event. Around 150 bytes per run; never an event,
 * never a payload. The LRU is bounded by the budget, per-entry cap and idle TTL
 * a real cache would run with, applied to the recorded byte counts, so eviction
 * pressure on a busy instance shows up as misses rather than being assumed
 * away.
 *
 * On each preload the session looks up what an earlier invocation left (once
 * per invocation, so a hook preload and the `run_started` fallback after it do
 * not see each other's fills), watches the stream frame by frame, and reports:
 * whether the entry would have been usable, the prefix length and whether it is
 * long enough to be claimed at all, the bytes the stream spent on slots the
 * entry covered, and how long the stream took to get past them.
 *
 * # What it may not do
 *
 * Change anything a run does. It holds no event, returns nothing replay reads,
 * and every failure inside it is swallowed at the call site. It is off unless
 * `WORKFLOW_EVENT_LOG_PREFIX_SHADOW=1`, and it records nothing for a World that
 * does not report frame sizes (`WorldCapabilities.replayEventFrameBytes`),
 * which is every World but world-vercel: an in-process or database World pays
 * no wire cost to re-read its log, so there is nothing to save there.
 *
 * # The guards it mirrors
 *
 * The measurement is only honest if it counts as usable exactly what the real
 * protocol could use, so it applies the model's client guards and the
 * load-bearing server check:
 *
 * - **Dense fill from slot 1 (`CacheDenseOnly`).** An entry records the longest
 *   run of slots from slot 1 with no gap ({@link densePrefixLength}), which
 *   deliberately does NOT inherit `findEventSlotGap`'s slot-1 exemption, and
 *   only when `run_started` is inside it. Noops occupy their slot like any
 *   event.
 * - **Server-returned events only.** Fills come from the preload stream and the
 *   replay loop's settled log, both assembled from World responses; the turbo
 *   path's empty synthesized log fills nothing.
 * - **Sealed runs only.** Nothing below spec 7 is filled or counted as a hit
 *   (the server refuses those claims, see the model's `SealedGate`).
 * - **VersionCheck.** An entry recorded at another spec version is reported as
 *   refused: after a 7→8 raise a real claim is refused and the full log sent.
 * - **Anchor.** Slot N's type and correlation id are compared with what the
 *   stream carries at N. Not a guard in the model (`LogPrefixCacheNoAnchor`
 *   holds), so a mismatch is a bug detector: it is reported, and never counted
 *   as a hit.
 * - **Eviction** on a terminal run event (seen in a log, or written), a 410
 *   from any write or a 409 from a run lifecycle write or preload, and a
 *   slot-gap tripwire trip.
 *
 * # Known under-reporting
 *
 * An invocation is filled from its preload and from each settled log the Node
 * replay loop consumes. A QuickJS invocation reads and extends its log inside
 * the engine, so it is filled from its preload only, and the next invocation's
 * N is lower than a real cache (which would fill from the composed log) would
 * hold. Every error in this direction understates the saving, which is the
 * safe direction for a measurement whose job is to justify building the cache.
 */

import { EntityConflictError, RunExpiredError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import {
  type Event,
  type EventType,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  isRunEventType,
  isTerminalRunEventType,
  type ReplayEventFrame,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
  type World,
} from '@workflow/world';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { recordEventLogPrefixShadow } from '../telemetry.js';
import { isEventLogPrefixShadowEnabled } from './constants.js';
import { densePrefixLength } from './helpers.js';

/** Total bytes a real prefix cache would hold per process. */
export const PREFIX_SHADOW_BUDGET_BYTES = 32 * 1024 * 1024;
/** Largest single run a real cache would hold; a longer prefix is not kept. */
export const PREFIX_SHADOW_ENTRY_CAP_BYTES = 8 * 1024 * 1024;
/** An entry nobody filled or hit for this long is gone. */
export const PREFIX_SHADOW_IDLE_TTL_MS = 5 * 60_000;
/**
 * The claim gate: a real client claims only a prefix longer than one preload
 * page (more than 500 events, or more than 256 KiB), so the median
 * re-invocation stays byte-for-byte on today's path. A hit below both is
 * reported as a hit that would not have been claimed.
 */
export const PREFIX_SHADOW_CLAIM_MIN_SLOTS = 500;
export const PREFIX_SHADOW_CLAIM_MIN_BYTES = 256 * 1024;
/**
 * Bound on the number of entries, independent of the byte budget, so the
 * metadata itself stays bounded (~2.5 MiB at the cap). It only binds when
 * entries average under 2 KiB, far below the claim gate, so it cannot hide a
 * claimable hit.
 */
export const PREFIX_SHADOW_MAX_ENTRIES = 16_384;

/**
 * Per-event bytes assumed for an event whose frame this process never saw (one
 * a replay turn picked up from an incremental list or an inline delta). Only
 * sizes an entry for the budget simulation; the would-skip bytes a load
 * reports are always the frame sizes it measured.
 */
const UNOBSERVED_EVENT_METADATA_BYTES = 160;

/** Which preload a measurement describes. */
export type PrefixShadowSource = 'run_started' | 'hook_preload';

/**
 * What a preload would have met had a prefix cache existed.
 *
 * - `hit`: the entry was usable, and the stream reached the end of it.
 * - `hit_truncated`: usable, but the stream ended (a bounded page) before the
 *   end of it, so would-skip bytes cover only what arrived.
 * - `miss`: no earlier invocation of this run left an entry on this process
 *   (or it was evicted by the budget or entry cap).
 * - `expired`: an entry existed but sat idle past the TTL.
 * - `refused_version`: the entry was recorded at another spec version, so a
 *   real claim would be refused (VersionCheck).
 * - `anchor_mismatch`: the stream's event at slot N is not the one the entry
 *   recorded. The model says this is unreachable; seeing it is a bug.
 * - `prefix_mismatch`: a complete stream is missing a slot the entry claimed
 *   to hold. Also unreachable per the model (`CacheIsPrefix`).
 * - `ineligible_spec`: the run is below the sealed-log spec, or its version is
 *   unknown. Never claimable.
 * - `ineligible_ids`: the log is not slot-numbered (a pre-slot run).
 * - `unmeasured`: events arrived without frame sizes (for example a response
 *   that was not a frame stream), so there is nothing to compare.
 */
export type PrefixShadowOutcome =
  | 'hit'
  | 'hit_truncated'
  | 'miss'
  | 'expired'
  | 'refused_version'
  | 'anchor_mismatch'
  | 'prefix_mismatch'
  | 'ineligible_spec'
  | 'ineligible_ids'
  | 'unmeasured';

/** One preload's measurement, for span attributes and metrics. */
export interface PrefixShadowMeasurement {
  source: PrefixShadowSource;
  outcome: PrefixShadowOutcome;
  /**
   * A usable, complete hit long enough to pass the claim gate: the loads a
   * real client would actually have sent a claim for.
   */
  wouldClaim: boolean;
  /** Dense prefix length of the entry found, if any (N). */
  cachedSlots?: number;
  /** Bytes the entry found would have held. */
  cachedBytes?: number;
  /** Time since the entry was last filled or hit. */
  entryAgeMs?: number;
  /** Distinct events the stream carried. */
  streamEvents: number;
  /** Wire bytes of those events. */
  streamBytes: number;
  /** Wire bytes of the streamed events at or below N, on a hit. */
  wouldSkipBytes: number;
  /** Request start to the arrival of the frame at slot N, on a hit. */
  timeToPrefixEndMs?: number;
  /** Request start to the arrival of the frame at slot N + 1, if any. */
  timeToFirstTailFrameMs?: number;
  /** Request start to the end of the load. */
  streamDurationMs: number;
  /** Dense prefix length of what this load returned. */
  denseSlots?: number;
}

interface PrefixShadowEntry {
  denseSlots: number;
  bytes: number;
  runStartedSlot: number;
  specVersion: number;
  anchorEventType: string;
  anchorCorrelationId: string | undefined;
  /** Last fill or hit; the idle TTL runs from here. */
  lastUsedAt: number;
}

interface PrefixShadowState {
  /** Insertion order is recency order: a touch re-inserts. */
  entries: Map<string, PrefixShadowEntry>;
  totalBytes: number;
  worldIds: WeakMap<object, number>;
  nextWorldId: number;
}

function createState(): PrefixShadowState {
  return {
    entries: new Map(),
    totalBytes: 0,
    worldIds: new WeakMap(),
    nextWorldId: 1,
  };
}

// On `globalThis` (see `globalSingleton`) for the reason a real cache would be:
// bundled copies of this module must share one budget, and one invocation's
// fill must be visible to the next invocation whichever copy serves it.
const sharedState = globalSingleton(
  '@workflow/core//eventLogPrefixShadow',
  1,
  createState
);

/** The store a session reads and fills. Separate so tests can own one. */
export class PrefixShadowStore {
  constructor(private readonly state: PrefixShadowState = createState()) {}

  static shared(): PrefixShadowStore {
    return new PrefixShadowStore(sharedState);
  }

  get size(): number {
    return this.state.entries.size;
  }

  get totalBytes(): number {
    return this.state.totalBytes;
  }

  /**
   * Keyed per World as well as per run: a real cache must never hand one
   * World's prefix to another, and a process can hold several.
   */
  keyFor(world: World, runId: string): string {
    let id = this.state.worldIds.get(world);
    if (id === undefined) {
      id = this.state.nextWorldId++;
      this.state.worldIds.set(world, id);
    }
    return `${id}:${runId}`;
  }

  lookup(
    key: string,
    now: number
  ):
    | { found: true; entry: PrefixShadowEntry; ageMs: number }
    | { found: false; expired: boolean } {
    const entry = this.state.entries.get(key);
    if (entry === undefined) return { found: false, expired: false };
    const ageMs = now - entry.lastUsedAt;
    if (ageMs > PREFIX_SHADOW_IDLE_TTL_MS) {
      this.evict(key);
      return { found: false, expired: true };
    }
    return { found: true, entry: { ...entry }, ageMs };
  }

  /** Mark an entry used (a would-hit), refreshing its TTL and recency. */
  touch(key: string, now: number): void {
    const entry = this.state.entries.get(key);
    if (entry === undefined) return;
    entry.lastUsedAt = now;
    this.state.entries.delete(key);
    this.state.entries.set(key, entry);
  }

  fill(key: string, entry: PrefixShadowEntry): void {
    this.evict(key);
    // A real cache holds no prefix larger than its per-entry cap, and does not
    // keep a stale shorter one either: the next invocation re-reads in full.
    if (entry.bytes > PREFIX_SHADOW_ENTRY_CAP_BYTES) return;
    this.state.entries.set(key, entry);
    this.state.totalBytes += entry.bytes;
    for (const [oldestKey] of this.state.entries) {
      if (
        this.state.totalBytes <= PREFIX_SHADOW_BUDGET_BYTES &&
        this.state.entries.size <= PREFIX_SHADOW_MAX_ENTRIES
      ) {
        break;
      }
      this.evict(oldestKey);
    }
  }

  evict(key: string): void {
    const entry = this.state.entries.get(key);
    if (entry === undefined) return;
    this.state.entries.delete(key);
    this.state.totalBytes -= entry.bytes;
  }

  /** Test hook: forget everything. */
  clear(): void {
    this.state.entries.clear();
    this.state.totalBytes = 0;
  }
}

/** Test hook: empty the process-wide store. */
export function resetEventLogPrefixShadowForTests(): void {
  PrefixShadowStore.shared().clear();
}

/**
 * What a real cache would spend holding an event whose frame this process
 * never saw: its payload bytes plus a fixed allowance for the rest.
 */
function estimateEventBytes(event: Event): number {
  let bytes = UNOBSERVED_EVENT_METADATA_BYTES;
  const data = (event as { eventData?: unknown }).eventData;
  if (data !== null && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (value instanceof Uint8Array) bytes += value.byteLength;
      else if (typeof value === 'string') bytes += value.length;
    }
  }
  return bytes;
}

function isSealedSpec(specVersion: number | undefined): specVersion is number {
  return (
    typeof specVersion === 'number' &&
    specVersion >= SPEC_VERSION_SUPPORTS_SEALED_LOG
  );
}

export interface PrefixShadowSessionOptions {
  store?: PrefixShadowStore;
  now?: () => number;
}

/**
 * One invocation's view of the shadow. Opened once per invocation; dies with
 * it, taking the frame sizes it saw with it.
 */
export class PrefixShadowSession {
  /** Wire bytes per slot, from every frame this invocation observed. */
  private readonly slotBytes: number[] = [];
  private prior:
    | { found: true; entry: PrefixShadowEntry; ageMs: number }
    | { found: false; expired: boolean }
    | undefined;
  private readonly now: () => number;

  private constructor(
    private readonly store: PrefixShadowStore,
    private readonly key: string,
    now: () => number
  ) {
    this.now = now;
  }

  /**
   * A session for this invocation, or undefined when the shadow is off or the
   * World cannot report frame sizes. Undefined is the whole cost when off.
   */
  static open(
    world: World,
    runId: string,
    options: PrefixShadowSessionOptions = {}
  ): PrefixShadowSession | undefined {
    if (!isEventLogPrefixShadowEnabled()) return undefined;
    if (world.capabilities?.replayEventFrameBytes !== true) return undefined;
    // Never throws: this runs on the handler's path before any replay work,
    // so a bug here must cost the measurement, not the invocation.
    try {
      const store = options.store ?? PrefixShadowStore.shared();
      return new PrefixShadowSession(
        store,
        store.keyFor(world, runId),
        options.now ?? Date.now
      );
    } catch {
      return undefined;
    }
  }

  /** Start measuring a preload. Call before the request goes out. */
  beginLoad(source: PrefixShadowSource): PrefixShadowLoad {
    const startedAt = this.now();
    // Once per invocation: what earlier invocations left. A second preload in
    // this invocation (the run_started fallback after a hook preload) is
    // measured against the same entry, not against this invocation's fill.
    this.prior ??= this.store.lookup(this.key, startedAt);
    return new PrefixShadowLoad(this, source, startedAt, this.prior);
  }

  /** @internal Called by a load as each frame arrives. */
  recordFrameBytes(slot: number, byteLength: number): void {
    this.slotBytes[slot] = byteLength;
  }

  /** @internal */
  clock(): number {
    return this.now();
  }

  /** @internal Refresh an entry a load would have hit. */
  touchPrior(): void {
    this.store.touch(this.key, this.now());
  }

  /**
   * Record the dense prefix of a log this invocation holds, as the fill a real
   * cache would make. Call with a log assembled from World responses only.
   * Evicts instead when the log records the run's end, when the run is below
   * the sealed-log spec, or when nothing from slot 1 is dense.
   *
   * @returns the dense prefix length recorded, if any.
   */
  recordLog(
    events: readonly Event[],
    runSpecVersion: number | undefined
  ): number | undefined {
    // The version a claim would carry is the one `run_created` holds as read
    // (the model's knownVer, and what world-vercel reconstructs a preloaded
    // run from). The run the caller passes can lag it: on the turbo first
    // delivery it is synthesized from the caller's stamp for the whole
    // invocation, so after the server raises the run on `run_started` it
    // still shows the pre-raise version. Prefer the event; fall back to the
    // run only when the log does not carry `run_created`.
    const specVersion = runCreatedSpecVersion(events) ?? runSpecVersion;
    const fill = isSealedSpec(specVersion)
      ? this.fillFor(events, specVersion)
      : undefined;
    if (fill === undefined) {
      this.evict();
      return undefined;
    }
    this.store.fill(this.key, fill);
    return fill.denseSlots;
  }

  /** The entry a real cache would record for `events`, if it would. */
  private fillFor(
    events: readonly Event[],
    specVersion: number
  ): PrefixShadowEntry | undefined {
    const shape = lifecycleShape(events);
    const dense = densePrefixLength(events);
    if (
      shape.terminal ||
      dense === undefined ||
      dense < FIRST_EVENT_SLOT ||
      shape.runStartedSlot === undefined ||
      shape.runStartedSlot > dense
    ) {
      return undefined;
    }
    let bytes = 0;
    let anchor: Event | undefined;
    for (const event of events) {
      const slot = eventIdToSlot(event.eventId);
      if (slot === null || slot > dense) continue;
      bytes += this.slotBytes[slot] ?? estimateEventBytes(event);
      if (slot === dense) anchor = event;
    }
    if (anchor === undefined) return undefined;
    return {
      denseSlots: dense,
      bytes,
      runStartedSlot: shape.runStartedSlot,
      specVersion,
      anchorEventType: anchor.eventType,
      // Normalized so a decode path spelling an absent id as null and another
      // as undefined cannot read as a changed anchor.
      anchorCorrelationId: anchor.correlationId ?? undefined,
      lastUsedAt: this.now(),
    };
  }

  /** Forget this run: it ended, a write was refused, or its log tripped. */
  evict(): void {
    this.store.evict(this.key);
  }

  /**
   * Start measuring a preload, if it is one a claim would ride on (the lists
   * that follow a preload are not what a cache would replace). Never throws.
   */
  tryBeginLoad(source: string): PrefixShadowLoad | undefined {
    if (source !== 'run_started' && source !== 'hook_preload') return undefined;
    try {
      return this.beginLoad(source);
    } catch {
      return undefined;
    }
  }

  /**
   * A write through the replay loop's seam landed. A real cache drops a run
   * once it writes the run's end. Never throws.
   */
  noteWrite(eventType: EventType): void {
    // Runs after a committed write: a throw here would drop its response.
    try {
      if (!isTerminalRunEventType(eventType)) return;
      this.evict();
    } catch {
      // measurement only
    }
  }

  /**
   * A write through the replay loop's seam was refused. A real cache drops a
   * run on a 410 from any write, and on a 409 from a write that only conflicts
   * once the run is over (its lifecycle writes and the lazy resume preload). A
   * 409 elsewhere (a wait another handler already completed) says nothing
   * about the log. Never throws.
   */
  noteWriteRefused(
    eventType: EventType,
    error: unknown,
    preloadEvents: boolean
  ): void {
    // Runs inside the `.catch` that rethrows the World's error: a throw here
    // would replace that error and change how the caller classifies it.
    try {
      if (
        RunExpiredError.is(error) ||
        (EntityConflictError.is(error) &&
          (isRunEventType(eventType) || preloadEvents))
      ) {
        this.evict();
      }
    } catch {
      // measurement only
    }
  }

  /** {@link recordLog} for the replay loop: never throws. */
  tryRecordLog(
    events: readonly Event[],
    specVersion: number | undefined
  ): void {
    try {
      this.recordLog(events, specVersion);
    } catch {
      // measurement only
    }
  }

  /** {@link evict} for the replay loop: never throws. */
  tryEvict(): void {
    try {
      this.evict();
    } catch {
      // measurement only
    }
  }
}

/** The spec version `run_created` carries in `events`, if it is there. */
function runCreatedSpecVersion(events: readonly Event[]): number | undefined {
  for (const event of events) {
    if (event.eventType === 'run_created') return event.specVersion;
  }
  return undefined;
}

/**
 * Whether a log records its run's end, and the slot of its `run_started` (the
 * lowest, should a broken log carry two).
 */
function lifecycleShape(events: readonly Event[]): {
  terminal: boolean;
  runStartedSlot: number | undefined;
} {
  let runStartedSlot: number | undefined;
  for (const event of events) {
    if (isTerminalRunEventType(event.eventType)) {
      return { terminal: true, runStartedSlot };
    }
    if (event.eventType !== 'run_started') continue;
    const slot = eventIdToSlot(event.eventId);
    if (
      slot !== null &&
      (runStartedSlot === undefined || slot < runStartedSlot)
    ) {
      runStartedSlot = slot;
    }
  }
  return { terminal: false, runStartedSlot };
}

/** One preload stream under measurement. */
export class PrefixShadowLoad {
  private streamEvents = 0;
  private streamBytes = 0;
  private framesWithoutBytes = 0;
  private unslotted = false;
  /** Bytes per slot for this load alone (a retry can resend a frame). */
  private readonly loadSlotBytes: number[] = [];
  private prefixEndAt: number | undefined;
  private firstTailAt: number | undefined;
  private readonly cachedSlots: number | undefined;

  constructor(
    private readonly session: PrefixShadowSession,
    private readonly source: PrefixShadowSource,
    private readonly startedAt: number,
    private readonly prior:
      | { found: true; entry: PrefixShadowEntry; ageMs: number }
      | { found: false; expired: boolean }
  ) {
    this.cachedSlots = prior.found ? prior.entry.denseSlots : undefined;
  }

  private broken = false;

  /**
   * The replay observer's half: cheap and synchronous. Never throws, because a
   * throwing observer aborts the load (see `replayEventObserver`); a bug here
   * ends the measurement instead.
   */
  tryObserve(event: Event, frame: ReplayEventFrame | undefined): void {
    if (this.broken) return;
    try {
      this.observe(event, frame);
    } catch {
      this.broken = true;
    }
  }

  /**
   * Conclude the load, put the measurement on its span and emit its metrics.
   * Never throws.
   */
  tryConclude(
    result: Parameters<PrefixShadowLoad['finish']>[0],
    span:
      | { setAttributes(attributes: Record<string, unknown>): unknown }
      | undefined
  ): void {
    if (this.broken) return;
    try {
      const measurement = this.finish(result);
      span?.setAttributes(prefixShadowSpanAttributes(measurement));
      void recordEventLogPrefixShadow(measurement).catch(() => {});
    } catch {
      // measurement only
    }
  }

  observe(event: Event, frame: ReplayEventFrame | undefined): void {
    const slot = eventIdToSlot(event.eventId);
    if (slot === null) {
      this.unslotted = true;
      return;
    }
    if (frame === undefined) {
      this.framesWithoutBytes++;
      return;
    }
    const previous = this.loadSlotBytes[slot];
    if (previous === undefined) {
      this.streamEvents++;
      this.streamBytes += frame.byteLength;
    } else {
      this.streamBytes += frame.byteLength - previous;
    }
    this.loadSlotBytes[slot] = frame.byteLength;
    this.session.recordFrameBytes(slot, frame.byteLength);
    if (this.cachedSlots !== undefined) {
      if (slot === this.cachedSlots && this.prefixEndAt === undefined) {
        this.prefixEndAt = this.session.clock();
      } else if (
        slot === this.cachedSlots + 1 &&
        this.firstTailAt === undefined
      ) {
        this.firstTailAt = this.session.clock();
      }
    }
  }

  /**
   * Conclude the load and make this invocation's fill. `result` is what the
   * World returned: the events, the reconstructed run, and whether the page
   * was bounded.
   */
  finish(result: {
    events?: readonly Event[];
    run?: { specVersion?: number };
    hasMore?: boolean;
  }): PrefixShadowMeasurement {
    const events = result.events ?? [];
    // Same version rule as the fill (see recordLog), so a claim check and the
    // entry it is checked against never read the version from different
    // places.
    const specVersion =
      runCreatedSpecVersion(events) ?? result.run?.specVersion;
    const outcome = this.classify(events, specVersion, result.hasMore === true);
    const hit = outcome === 'hit' || outcome === 'hit_truncated';
    if (hit) this.session.touchPrior();
    // The fill (or the eviction, for a run that can never be claimed) happens
    // whatever the outcome, except when nothing was measured: a later replay
    // turn fills that invocation from its settled log instead.
    const denseSlots =
      outcome === 'unmeasured'
        ? undefined
        : this.session.recordLog(events, specVersion);
    const measurement: PrefixShadowMeasurement = {
      source: this.source,
      outcome,
      wouldClaim: outcome === 'hit' && this.passesClaimGate(),
      streamEvents: this.streamEvents,
      streamBytes: this.streamBytes,
      wouldSkipBytes: hit ? this.bytesThroughCachedSlots() : 0,
      streamDurationMs: Math.max(0, this.session.clock() - this.startedAt),
      ...this.priorFields(),
      ...this.timings(hit),
    };
    if (denseSlots !== undefined) measurement.denseSlots = denseSlots;
    return measurement;
  }

  private passesClaimGate(): boolean {
    if (!this.prior.found) return false;
    const { denseSlots, bytes } = this.prior.entry;
    return (
      denseSlots > PREFIX_SHADOW_CLAIM_MIN_SLOTS ||
      bytes > PREFIX_SHADOW_CLAIM_MIN_BYTES
    );
  }

  /** Measured wire bytes of this stream's frames at or below N. */
  private bytesThroughCachedSlots(): number {
    let bytes = 0;
    const through = this.cachedSlots ?? 0;
    for (let slot = FIRST_EVENT_SLOT; slot <= through; slot++) {
      bytes += this.loadSlotBytes[slot] ?? 0;
    }
    return bytes;
  }

  private priorFields(): Partial<PrefixShadowMeasurement> {
    if (!this.prior.found) return {};
    return {
      cachedSlots: this.prior.entry.denseSlots,
      cachedBytes: this.prior.entry.bytes,
      entryAgeMs: this.prior.ageMs,
    };
  }

  private timings(hit: boolean): Partial<PrefixShadowMeasurement> {
    const out: Partial<PrefixShadowMeasurement> = {};
    if (hit && this.prefixEndAt !== undefined) {
      out.timeToPrefixEndMs = Math.max(0, this.prefixEndAt - this.startedAt);
    }
    if (this.firstTailAt !== undefined) {
      out.timeToFirstTailFrameMs = Math.max(
        0,
        this.firstTailAt - this.startedAt
      );
    }
    return out;
  }

  private classify(
    events: readonly Event[],
    specVersion: number | undefined,
    hasMore: boolean
  ): PrefixShadowOutcome {
    if (this.unslotted) return 'ineligible_ids';
    if (!isSealedSpec(specVersion)) return 'ineligible_spec';
    if (
      this.framesWithoutBytes > 0 ||
      (events.length > 0 && this.streamEvents === 0)
    ) {
      return 'unmeasured';
    }
    const prior = this.prior;
    if (!prior.found) return prior.expired ? 'expired' : 'miss';
    if (prior.entry.specVersion !== specVersion) return 'refused_version';
    return matchEntry(events, prior.entry, hasMore);
  }
}

/**
 * Whether a stream still carries the prefix an entry recorded: every slot up to
 * N present, and slot N the same event.
 */
function matchEntry(
  events: readonly Event[],
  entry: PrefixShadowEntry,
  hasMore: boolean
): PrefixShadowOutcome {
  const bySlot = new Map<number, Event>();
  for (const event of events) {
    const slot = eventIdToSlot(event.eventId);
    if (slot !== null && slot <= entry.denseSlots) bySlot.set(slot, event);
  }
  for (let slot = FIRST_EVENT_SLOT; slot <= entry.denseSlots; slot++) {
    if (!bySlot.has(slot)) {
      return hasMore ? 'hit_truncated' : 'prefix_mismatch';
    }
  }
  const anchor = bySlot.get(entry.denseSlots);
  if (
    anchor === undefined ||
    anchor.eventType !== entry.anchorEventType ||
    (anchor.correlationId ?? undefined) !== entry.anchorCorrelationId
  ) {
    return 'anchor_mismatch';
  }
  return 'hit';
}

/** Span attributes for one measurement, on the `workflow.replay.load` span. */
export function prefixShadowSpanAttributes(
  m: PrefixShadowMeasurement
): Record<string, string | number | boolean> {
  return {
    ...Attribute.WorkflowReplayPrefixShadowOutcome(m.outcome),
    ...Attribute.WorkflowReplayPrefixShadowWouldClaim(m.wouldClaim),
    ...Attribute.WorkflowReplayPrefixShadowStreamEvents(m.streamEvents),
    ...Attribute.WorkflowReplayPrefixShadowStreamBytes(m.streamBytes),
    ...Attribute.WorkflowReplayPrefixShadowWouldSkipBytes(m.wouldSkipBytes),
    ...Attribute.WorkflowReplayPrefixShadowStreamDurationMs(m.streamDurationMs),
    ...(m.cachedSlots !== undefined
      ? Attribute.WorkflowReplayPrefixShadowCachedSlots(m.cachedSlots)
      : {}),
    ...(m.cachedBytes !== undefined
      ? Attribute.WorkflowReplayPrefixShadowCachedBytes(m.cachedBytes)
      : {}),
    ...(m.entryAgeMs !== undefined
      ? Attribute.WorkflowReplayPrefixShadowEntryAgeMs(m.entryAgeMs)
      : {}),
    ...(m.timeToPrefixEndMs !== undefined
      ? Attribute.WorkflowReplayPrefixShadowTimeToPrefixEndMs(
          m.timeToPrefixEndMs
        )
      : {}),
    ...(m.timeToFirstTailFrameMs !== undefined
      ? Attribute.WorkflowReplayPrefixShadowTimeToFirstTailFrameMs(
          m.timeToFirstTailFrameMs
        )
      : {}),
    ...(m.denseSlots !== undefined
      ? Attribute.WorkflowReplayPrefixShadowDenseSlots(m.denseSlots)
      : {}),
  };
}
