import type { Event, World } from '@workflow/world';
import type { ReplayPayloadCache } from '../../replay-payload-cache.js';
import type { WorkflowSession } from '../../workflow.js';

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
 * reads from `cursor` and keeps the session only while the World's in-band
 * count still equals `expectedSeqInBand`, so no other orchestrator decided
 * anything since; otherwise it falls back to the full load and cold replay.
 */
export interface ParkedSession {
  readonly session: WorkflowSession;
  /** The log the session consumed, in slot order. */
  readonly events: Event[];
  /** Read position just past `events`. */
  readonly cursor: string;
  /** The in-band count the parking delivery's writer expected next. */
  readonly expectedSeqInBand: number;
  /**
   * The payload cache the session's events were prepared with. The VM's
   * state containers live in it, so a step input built from them reads it.
   */
  readonly replayPayloadCache: ReplayPayloadCache;
}

interface Entry extends ParkedSession {
  readonly parkedAtMs: number;
}

/**
 * Each entry holds a live VM and the run's decoded log, so few are kept and
 * not for long. A delivery that finds none, or a stale one, only pays today's
 * full load and replay.
 */
const MAX_ENTRIES = 64;
const MAX_AGE_MS = 10 * 60_000;

// Held per World instance: a session is only valid against the log of the
// World it was read from.
// per-copy-ok: a second copy of this module only misses sessions the first
// parked, which costs a full load and replay.
const sessionsByWorld = new WeakMap<object, Map<string, Entry>>();

function sessionsFor(world: object): Map<string, Entry> {
  let sessions = sessionsByWorld.get(world);
  if (!sessions) {
    sessions = new Map();
    sessionsByWorld.set(world, sessions);
  }
  return sessions;
}

export function parkSession(
  world: World,
  runId: string,
  parked: ParkedSession,
  nowMs = Date.now()
): void {
  const sessions = sessionsFor(world);
  sessions.delete(runId);
  sessions.set(runId, { ...parked, parkedAtMs: nowMs });
  if (sessions.size > MAX_ENTRIES) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
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
): ParkedSession | undefined {
  const sessions = sessionsFor(world);
  const entry = sessions.get(runId);
  if (!entry) return undefined;
  sessions.delete(runId);
  return nowMs - entry.parkedAtMs <= MAX_AGE_MS ? entry : undefined;
}
