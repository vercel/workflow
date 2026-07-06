import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isTerminalWorkflowRunStatus,
  WorkflowRunSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import {
  readJSON,
  readJSONWithFallback,
  stripTag,
  ulidToDate,
  writeExclusive,
} from '../fs.js';

/**
 * Hash a hook token to produce a filesystem-safe constraint filename.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The token-claim constraint file: the single-owner record behind a hook
 * token. A claim's lifecycle state is derived, not stored:
 * - unmaterialized start claim: `startEventId` set, no `hookId`, no
 *   `expiresAt` (reserved by `start()`, no hook entity yet)
 * - materialized: `hookId` set, no `expiresAt` (live hook entity)
 * - retained: `expiresAt` set (hook disposed / run finished; the token
 *   stays fenced until `expiresAt`)
 *
 * Claims without `ttlSeconds` are plain `createHook` token guards with no
 * retention window — they are deleted when the hook is disposed or the run
 * reaches a terminal state.
 */
export const HookTokenClaimSchema = z.object({
  token: z.string().optional(),
  // The token-claim writer has always persisted `hookId`, but an older
  // read schema omitted it, which is the bug fixed by
  // https://github.com/vercel/workflow/issues/2283. `optional()` is
  // defensive: any claim file that somehow lacks the field still parses
  // (yielding `undefined`) and falls through to the cross-hook conflict
  // branch, matching pre-fix behavior.
  hookId: z.string().optional(),
  runId: z.string(),
  // `eventId` is the canonical hook_created event ID the claiming worker
  // committed to publishing. Persisting it here turns the claim file into
  // a durable convergence key for cross-worker / cross-process retries
  // (see the hook_created branch in events-storage.ts). `optional()` for
  // backward compatibility: a legacy claim file written before this field
  // existed falls through to the recovery-marker upgrade path, which
  // atomically pins a canonical eventId via a sidecar marker.
  eventId: z.string().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  // `startEventId` is the canonical run_created event ID for claims
  // reserved by `start()` — the same convergence-key role `eventId` plays
  // for hook_created.
  startEventId: z.string().optional(),
  createdAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  tag: z.string().optional(),
});

export type HookTokenClaim = z.infer<typeof HookTokenClaimSchema>;

export function hookTokenClaimPath(basedir: string, token: string): string {
  return path.join(basedir, 'hooks', 'tokens', `${hashToken(token)}.json`);
}

/**
 * The single cross-process lock file guarding a token's claim writes (see
 * `withTokenClaimLock` in events-storage.ts). Exported so tests can plant
 * stale locks at the real path.
 */
export function hookTokenClaimLockPath(basedir: string, token: string): string {
  return path.join(basedir, '.locks', 'hooks', `${hashToken(token)}.claim`);
}

/**
 * Tolerant claim reader: malformed or partially-written claim files parse
 * to `null` (treated as "no claim") instead of failing the caller.
 */
export async function readHookTokenClaim(
  constraintPath: string
): Promise<HookTokenClaim | null> {
  try {
    return await readJSON(constraintPath, HookTokenClaimSchema);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
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

/**
 * The timestamp encoded in an event ID's ULID, or null when unparsable.
 * Used to derive a deterministic `createdAt` when converging concurrent
 * writers on a canonical event.
 */
export function eventIdToDate(eventId: string): Date | null {
  return ulidToDate(eventId.replace(/^evnt_/, ''));
}

const START_HOOK_LOCK_STALE_MS = 30_000;

/**
 * Runs `fn` under THE exclusive cross-process file lock for a token's claim
 * writes — one lock per token, shared by reclaim and materialize, so the two
 * read-check-overwrite operations mutually exclude. Returns `undefined`
 * (without running `fn`) when the lock is contended; callers treat that as
 * a retryable failure and re-validate. Locks abandoned by a crashed holder
 * (older than START_HOOK_LOCK_STALE_MS) are broken atomically via rename,
 * so two breakers can never both enter, and the holder only removes a lock
 * it still owns, so a stalled holder cannot free a breaker's lock.
 */
export async function withTokenClaimLock<T>(
  basedir: string,
  token: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const lockPath = hookTokenClaimLockPath(basedir, token);
  const owner = monotonicUlid();
  let locked = await writeExclusive(lockPath, owner);
  if (!locked) {
    const stat = await fs.stat(lockPath).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > START_HOOK_LOCK_STALE_MS) {
      const broken = await fs.rename(lockPath, `${lockPath}.${owner}`).then(
        () => true,
        () => false
      );
      if (broken) {
        await fs.unlink(`${lockPath}.${owner}`).catch(() => {});
        locked = await writeExclusive(lockPath, owner);
      }
    }
  }
  if (!locked) return undefined;

  try {
    return await fn();
  } finally {
    const current = await fs.readFile(lockPath, 'utf8').catch(() => undefined);
    if (current === owner) {
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Whether a claim is dead and its token reclaimable. A claim with a
 * retention window is dead once expired; a plain createHook guard (no
 * `ttlSeconds`) has no window and dies with its run — this also self-heals
 * guards leaked by a skipped cleanup. In both cases an active owning run
 * keeps its token fenced.
 */
export async function canReuseExpiredStartClaim(
  basedir: string,
  tag: string | undefined,
  claim: HookTokenClaim
): Promise<boolean> {
  if (claim.ttlSeconds) {
    const expiresAt =
      claim.expiresAt ??
      (claim.createdAt
        ? new Date(claim.createdAt.getTime() + claim.ttlSeconds * 1000)
        : undefined);
    // A TTL claim with no derivable expiry (malformed) is treated as live.
    if (!expiresAt || expiresAt > new Date()) return false;
  } else if (claim.expiresAt && claim.expiresAt > new Date()) {
    return false;
  }

  const run = await readJSONWithFallback(
    basedir,
    'runs',
    claim.runId,
    WorkflowRunSchema,
    claim.tag ?? tag
  );
  if (!run) return true;
  return isTerminalWorkflowRunStatus(run.status);
}
