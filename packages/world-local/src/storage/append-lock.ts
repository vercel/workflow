import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeTime, ulid } from 'ulid';
import { PreconditionFailedError } from '@workflow/errors';
import {
  hasTag,
  isUntagged,
  resolveWithinBase,
  stripTag,
  write,
} from '../fs.js';

/**
 * Commit-ordered event appends for the filesystem world.
 *
 * The event log's ordering contract requires that log position order ==
 * commit order == visibility order: no event may ever become readable below
 * a position a reader has already observed. The filesystem backend gets
 * there the same way the postgres backend does — a per-run append
 * serializer held across the whole append, a dense per-run `seq` allocated
 * at the publish point, and event keys minted to sort strictly after the
 * run's current tail so the existing `(createdAt, eventId)` read order is
 * identical to seq order.
 *
 * Serialization is cross-process (multiple processes share one data
 * directory: a dev server plus test drivers resuming hooks out-of-band), so
 * the lock is an on-disk exclusive-create file, fronted by an in-process
 * promise chain so same-process contenders queue instead of polling.
 *
 * Crash accounting: the per-run counter file is updated AFTER each event
 * publish, so a crash mid-append can only leave the counter *behind* the
 * log, never ahead — the recovery direction that self-heals (the next
 * holder that breaks the stale lock rescans the log), and one that can
 * never mint a duplicate position while the previous holder was healthy.
 */

/** How long a held append lock is presumed live. A single append holds the
 *  lock for one `createImpl` — entity reads/writes plus one or two event
 *  publishes, milliseconds in practice — so a lock this old belongs to a
 *  crashed process and is broken (with a log rescan, see above). */
const APPEND_LOCK_STALE_MS = 30_000;

/** Poll cadence while another process holds the run's append lock. */
const APPEND_LOCK_POLL_MS = 8;

interface AppendCounterState {
  /** Number of positioned events committed to this run's log. */
  seq: number;
  /** Event id of the run's current log tail (null before the first
   *  positioned append; the tail of an adopted pre-seq prefix counts). */
  lastEventId: string | null;
  /**
   * Position of the last *decision* event — a create that carried a
   * precondition snapshot (replay-derived: step/hook/wait creations,
   * terminal transitions). Facts (`hook_received`, `step_completed`, …)
   * arrive without a snapshot and never bump it: a decision made without
   * seeing a fact stays valid — the fact is delivered at its log position
   * on replay. A fenced create is rejected iff a *foreign* decision landed
   * past its snapshot.
   */
  lastFencedSeq?: number;
  /**
   * Sibling credit: the several creates one suspension flushes share one
   * snapshot; the first establishes the credit and the rest match it
   * instead of fencing on the decisions their own batch just appended.
   * Keyed by the caller's `writerId` (falling back to its cursor) so two
   * invocations that loaded byte-identical prefixes are still told apart.
   */
  writerSnapshot?: string;
  writerBaseCount?: number;
}

/** A commit-assigned log position: dense per-run seq + tail-dominant key. */
export interface EventPosition {
  seq: number;
  eventId: string;
  createdAt: Date;
}

export interface AppendFenceParams {
  stateEventCount?: number;
  stateCursor?: string;
  writerId?: string;
}

function appendLockPath(basedir: string, runId: string, tag?: string): string {
  const name = tag ? `${runId}.append.${tag}.lock` : `${runId}.append.lock`;
  return resolveWithinBase(basedir, '.locks', 'runs', name);
}

function appendCounterPath(
  basedir: string,
  runId: string,
  tag?: string
): string {
  const name = tag ? `${runId}.seq.${tag}.json` : `${runId}.seq.json`;
  return resolveWithinBase(basedir, '.locks', 'runs', name);
}

/**
 * Scan the run's visible events for `(count, max event ulid)`. Used to
 * initialize the counter for a run that predates commit-ordered appends
 * (its existing events keep a null seq — an unpositioned prefix) and to
 * re-derive it after a stale-lock break, where a crashed holder may have
 * published an event the counter doesn't cover yet.
 */
