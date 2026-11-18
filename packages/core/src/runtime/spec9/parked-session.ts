import type {
  Event,
  WorkflowRun,
  WorkflowRunWithoutData,
  World,
} from '@workflow/world';
import type { ReplayPayloadCache } from '../../replay-payload-cache.js';
import type { WorkflowSession } from '../../workflow.js';
import { getParkedVmMaxAgeMs, getParkedVmMaxBytes } from '../constants.js';

/**
 * A node:vm session a delivery left suspended cleanly, kept so the run's
 * next orchestrator delivery in this process can resume it on what landed
 * since instead of loading the whole log and replaying it from cold.
 *
 * A session-style workflow (one that loops on a hook) pays that load and
 * replay on every message that arrives after its orchestrator stopped
 * lingering, and both grow with the run's history. Resuming the parked VM
 * costs one incremental read.
 *
 * What it holds is only valid against the log it consumed. The next delivery
 * reads from `cursor`, including whatever another orchestrator decided since,
 * and the VM replays that like any read event. `expectedSeqInBand` says
 * whether it did. The VM still holds the parking delivery's end-of-run
 * drain, so the resuming delivery hands it its own (`WorkflowSession.resume`).
 *
 * An event this process writes for the run while it is parked (the
 * `hook_received` of a `resumeHook()` here) is kept with it
 * ({@link noteParkedRunWrite}). When those events continue the log from
 * `tailSlot`, the resuming delivery takes them as its read and does not read
 * the log at all.
 */
export interface ParkedSession {
  readonly session: WorkflowSession;
  /** The log the session consumed, in slot order. */
  readonly events: Event[];
  /** Read position just past `events`. */
  readonly cursor: string;
  /** The highest slot in `events`: how far along the run the session is. */
  readonly tailSlot: number;
  /** The in-band count the parking delivery's writer expected next. */
  readonly expectedSeqInBand: number;
  /**
   * The payload cache the session's events were prepared with. The VM's
   * state containers live in it, so a step input built from them reads it.
   */
  readonly replayPayloadCache: ReplayPayloadCache;
  /**
   * The run's event ceiling as the parking delivery's log reads reported it,
   * for a resume that reads nothing.
   */
  readonly maxEventsLimit?: number;
  /** The run as the parking delivery last read it. */
  readonly run?: WorkflowRun | WorkflowRunWithoutData;
  /**
   * Events this process wrote for the run since the park, in slot order
   * (see {@link noteParkedRunWrite}).
   */
  readonly written?: readonly Event[];
}

/** A parked session as a delivery takes it. */
export interface TakenParkedSession extends ParkedSession {
  readonly parkedAtMs: number;
}

interface Entry extends TakenParkedSession {
  /** {@link estimateParkedBytes} of `events`. */
  readonly bytes: number;
}

interface ParkedSessions {
  /** In park order, so the oldest entry is first. */
  readonly entries: Map<string, Entry>;
  /** The sum of the entries' `bytes`. */
  bytes: number;
  /** Drops expired entries once the oldest expires, while any are kept. */
  sweep?: ReturnType<typeof setTimeout>;
}

/**
 * Each entry holds a live VM and the run's decoded log, so few are kept and
 * not for long (`WORKFLOW_PARKED_VM_MAX_AGE_MS`), and their estimated size
 * stays within `WORKFLOW_PARKED_VM_MAX_BYTES`. A delivery that finds none, or
 * a stale one, only pays today's full load and replay.
 */
const MAX_ENTRIES = 64;

/**
 * What an entry holds besides its events' payloads: the VM's context and the
 * workflow bundle's module state, measured at about 0.25 MB.
 */
const ENTRY_BASE_BYTES = 256 * 1024;
/**
 * An entry holds each payload byte about three times: in the log's encoded
 * events, decrypted in the payload cache, and hydrated in the VM's state.
 * Measured at 2.8 times for a chat-style hook loop.
 */
const BYTES_PER_PAYLOAD_BYTE = 3;

/**
 * Estimates the memory a parked session over `events` holds. A run's history
 * lives in its events' serialized fields, so their sizes track it.
 */
export function estimateParkedBytes(events: readonly Event[]): number {
  return ENTRY_BASE_BYTES + BYTES_PER_PAYLOAD_BYTE * payloadBytesOf(events);
}

function payloadBytesOf(events: readonly Event[]): number {
  let bytes = 0;
  for (const event of events) {
    const data = (event as { eventData?: unknown }).eventData;
    if (typeof data !== 'object' || data === null) continue;
    for (const value of Object.values(data)) {
      if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    }
  }
  return bytes;
}

/** Why {@link parkSession} kept no entry. */
export type ParkSkipReason =
  /** `WORKFLOW_PARKED_VM_MAX_BYTES=0`. */
  | 'disabled'
  /** The entry alone would take more than half the budget. */
  | 'too_large'
  /** The run already has an entry parked that is further along. */
  | 'newer_parked';

