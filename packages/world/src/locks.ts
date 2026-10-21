import { z } from 'zod';

/**
 * Entities behind the native concurrency primitive, `experimental_lock()`.
 *
 * A lock key is a distributed semaphore scoped to the World's tenant (for
 * world-vercel: owner, project and environment; for the local Worlds: the data
 * directory or database). It is the first entity in the World that is keyed
 * across runs rather than under one.
 *
 * Terminology: a *slot* is one unit of a key's concurrency, a *holder* is a
 * run occupying one, a *waiter* is a run suspended until one frees.
 *
 * ## The invariant every World must keep
 *
 * `count` is exactly the number of live holder rows for the key, and it is
 * maintained transactionally:
 *
 * - The grant is the only admission fence: `count < concurrency ? count += 1`
 *   evaluated and committed in one conditional write, together with the
 *   insert of the holder row and the bump of `grantSeq`. Read-then-write is
 *   forbidden.
 * - Every decrement (release, terminal reclaim, lease prune, admin release)
 *   happens in the same atomic operation as a conditional delete of that
 *   specific holder row, and decrements by exactly the number of rows that
 *   delete removed. A decrement that is not paired with a successful delete
 *   must be impossible: a release racing a terminal reclaim would otherwise
 *   decrement twice and over-admit permanently.
 *
 * Everything else (backoff, terminal reclaim, the optional lease) is a
 * liveness mechanism and may fire twice, late, or not at all without ever
 * admitting more than `concurrency` holders.
 */

/** Longest lock key a World must accept. */
export const LOCK_KEY_MAX_LENGTH = 512;

export const LockKeySchema = z.string().min(1).max(LOCK_KEY_MAX_LENGTH);

/**
 * Per-key semaphore state.
 *
 * `concurrency` is first-writer-wins: the value from the `lock_created` that
 * created the row. A later acquisition asking for a different value is
 * admitted against the stored one (and its `lock_acquired` reports both, so
 * the runtime can warn). A World may adopt a new value once `count` is 0.
 */