async function scanRunEventTail(
  basedir: string,
  runId: string,
  tag?: string
): Promise<{ count: number; maxUlid: string | null }> {
  let files: string[] = [];
  try {
    files = await fs.readdir(path.join(basedir, 'events'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const prefix = `${runId}-`;
  let count = 0;
  let maxUlid: string | null = null;
  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith('.json')) {
      continue;
    }
    const fileId = file.slice(0, -'.json'.length);
    // Mirror read visibility: untagged files are visible to every tag,
    // tagged files only to their own tag.
    if (!isUntagged(fileId) && !(tag && hasTag(fileId, tag))) {
      continue;
    }
    count++;
    const candidate = stripTag(fileId).slice(prefix.length);
    if (!maxUlid || candidate > maxUlid) {
      maxUlid = candidate;
    }
  }
  return { count, maxUlid };
}

function eventIdTime(eventId: string | null): number | null {
  if (!eventId) {
    return null;
  }
  try {
    return decodeTime(eventId.replace(/^evnt_/, ''));
  } catch {
    return null;
  }
}

/**
 * One append's window on the run's counter. Created (and torn down) by
 * {@link withRunAppendLock}; the storage's `createImpl` allocates a
 * position immediately before each event publish and commits the counter
 * immediately after the publish succeeds. Positions that were allocated
 * but never committed (a validation throw, a lost publish arbitration)
 * are simply discarded — nothing was persisted, so the log stays dense.
 */
export class AppendSession {
  private state: AppendCounterState | null = null;
  private admitted = false;

  constructor(
    private readonly basedir: string,
    private readonly runId: string,
    private readonly tag: string | undefined,
    private readonly fence: AppendFenceParams | undefined,
    private readonly resyncNeeded: boolean
  ) {}

  private async load(): Promise<AppendCounterState> {
    if (this.state) {
      return this.state;
    }
    const counterPath = appendCounterPath(this.basedir, this.runId, this.tag);
    let persisted: AppendCounterState | null = null;
    if (!this.resyncNeeded) {
      try {
        persisted = JSON.parse(
          await fs.readFile(counterPath, 'utf8')
        ) as AppendCounterState;
      } catch {
        // Missing or unreadable counter — fall through to the rescan.
      }
    }
    if (
      persisted &&
      typeof persisted.seq === 'number' &&
      Number.isInteger(persisted.seq) &&
      persisted.seq >= 0
    ) {
      this.state = persisted;
      return this.state;
    }
    // Missing / corrupt counter, or a stale-lock break: re-derive from the
    // log itself. A run that predates commit-ordered appends adopts its
    // existing event count as the tail — the prior events keep a null seq
    // (an unpositioned prefix) and every later event is positioned densely
    // after them. A crashed holder can only have left the counter *behind*
    // the log (it is updated after each publish), so the scan can only move
    // the tail forward.
    const { count, maxUlid } = await scanRunEventTail(
      this.basedir,
      this.runId,
      this.tag
    );
    this.state = {
      seq: count,
      lastEventId: maxUlid ? `evnt_${maxUlid.replace(/^evnt_/, '')}` : null,
    };
    return this.state;
  }

  /**
   * Enforce the decision fence for a session whose create carries a
   * precondition snapshot. MUST be called (and must not throw) before the
   * append performs ANY side effect — entity writes, claim files, the
   * terminal marker: unlike the postgres backend, where a 412 rolls the
   * whole transaction back, a filesystem write cannot be unwound, and a
   * rejected decision that already wrote its entity strands an orphan (a
   * step that executes without its `step_created` ever entering the log; a
   * terminal marker that rejects every later resume). Idempotent; a
   * session without a snapshot admits trivially. The append lock is held
   * from here through the publish, so nothing can move the log between
   * this check and the allocation it covers.
   */
  async ensureAdmitted(): Promise<void> {
    if (this.admitted) {
      return;
    }
    if (this.fence?.stateEventCount === undefined) {
      this.admitted = true;
      return;
    }
    const state = await this.load();
    const fenceCount = this.fence.stateEventCount;
    const creditKey = this.fence.writerId ?? this.fence.stateCursor;
    const fenceBase = state.lastFencedSeq ?? 0;
    if (fenceBase <= fenceCount) {
      // Every fenced-against event in the log is inside the caller's
      // snapshot — establish the sibling credit for the rest of its
      // suspension batch. In-memory only; persisted by the commit that
      // follows a successful publish.
      state.writerSnapshot = creditKey;
      state.writerBaseCount = fenceCount;
    } else if (
      creditKey !== undefined &&
      state.writerSnapshot === creditKey &&
      state.writerBaseCount === fenceCount
    ) {
      // Sibling of the writer that established the credit.
    } else {
      throw new PreconditionFailedError(
        `Event log for run "${this.runId}" has moved past the caller's snapshot: ` +
          `fence position ${fenceBase}, snapshot loaded ${fenceCount} events`
      );
    }
    this.admitted = true;
  }

  /**
   * Allocate the next commit-ordered position. Every allocation of a
   * fenced session advances `lastFencedSeq`.
   *
   * The minted key sorts strictly after the run's current tail: its ULID
   * timestamp is bumped past the tail's when the wall clock hasn't
   * advanced, so both read orders — filename ULID and `(createdAt,
   * eventId)` — are identical to seq order regardless of any other
   * process's random ULID bits.
   */
  async allocate(): Promise<EventPosition> {
    await this.ensureAdmitted();
    const state = await this.load();

    const tailTs = eventIdTime(state.lastEventId);
    let ts = Date.now();
    if (tailTs !== null && ts <= tailTs) {
      ts = tailTs + 1;
    }
    const position: EventPosition = {
      seq: state.seq + 1,
      // Plain (non-monotonic-factory) ulid: the shared monotonic factory
      // would latch a bumped timestamp and pollute every later id minted
      // by this process. Strictly-increasing timestamps already order the
      // ids; the random bits only need uniqueness.
      eventId: `evnt_${ulid(ts)}`,
      createdAt: new Date(ts),
    };
    state.seq = position.seq;
    state.lastEventId = position.eventId;
    if (this.fence?.stateEventCount !== undefined) {
      state.lastFencedSeq = position.seq;
    }
    return position;
  }

  /**
   * Persist the counter after a successful publish. Called immediately
   * after each event write so a crash window can only leave the counter
   * behind the log (healed by the stale-break rescan), never ahead of it
   * (which would mint a permanent gap).
   */
  async commit(): Promise<void> {
    if (!this.state) {
      return;
    }
    const counterPath = appendCounterPath(this.basedir, this.runId, this.tag);
    try {
      await write(counterPath, JSON.stringify(this.state), {
        overwrite: true,
      });
    } catch (error) {
      // A counter left behind the log mints a duplicate position on the
      // next append. Force the next session onto the rescan path instead.
      await fs.unlink(counterPath).catch(() => {});
      throw error;
    }
  }
}

// In-process queue per lock path so same-process contenders chain instead
// of polling the filesystem against each other. Module-level on purpose:
// two storage instances in one process must serialize here too.
const inProcessAppendLocks = new Map<string, Promise<unknown>>();

async function acquireOnDiskLock(
  lockPath: string
): Promise<{ brokeStale: boolean }> {
  let brokeStale = false;
  for (;;) {
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
        { flag: 'wx' }
      );
      return { brokeStale };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > APPEND_LOCK_STALE_MS) {
        // The holder crashed mid-append. Break the lock and remember to
        // re-derive the counter from the log: the crash window can leave
        // the counter one event behind the log.
        await fs.unlink(lockPath).catch(() => {});
        brokeStale = true;
        continue;
      }
    } catch {
      // Lock vanished between the create attempt and the stat — retry.
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, APPEND_LOCK_POLL_MS));
  }
}

