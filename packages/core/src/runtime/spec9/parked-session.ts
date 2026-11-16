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
 * The VM still holds the parking delivery's end-of-run drain, so the
 * resuming delivery hands it its own (`WorkflowSession.resume`).
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
}

interface Entry extends ParkedSession {
  readonly parkedAtMs: number;
}

interface ParkedSessions {
  /** In park order, so the oldest entry is first. */
  readonly entries: Map<string, Entry>;
  /** Drops expired entries once the oldest expires, while any are kept. */
  sweep?: ReturnType<typeof setTimeout>;
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
const sessionsByWorld = new WeakMap<object, ParkedSessions>();

function sessionsFor(world: object): ParkedSessions {
  let sessions = sessionsByWorld.get(world);
  if (!sessions) {
    sessions = { entries: new Map() };
    sessionsByWorld.set(world, sessions);
  }
  return sessions;
}

function dropExpired(sessions: ParkedSessions, nowMs: number): void {
  for (const [runId, entry] of sessions.entries) {
    if (nowMs - entry.parkedAtMs <= MAX_AGE_MS) break;
    sessions.entries.delete(runId);
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
  const delayMs = Math.max(0, oldest.parkedAtMs + MAX_AGE_MS - Date.now());
  sessions.sweep = setTimeout(() => {
    sessions.sweep = undefined;
    dropExpired(sessions, Date.now());
    scheduleSweep(sessions);
  }, delayMs + 1);
  sessions.sweep.unref?.();
}

/**
 * Parks the run's session, unless the run already has one parked that is
 * further along: two deliveries of a run in this process can finish in
 * either order (a no-op wake puts back the entry it took after a delivery
 * that started later parked a newer one), and the older VM would resume
 * from an older cursor.
 */
export function parkSession(
  world: World,
  runId: string,
  parked: ParkedSession,
  nowMs = Date.now()
): void {
  const sessions = sessionsFor(world);
  dropExpired(sessions, nowMs);
  const current = sessions.entries.get(runId);
  if (current && current.tailSlot > parked.tailSlot) return;
  sessions.entries.delete(runId);
  sessions.entries.set(runId, { ...parked, parkedAtMs: nowMs });
  if (sessions.entries.size > MAX_ENTRIES) {
    const oldest = sessions.entries.keys().next().value;
    if (oldest !== undefined) sessions.entries.delete(oldest);
  }
  scheduleSweep(sessions);
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
  dropExpired(sessions, nowMs);
  const entry = sessions.entries.get(runId);
  if (!entry) return undefined;
  sessions.entries.delete(runId);
  return entry;
}
