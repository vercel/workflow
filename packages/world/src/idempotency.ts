import { z } from 'zod';

/**
 * Run idempotency keys: `start({ experimental_idempotencyKey })`.
 *
 * Within a scope of (tenant, `workflowName`, key), at most one run holds a key
 * at a time. The World enforces it in the same write that creates the run and
 * its `run_created` event; see `WorldCapabilities.runIdempotencyKeys` for the
 * full contract.
 */

/** Longest idempotency key accepted, in UTF-16 code units (`string.length`). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

/**
 * How long a closed holder keeps its key when the caller's start set no TTL:
 * 24 hours, measured from when the holder closed.
 */
export const IDEMPOTENCY_KEY_TTL_DEFAULT_MS = 86_400_000;

/** Shortest accepted idempotency key TTL: 1 second. */
export const IDEMPOTENCY_KEY_TTL_MIN_MS = 1_000;

/** Longest accepted idempotency key TTL: 30 days. */
export const IDEMPOTENCY_KEY_TTL_MAX_MS = 2_592_000_000;

/**
 * Whether a new start may take a key over from a holder that has closed
 * (`completed`, `failed` or `cancelled`) but is still inside its TTL window.
 * Supplied by the new caller. A `pending` or `running` holder always keeps its
 * key, whatever the policy.
 *
 * - `ALLOW_DUPLICATE`: take the key over from any closed holder.
 * - `ALLOW_DUPLICATE_FAILED_ONLY`: take it over from a `failed` or
 *   `cancelled` holder; a `completed` holder keeps it.
 * - `REJECT_DUPLICATE` (default): every holder keeps it until its window
 *   expires.
 */
export const IdempotencyKeyReusePolicySchema = z.compile(
  z.enum(['ALLOW_DUPLICATE', 'ALLOW_DUPLICATE_FAILED_ONLY', 'REJECT_DUPLICATE'])
);
export type IdempotencyKeyReusePolicy = z.infer<
  typeof IdempotencyKeyReusePolicySchema
>;

/**
 * What `start()` does when the World refuses a key because another run holds
 * it (`WorkflowRunAlreadyStartedError`). Applied by the runtime, never sent to
 * the World.
 *
 * - `USE_EXISTING` (default): return a handle to the holding run.
 * - `FAIL`: rethrow the refusal.
 */
export const IdempotencyKeyConflictPolicySchema = z.compile(
  z.enum(['USE_EXISTING', 'FAIL'])
);
export type IdempotencyKeyConflictPolicy = z.infer<
  typeof IdempotencyKeyConflictPolicySchema
>;

/** A lone UTF-16 surrogate: a high one not followed by a low one, or the reverse. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether a string is well-formed UTF-16 (no lone surrogates), the same test
 * as `String.prototype.isWellFormed()`. A key with a lone surrogate has no
 * UTF-8 encoding, so a backend cannot store it and refuses it.
 */
export function isWellFormedString(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/** An idempotency key as it travels on `run_created` and on a run. */
export const IdempotencyKeySchema = z.compile(
  z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).refine(isWellFormedString, {
    message: 'idempotencyKey must be well-formed UTF-16 (no lone surrogates)',
  })
);

/** A resolved idempotency key TTL in whole milliseconds, within bounds. */
export const IdempotencyKeyTtlMsSchema = z.compile(
  z
    .number()
    .int()
    .min(IDEMPOTENCY_KEY_TTL_MIN_MS)
    .max(IDEMPOTENCY_KEY_TTL_MAX_MS)
);

/** What a World does with a key another run holds. */
export type IdempotencyKeyClaimDecision = 'take-over' | 'refuse';

/**
 * The decision table of `WorldCapabilities.runIdempotencyKeys`, for a claim
 * that names a run other than the one being created.
 *
 * - A holder that no longer exists frees the key.
 * - A `pending` or `running` holder keeps it, whatever the policy or TTL.
 * - A closed holder (`completed`, `failed`, `cancelled`) keeps it until
 *   `completedAt + ttlMs`, where `ttlMs` is the TTL its own start recorded
 *   on the claim. Inside that window the new caller's `reusePolicy` decides:
 *   `ALLOW_DUPLICATE` takes the key, `ALLOW_DUPLICATE_FAILED_ONLY` takes it
 *   only from a `failed` or `cancelled` holder, `REJECT_DUPLICATE` never.
 *
 * A closed holder without a `completedAt` is treated as still inside its
 * window. Pure, so every World evaluates the table the same way; the World
 * still owns making the takeover atomic.
 */
export function decideIdempotencyKeyClaim(
  holder: { status: string; completedAt?: Date | null } | null | undefined,
  claim: { ttlMs: number },
  reusePolicy: IdempotencyKeyReusePolicy,
  now: number = Date.now()
): IdempotencyKeyClaimDecision {
  if (!holder) return 'take-over';
  if (holder.status === 'pending' || holder.status === 'running') {
    return 'refuse';
  }
  const completedAt = holder.completedAt?.getTime();
  if (completedAt !== undefined && now > completedAt + claim.ttlMs) {
    return 'take-over';
  }
  if (reusePolicy === 'ALLOW_DUPLICATE') return 'take-over';
  if (reusePolicy === 'ALLOW_DUPLICATE_FAILED_ONLY') {
    return holder.status === 'failed' || holder.status === 'cancelled'
      ? 'take-over'
      : 'refuse';
  }
  return 'refuse';
}