/**
 * Serialize an event append for `runId` across processes and run `fn` with
 * an {@link AppendSession} for allocating commit-ordered positions.
 *
 * Lock ordering: callers may already hold the storage's per-step /
 * per-hook in-process mutexes; this run-scoped lock is always innermost
 * and nothing inside an append ever waits on those outer mutexes, so the
 * ordering is globally consistent. Not reentrant — an append must never
 * issue another append for the same run while holding the lock.
 */
export function withRunAppendLock<T>(
  basedir: string,
  runId: string,
  tag: string | undefined,
  fence: AppendFenceParams | undefined,
  fn: (session: AppendSession) => Promise<T>
): Promise<T> {
  const lockPath = appendLockPath(basedir, runId, tag);
  const prev = inProcessAppendLocks.get(lockPath);
  const taskBox: { task?: Promise<T> } = {};
  const task = (async () => {
    if (prev) {
      // Wait for the previous append to settle; don't inherit its errors.
      await prev.catch(() => undefined);
    }
    try {
      const { brokeStale } = await acquireOnDiskLock(lockPath);
      try {
        const session = new AppendSession(
          basedir,
          runId,
          tag,
          fence,
          brokeStale
        );
        return await fn(session);
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
    } finally {
      if (inProcessAppendLocks.get(lockPath) === taskBox.task) {
        inProcessAppendLocks.delete(lockPath);
      }
    }
  })();
  taskBox.task = task;
  inProcessAppendLocks.set(lockPath, task);
  return task;
}
