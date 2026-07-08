import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import { resolveWithinBase, stripTag, ulidToDate } from '../fs.js';

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
export const getObjectCreatedAt =
  (idPrefix: string) =>
  (filename: string): Date | null => {
    // Strip tag suffix before ULID extraction
    // e.g., "wrun_ABC.vitest-0.json" → "wrun_ABC.json"
    const cleanName = stripTag(filename.replace(/\.json$/, '')) + '.json';

    const replaceRegex = new RegExp(`^${idPrefix}_`, 'g');
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