export type ParkResult =
  | {
      parked: true;
      bytes: number;
      /** Entries dropped to make room for this one, by count or budget. */
      evicted: number;
    }
  | { parked: false; bytes: number; reason: ParkSkipReason };

// Held per World instance: a session is only valid against the log of the
// World it was read from.
// per-copy-ok: a second copy of this module only misses sessions the first
// parked, which costs a full load and replay.
const sessionsByWorld = new WeakMap<object, ParkedSessions>();

function sessionsFor(world: object): ParkedSessions {
  let sessions = sessionsByWorld.get(world);
  if (!sessions) {
    sessions = { entries: new Map(), bytes: 0 };
    sessionsByWorld.set(world, sessions);
  }
  return sessions;
}

function drop(sessions: ParkedSessions, runId: string): Entry | undefined {
  const entry = sessions.entries.get(runId);
  if (!entry) return undefined;
  sessions.entries.delete(runId);
  sessions.bytes -= entry.bytes;
  return entry;
}

function dropExpired(sessions: ParkedSessions, nowMs: number): void {
  const maxAgeMs = getParkedVmMaxAgeMs();
  for (const [runId, entry] of sessions.entries) {
    if (nowMs - entry.parkedAtMs <= maxAgeMs) break;
    drop(sessions, runId);
  }
}

/**
 * Expires entries on a timer as well as when the map is touched, so a
 * process that stops receiving deliveries does not hold its VMs past the age
 * limit. The timer does not keep the process alive.
 */
function scheduleSweep(sessions: ParkedSessions): void {
  if (sessions.sweep !== undefined) return;
  const oldest = sessions.entries.values().next().value;
  if (oldest === undefined) return;
  const delayMs = Math.max(
    0,
    oldest.parkedAtMs + getParkedVmMaxAgeMs() - Date.now()
  );
  sessions.sweep = setTimeout(() => {
    sessions.sweep = undefined;
    dropExpired(sessions, Date.now());
    scheduleSweep(sessions);
  }, delayMs + 1);
  sessions.sweep.unref?.();
}

/**
 * Parks the run's session, unless it would take more than half the budget or
 * the run already has one parked that is further along: two deliveries of a
 * run in this process can finish in either order (a no-op wake puts back the
 * entry it took after a delivery that started later parked a newer one), and
 * the older VM would resume from an older cursor. Evicts the oldest entries
 * to stay within the entry count and the byte budget.
 */
export function parkSession(
  world: World,
  runId: string,
  parked: ParkedSession,
  nowMs = Date.now()
): ParkResult {
  const bytes = estimateParkedBytes(parked.events);
  const budget = getParkedVmMaxBytes();
  if (budget === 0) return { parked: false, bytes, reason: 'disabled' };
  const sessions = sessionsFor(world);
  dropExpired(sessions, nowMs);
  const current = sessions.entries.get(runId);
  if (current && current.tailSlot > parked.tailSlot) {
    return { parked: false, bytes, reason: 'newer_parked' };
  }
  // The run's older entry goes either way: this one replaces it, or is too
  // large to, and the older VM's cursor is behind what this delivery wrote.
  drop(sessions, runId);
  if (bytes > budget / 2) return { parked: false, bytes, reason: 'too_large' };
  let evicted = 0;
  while (
    sessions.entries.size >= MAX_ENTRIES ||
    sessions.bytes + bytes > budget
  ) {
    const oldest = sessions.entries.keys().next().value;
    if (oldest === undefined) break;
    drop(sessions, oldest);
    evicted++;
  }
  sessions.entries.set(runId, { ...parked, parkedAtMs: nowMs, bytes });
  sessions.bytes += bytes;
  scheduleSweep(sessions);
  return { parked: true, bytes, evicted };
}

/**
 * Removes and returns the run's parked session. Every orchestrator delivery
 * takes it, whether or not it resumes it, so no two deliveries in this
 * process can resume the same VM.
 */
export function takeParkedSession(
  world: World,
  runId: string,
  nowMs = Date.now()
): TakenParkedSession | undefined {
  const sessions = sessionsFor(world);
  dropExpired(sessions, nowMs);
  return drop(sessions, runId);
}

/**
 * Keeps an event this process just wrote for a run whose session is parked
 * here, so the delivery that resumes the session can take it without reading
 * the log. A no-op when nothing is parked for the run. Callers pass the event
 * as a log read would return it, payload included.
 */
export function noteParkedRunWrite(
  world: World,
  runId: string,
  event: Event
): void {
  const sessions = sessionsFor(world);
  const entry = sessions.entries.get(runId);
  if (!entry) return;
  const written = [...(entry.written ?? []), event];
  // Counted against the budget; the next park evicts to make room for it.
  const added = BYTES_PER_PAYLOAD_BYTE * payloadBytesOf([event]);
  sessions.bytes += added;
  sessions.entries.set(runId, {
    ...entry,
    written,
    bytes: entry.bytes + added,
  });
}