export const LockSchema = z.compile(
  z.object({
    key: LockKeySchema,
    concurrency: z.number().int().positive(),
    /** Live holder rows. Never exceeds `concurrency`. */
    count: z.number().int().nonnegative(),
    /**
     * Grants ever made for this key; the last one's fencing token. Bumped in
     * the same write as `count` on every grant, so it only increases.
     */
    grantSeq: z.number().int().nonnegative(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
);
export type Lock = z.infer<typeof LockSchema>;

/**
 * One slot held by one lock scope of one run, identified by
 * `(runId, correlationId)`. A run that acquires the same key twice holds two
 * rows under two correlation ids.
 */
export const LockHolderSchema = z.compile(
  z.object({
    key: LockKeySchema,
    runId: z.string(),
    correlationId: z.string(),
    /**
     * The key's `grantSeq` after this grant. Strictly increasing per key, so a
     * downstream system can reject a write carrying a lower token than one it
     * has already seen (the holder that wrote it has lost its slot).
     */
    fencingToken: z.number().int().positive(),
    acquiredAt: z.coerce.date(),
    /**
     * Only for an opt-in `leaseTtlMs`. Past this instant the World may prune
     * the row (with its decrement) on the next grant attempt for the key,
     * which can admit another holder while this one is still running. Absent
     * by default: a holder keeps its slot until it releases or its run ends.
     */
    leaseExpiresAt: z.coerce.date().optional(),
  })
);
export type LockHolder = z.infer<typeof LockHolderSchema>;

/**
 * Reserved for stage 2 (FIFO waitlist and direct handoff). No World writes
 * these yet; the shape is fixed now so a waitlist can be added without
 * changing the event log.
 */
export const LockWaiterSchema = z.compile(
  z.object({
    key: LockKeySchema,
    /** Per-key position, from an atomic counter. */
    seq: z.number().int().nonnegative(),
    runId: z.string(),
    correlationId: z.string(),
    grantedAt: z.coerce.date().optional(),
  })
);
export type LockWaiter = z.infer<typeof LockWaiterSchema>;

/**
 * What a `lock_created` write reports back about the caller's scope, on
 * `EventResult.lock`. The committed event says whether the slot was granted
 * (`lock_acquired`) or not (`lock_created`); this carries what the event log
 * deliberately does not:
 *
 * - `retryAt` on a pending scope is fresh on every attempt. A re-POST of a
 *   pending scope returns the scope's original `lock_created` and appends
 *   nothing, so the event's own `retryAt` is the first attempt's.
 */
export const LockAttemptSchema = z.compile(
  z.object({
    key: LockKeySchema,
    status: z.enum(['held', 'pending', 'released']),
    /** For `pending`: when the runtime should try again. World-computed. */
    retryAt: z.coerce.date().optional(),
    /** For `held` and `released`: the grant's fencing token. */
    fencingToken: z.number().int().positive().optional(),
    /** The key's stored concurrency, which may differ from the request's. */
    concurrency: z.number().int().positive().optional(),
  })
);
export type LockAttempt = z.infer<typeof LockAttemptSchema>;

/**
 * Full-jitter exponential backoff for a pending acquisition: a delay drawn
 * uniformly from `[0, min(cap, base * 2^attempt))`, floored at `minMs`.
 *
 * The reference policy. `retryAt` is World-computed so a World can change the
 * policy without an SDK release; the runtime only ever reads the result.
 * `attempt` is the number of failed attempts before this one (0 for the
 * first).
 */
export function lockRetryDelayMs(
  attempt: number,
  options: {
    baseMs?: number;
    capMs?: number;
    minMs?: number;
    random?: () => number;
  } = {}
): number {
  const baseMs = options.baseMs ?? LOCK_RETRY_BASE_MS;
  const capMs = options.capMs ?? LOCK_RETRY_CAP_MS;
  const minMs = options.minMs ?? LOCK_RETRY_MIN_MS;
  const random = options.random ?? Math.random;
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.max(minMs, Math.floor(random() * exp));
}

/**
 * The next retry instant for a waiting lock scope: the first point of the
 * scope's retry schedule that is later than `nowMs`.
 *
 * The schedule is a pure function of the scope (`seed`, e.g.
 * `${runId}:${correlationId}`) and when it started waiting: exponential
 * full-jitter backoff ({@link lockRetryDelayMs}) whose jitter is drawn from a
 * hash of the seed rather than `Math.random`. Two properties follow, and the
 * runtime depends on both:
 *
 * - Every attempt that fails within one window gets the *same* `retryAt`,
 *   whoever made it: the scope's own retry, an unrelated wake of its run, a
 *   duplicate delivery. The runtime keys its retry message on `retryAt`, so
 *   all of them collapse onto one message instead of each starting another
 *   self-renewing retry chain.
 * - A failed attempt writes nothing: no per-waiter counter to bump.
 *
 * Different scopes still get independent jitter, so waiters on one key do
 * not retry in lockstep. Past the cap the schedule is one point per
 * `capMs`-wide window, at a seeded offset within it, so the next point is
 * found in constant time however long the scope has waited.
 */
export function lockRetryAt(
  seed: string,
  waitingSinceMs: number,
  nowMs: number,
  options: { baseMs?: number; capMs?: number; minMs?: number } = {}
): number {
  const baseMs = options.baseMs ?? LOCK_RETRY_BASE_MS;
  const capMs = options.capMs ?? LOCK_RETRY_CAP_MS;
  let t = waitingSinceMs;
  let k = 0;
  // The exponential phase: until the window reaches the cap.
  for (; baseMs * 2 ** k < capMs && k < 30; k++) {
    t += lockRetryDelayMs(k, {
      ...options,
      random: () => seededUnit(`${seed}:${k}`),
    });
    if (t > nowMs) return t;
  }
  // The capped phase: point n sits at a seeded offset inside its own
  // `capMs`-wide window, so points strictly increase and the one after
  // `nowMs` is the first or second window from the one `nowMs` falls in.
  const phaseStart = t;
  const pointAt = (n: number) =>
    phaseStart + n * capMs + Math.floor(seededUnit(`${seed}:c${n}`) * capMs);
  let n = Math.max(0, Math.floor((nowMs - phaseStart) / capMs));
  while (pointAt(n) <= nowMs) n++;
  return Math.max(pointAt(n), nowMs + (options.minMs ?? LOCK_RETRY_MIN_MS));
}

/** A deterministic number in [0, 1) from a string (FNV-1a, 32-bit). */
function seededUnit(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** Reference backoff base (1s). */
export const LOCK_RETRY_BASE_MS = 1_000;
/** Reference backoff cap (30s). */
export const LOCK_RETRY_CAP_MS = 30_000;
/**
 * Floor on a retry delay. The runtime's continuation granularity is one
 * second, so a shorter delay buys nothing.
 */
export const LOCK_RETRY_MIN_MS = 1_000;
