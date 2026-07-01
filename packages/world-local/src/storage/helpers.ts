import { createHash } from 'node:crypto';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { readJSON, stripTag, ulidToDate } from '../fs.js';

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
