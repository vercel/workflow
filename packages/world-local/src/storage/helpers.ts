import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeTime, monotonicFactory } from 'ulid';
import {
  hasTag,
  isUntagged,
  resolveWithinBase,
  stripTag,
  ulidToDate,
  withWindowsRetry,
} from '../fs.js';

/**
 * Hash a hook token to produce a filesystem-safe constraint filename.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Path of the exclusive-create lock file that commits a hook's disposal.
 * The `hook_disposed` handler writes this lock BEFORE deleting the token
 * claim and hook entity (and before appending the event to the log), so
 * its existence is the earliest durable evidence that the hook can never
 * be live again.
 */
export function hookDisposeLockPath(
  basedir: string,
  hookId: string,
  tag?: string
): string {
  const name = tag ? `${hookId}.disposed.${tag}` : `${hookId}.disposed`;
  return resolveWithinBase(basedir, '.locks', 'hooks', name);
}

/**
 * Whether a hook's disposal has been committed (its dispose lock exists).
 * Mirrors event visibility for tagged worlds: an untagged lock is visible
 * to every tag, a tagged lock only to its own tag.
 */
export async function isHookDisposalCommitted(
  basedir: string,
  hookId: string,
  tag?: string
): Promise<boolean> {
  const candidates = [hookDisposeLockPath(basedir, hookId)];
  if (tag) {
    candidates.push(hookDisposeLockPath(basedir, hookId, tag));
  }
  for (const lockPath of candidates) {
    try {
      await fs.access(lockPath);
      return true;
    } catch {
      // lock not present at this path
    }
  }
  return false;
}

/**
 * Path of the exclusive-create marker file that commits a run's terminal
 * transition. The `run_completed` / `run_failed` / `run_cancelled` handlers
 * write this marker BEFORE the run state file (and thus before the terminal
 * event is appended to the log), so its existence is the earliest durable,
 * cross-process evidence that the run can never accept a new correlated
 * event again. It is the run-level analogue of {@link hookDisposeLockPath}
 * and is consulted by `hook_received`'s publish-then-verify guard.
 */
export function runTerminalMarkerPath(
  basedir: string,
  runId: string,
  tag?: string
): string {
  const name = tag ? `${runId}.terminal.${tag}` : `${runId}.terminal`;
  return resolveWithinBase(basedir, '.locks', 'runs', name);
}

/**
 * Whether a run's terminal transition has been committed (its terminal
 * marker exists). Mirrors {@link isHookDisposalCommitted}'s tag visibility:
 * an untagged marker is visible to every tag, a tagged marker only to its
 * own tag.
 */
export async function isRunTerminalCommitted(
  basedir: string,
  runId: string,
  tag?: string
): Promise<boolean> {
  const candidates = [runTerminalMarkerPath(basedir, runId)];
  if (tag) {
    candidates.push(runTerminalMarkerPath(basedir, runId, tag));
  }
  for (const markerPath of candidates) {
    try {
      await fs.access(markerPath);
      return true;
    } catch (error) {
      // Only ENOENT proves the marker is absent. This check is what
      // rejects a resume that staged AFTER the terminal reap passed, so a
      // swallowed EACCES/EMFILE here would let that resume promote its
      // event after termination — propagate anything else and fail the
      // resume instead.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return false;
}

/**
 * Directory holding staged (not yet reader-visible) `hook_received` events
 * for a run. Staging lives under `.locks` — outside the `events` directory —
 * so no list/read path can ever observe an event that has not been promoted.
 *
 * Protocol (see the `hook_received` publish block in `events-storage.ts`):
 * a resume stages its event file here, re-checks the run-terminal marker,
 * and then promotes the staged file into `events/` with an atomic hard
 * link. A terminal transition writes its marker and then REAPS this
 * directory (unlinking every staged file) before it writes the terminal
 * run state. The unlink-vs-link race on a staged file is decided atomically
 * by the filesystem, so exactly one side wins: either the event was visible
 * before the terminal transition proceeded, or it is never visible at all.
 */
export function pendingHookEventDir(
  basedir: string,
  runId: string,
  tag?: string
): string {
  const name = tag ? `${runId}.pending.${tag}` : `${runId}.pending`;
  return resolveWithinBase(basedir, '.locks', 'runs', name);
}

/**
 * Staging path for a single `hook_received` event (see
 * {@link pendingHookEventDir}).
 */
export function pendingHookEventPath(
  basedir: string,
  runId: string,
  eventId: string,
  tag?: string
): string {
  return path.join(pendingHookEventDir(basedir, runId, tag), `${eventId}.json`);
}

/**
 * Reap every staged `hook_received` event for a run. Called by terminal
 * transitions AFTER committing the run-terminal marker and BEFORE writing
 * the terminal run state, so that:
 *
 *   - any staged event whose promotion has not happened yet is unlinked
 *     here, making its later `promoteExclusive` fail (`'missing'`) — the
 *     resume is rejected and its event is never reader-visible;
 *   - any event already promoted was, by construction, visible before this
 *     reap completed — i.e. before the run's terminal state and terminal
 *     event were written — so it legitimately precedes the termination;
 *   - any event staged after this reap started necessarily staged after the
 *     marker was committed, and the stage→promote path re-checks the marker
 *     between those two operations, so it self-rejects.
 *
 * Mirrors marker visibility for tagged worlds: reaps the untagged staging
 * directory and, when tagged, the tag's own staging directory.
 */
export async function reapPendingHookEvents(
  basedir: string,
  runId: string,
  tag?: string
): Promise<void> {
  const dirs = [pendingHookEventDir(basedir, runId)];
  if (tag) {
    dirs.push(pendingHookEventDir(basedir, runId, tag));
  }
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // No staging directory — nothing was ever staged for this run.
        continue;
      }
      // Any other failure means staged files may remain, and this reap is
      // the correctness-critical half of the arbitration: proceeding would
      // let a stalled resume promote its event AFTER the terminal state is
      // written. Abort the terminal transition instead; its retry re-runs
      // the (idempotent) marker write and reap.
      throw error;
    }
    for (const entry of entries) {
      try {
        await withWindowsRetry(() => fs.unlink(path.join(dir, entry)));
      } catch (error) {
        // ENOENT means the arbitration was already decided for this file:
        // the resume promoted (and cleaned up) or a concurrent reaper won.
        // Every other failure leaves the staged inode linkable and must
        // abort, same as the readdir failure above.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    // Best-effort only from here: a leftover empty directory is harmless
    // (a resume staging concurrently recreates it as needed).
    await fs.rmdir(dir).catch(() => {});
  }
}

/**
 * Mint an event key (eventId + createdAt) that sorts strictly AFTER every
 * reader-visible event of the run in the given tag's view.
 *
 * `events.list()` orders by `(createdAt, eventId)`, and both are normally
 * allocated at `createImpl()` entry — BEFORE the terminal transition's
 * marker + reap linearization point. A terminal invocation can therefore
 * allocate an older key, stall, lose the promote arbitration to a later
 * `hook_received` (legitimately), and then append its terminal event with
 * the stale key — replaying the accepted hook AFTER the terminal event.
 * Terminal transitions call this after their reap to re-derive the key at
 * the linearization point instead.
 *
 * Dominance argument: the returned timestamp is strictly greater than the
 * ULID timestamp of every visible event of the run (bumped past the max
 * when the wall clock hasn't advanced), so the minted ULID compares
 * lexicographically greater than every visible eventId regardless of
 * another process's random ULID bits; and `createdAt` (same timestamp) is
 * >= every visible event's `createdAt`, which was stamped at that event's
 * `createImpl()` entry — before its publish, and thus before this call.
 * Equal-`createdAt` ties fall to the strictly-dominant eventId.
 */
export async function mintRunDominantEventKey(
  basedir: string,
  runId: string,
  tag?: string
): Promise<{ eventId: string; createdAt: Date }> {
  let files: string[] = [];
  try {
    files = await fs.readdir(path.join(basedir, 'events'));
  } catch (error) {
    // Only ENOENT ("no events directory yet") means there is provably
    // nothing visible to dominate. Any other failure would silently mint a
    // wall-clock key with no dominance guarantee over an already-accepted
    // hook — abort the terminal transition instead; its retry re-runs this
    // scan.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const prefix = `${runId}-`;
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
    const candidate = stripTag(fileId).slice(prefix.length);
    if (!maxUlid || candidate > maxUlid) {
      maxUlid = candidate;
    }
  }
  let ts = Date.now();
  if (maxUlid) {
    try {
      const maxTs = decodeTime(maxUlid.replace(/^evnt_/, ''));
      if (ts <= maxTs) {
        ts = maxTs + 1;
      }
    } catch {
      // Malformed eventId in the log — fall back to the wall clock.
    }
  }
  return { eventId: `evnt_${monotonicUlid(ts)}`, createdAt: new Date(ts) };
}

/**
 * Path of the exclusive-create claim file that reserves a hook token.
 */
export function hookTokenClaimPath(basedir: string, token: string): string {
  return path.join(basedir, 'hooks', 'tokens', `${hashToken(token)}.json`);
}

/**
 * Release (delete) a token claim only if it still points at the releasing
 * hook's own `(runId, hookId)`.
 *
 * Both in-flight releasers — the `hook_disposed` handler and the
 * terminal-run `deleteAllHooksForRun` cleanup — read the hook entity and
 * then delete the claim file. Deleting unconditionally is unsafe across
 * processes: a releaser that stalls between those two operations can
 * outlive a force-release of its stale claim (see
 * `isHookTokenClaimReleasable`) and then delete the NEXT claimant's live
 * claim, transiently breaking token uniqueness. Re-reading the claim and
 * matching its identity here shrinks that window from "a stall of any
 * length" to the adjacent read/delete file ops.
 *
 * A claim that is missing, unreadable, or owned by someone else is left
 * alone — if it is genuinely stale debris, the claimant-side force-release
 * path reaps it.
 */
export async function releaseHookTokenClaimIfOwnedBy(
  basedir: string,
  token: string,
  runId: string,
  hookId: string
): Promise<void> {
  const claimPath = hookTokenClaimPath(basedir, token);
  let claim: { runId?: unknown; hookId?: unknown };
  try {
    claim = JSON.parse(await fs.readFile(claimPath, 'utf8'));
  } catch {
    return;
  }
  if (claim.runId !== runId || claim.hookId !== hookId) {
    return;
  }
  await fs.unlink(claimPath).catch(() => {});
}

/**
 * Compute the path of the recovery-marker sidecar for a specific
 * `(token, runId, hookId)` triple. Identity is encoded in the
 * filename hash so different token lifetimes (e.g. the same token
 * reused by a later run after the first run was deleted) never
 * contend on a single sidecar — without per-lifetime identity, a
 * stale marker surviving prior-run cleanup could "leak" its
 * eventId into the new lifetime's recovery and cause divergent
 * publication.
 *
 * See `events-storage.ts` for the full recovery-marker rationale.
 */
export function hookRecoveryMarkerPath(
  basedir: string,
  token: string,
  runId: string,
  hookId: string
): string {
  // Distinct from `hashToken(token)` so a token's claim file and
  // its recovery marker live at different paths AND a different
  // lifetime's recovery marker never collides with this one.
  const key = createHash('sha256')
    .update(`${token}\x00${runId}\x00${hookId}`)
    .digest('hex');
  return path.join(basedir, 'hooks', 'tokens', `${key}.recovery.json`);
}

/**
 * Create a monotonic ULID factory that ensures ULIDs are always increasing
 * even when generated within the same millisecond.
 */
export const monotonicUlid = monotonicFactory(() => Math.random());

/**
 * Creates a function to extract createdAt date from a filename based on ULID.
 * Used for efficient pagination without reading file contents.
 *
 * @param idPrefix - The prefix to strip from filenames (e.g., 'wrun', 'evnt', 'step')
 * @returns A function that extracts Date from filename, or null if not extractable
 */
export const getObjectCreatedAt = (idPrefix: string) => {
  // Compiled once per query instead of once per filename.
  const replaceRegex = new RegExp(`^${idPrefix}_`, 'g');

  return (filename: string): Date | null => {
    // Strip tag suffix before ULID extraction
    // e.g., "wrun_ABC.vitest-0.json" → "wrun_ABC.json"
    const cleanName = stripTag(filename.replace(/\.json$/, '')) + '.json';

    const dashIndex = cleanName.indexOf('-');

    if (dashIndex === -1) {
      // No dash - extract ULID from the filename (e.g., wrun_ULID.json, evnt_ULID.json)
      const ulid = cleanName.replace(/\.json$/, '').replace(replaceRegex, '');
      return ulidToDate(ulid);
    }

    // For composite keys like {runId}-{stepId}, extract from the appropriate part
    if (idPrefix === 'step') {
      // Steps use sequential IDs (step_0, step_1, etc.) - no timestamp in filename.
      // Return null to skip filename-based optimization and defer to JSON-based filtering.
      return null;
    }

    // For events: wrun_ULID-evnt_ULID.json - extract from the eventId part
    const id = cleanName.substring(dashIndex + 1).replace(/\.json$/, '');
    const ulid = id.replace(replaceRegex, '');
    return ulidToDate(ulid);
  };
};
