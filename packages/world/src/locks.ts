import { z } from 'zod';
import { envFlag, envNumber } from './env-config.js';

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
 *
 * ## Stage 2: the FIFO waitlist (`locks.fifo`)
 *
 * A World that declares `WorldCapabilities.locks.fifo` queues refused
 * acquisitions and hands a freed slot straight to the head of the queue.
 * A waiter is in one of two states:
 *
 * - **queued**: a {@link LockWaiter} row without `grantedAt`, waiting;
 * - **reserved**: a row with `grantedAt`. A slot is set aside for it, and
 *   counted in `count`, until its run comes back to claim it.
 *
 * The counter invariant becomes, for every key at every instant:
 *
 * - `count = holders + reservedCount <= concurrency`;
 * - `queuedCount` and `reservedCount` equal the queued and reserved rows;
 * - `count < concurrency` implies `queuedCount = 0`: no waiter is ever left
 *   queued while a slot is free. Every path that would free a slot (release,
 *   terminal reclaim, lease prune, admin release, a reserved waiter's removal)
 *   reserves it for the head instead whenever `queuedCount > 0`;
 * - every reserved row's `seq` is lower than every queued row's.
 *
 * And the writes, each one atomic on the lock row:
 *
 * - **Grant** (a scope with no row): `count < concurrency AND queuedCount =
 *   0`. Reservations do not block it: a free slot nobody is queued for is
 *   free. Never admits past a queue.
 * - **Enqueue** (refused grant): insert the queued row at `seq = ++tailSeq`
 *   and bump `queuedCount`, conditioned on the grant still being refused
 *   (`count >= concurrency OR queuedCount > 0`); if a release freed the slot
 *   meanwhile, it is a grant instead. Idempotent on `(runId,
 *   correlationId)`. Refused past the World's waitlist cap: the World
 *   commits `lock_failed` (`reason: 'waitlist_full'`) in place of the
 *   `lock_created`.
 * - **Handoff** (any path that frees a slot while `queuedCount > 0`): stamp
 *   the head queued row's `grantedAt` (`queuedCount -= 1, reservedCount +=
 *   1`), leave `count` alone, and report the grantee as a {@link
 *   LockHandoff} on the write's `EventResult.lockHandoffs`, so the caller
 *   wakes it. With nobody queued, the path decrements `count` as in stage 1.
 * - **Claim** (a reserved scope re-POSTs `lock_created`): delete its waiter
 *   row and insert its holder row, `reservedCount -= 1`, `grantSeq += 1` (the
 *   fencing token is issued at claim), `count` unchanged; commit
 *   `lock_acquired`. A reserved scope's own claim succeeds however long it
 *   took.
 * - **Remove** (terminal reclaim, or the scope's `lock_released` while it
 *   waits): delete the row. Queued: `queuedCount -= 1`. Reserved:
 *   `reservedCount -= 1`, and its slot is handed off (or decremented).
 *
 * The conditions are on what the write *read*, never on a value observed
 * earlier. A decision that depends on "nobody else is queued" is conditioned
 * on `queuedCount` counting nobody but the caller's own row, as read in the
 * same transaction, together with that row's own state: a condition on the
 * bare number (`queuedCount = 1`) passes when the caller's row was reserved
 * and another waiter enqueued in between, and hands the slot behind the new
 * waiter.
 *
 * ### Grant grace
 *
 * A reservation older than the World's grace period ({@link
 * LOCK_GRANT_GRACE_MS} by default) is *stale*. Any write that touches the key
 * (acquire, enqueue, claim, release, a backstop retry) first moves each stale
 * reservation other than the caller's own, oldest first, while anyone is
 * queued: the head queued row is reserved instead (and reported as a
 * handoff), and the slow grantee becomes a queued row at the tail (`seq =
 * ++tailSeq`, `grantedAt` cleared). `count`, `reservedCount` and
 * `queuedCount` are unchanged. With nobody queued, a stale reservation stays
 * put: nobody else wants the slot, and the grantee can still claim it. A slow
 * grantee is never dropped, only moved back; FIFO order holds among waiters
 * that were not moved back.
 *
 * ### Waking
 *
 * The World never wakes a run. A handoff to the writing scope itself is not
 * reported: a grace move that reserves the caller's slot is claimed in the
 * same write. Every write that reserved a slot (an enqueue
 * or claim that expired a stale grant, a release, a terminal run event that
 * reclaimed a holder or a reserved waiter) returns the grantees, and the
 * runtime that made the write sends each a best-effort wake to its stored
 * {@link LockWakeTarget}. A lost wake is recovered by grace (another waiter's
 * write moves the stale reservation on) or by the grantee's own backstop
 * retry ({@link lockBackstopAt}), so no write's completion waits on one.
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
    /**
     * Stage 2 (`locks.fifo`): waiter rows not yet granted. Absent on a
     * World without a waitlist, and on a row written before it had one:
     * read as 0.
     */
    queuedCount: z.number().int().nonnegative().optional(),
    /**
     * Stage 2: waiter rows granted a reserved slot and not yet claimed.
     * Counted in `count`. Absent reads as 0.
     */
    reservedCount: z.number().int().nonnegative().optional(),
    /** Stage 2: the last waiter `seq` assigned. Absent reads as 0. */
    tailSeq: z.number().int().nonnegative().optional(),
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
 * Where to send the wake for a lock scope's run: what the run's own runtime
 * uses for its delayed self-continuation. Written by the waiter (it is the
 * only party that knows its queue and deployment) on its `lock_created`, and
 * stored on its waiter row, so a releasing run in another workflow or
 * deployment can wake it.
 */
export const LockWakeTargetSchema = z.compile(
  z.object({
    /** The run's workflow queue, as its runtime names it. */
    queueName: z.string().min(1),
    /** The run's deployment, for a World that routes by it. */
    deploymentId: z.string().optional(),
    /** The run's spec version, which selects the queue transport format. */
    specVersion: z.number().int().optional(),
  })
);
export type LockWakeTarget = z.infer<typeof LockWakeTargetSchema>;

/**
 * Stage 2 (`locks.fifo`): one lock scope waiting for a slot of `key`,
 * identified by `(runId, correlationId)`. At most one row per scope.
 */
export const LockWaiterSchema = z.compile(
  z.object({
    key: LockKeySchema,
    /**
     * Position: `++tailSeq` at enqueue, and again when grace moves the row
     * back. The head is the queued row with the lowest `seq`.
     */
    seq: z.number().int().nonnegative(),
    runId: z.string(),
    correlationId: z.string(),
    /** When the scope first queued. Kept across a move-back. */
    enqueuedAt: z.coerce.date(),
    /** Set once a slot is reserved for the scope (see grant grace). */
    grantedAt: z.coerce.date().optional(),
    /** From the scope's `lock_created`. Absent: the scope wakes by backstop. */
    wake: LockWakeTargetSchema.optional(),
  })
);
export type LockWaiter = z.infer<typeof LockWaiterSchema>;

/**
 * A slot a write reserved for a waiter (see "Waking" above), on
 * `EventResult.lockHandoffs`. The writer sends one best-effort wake per
 * handoff; the idempotency key should include `grantedAt`, since a scope
 * moved back by grace can be granted again and needs a fresh wake.
 */
export const LockHandoffSchema = z.compile(
  z.object({
    key: LockKeySchema,
    runId: z.string(),
    correlationId: z.string(),
    grantedAt: z.coerce.date(),
    wake: LockWakeTargetSchema.optional(),
  })
);
export type LockHandoff = z.infer<typeof LockHandoffSchema>;

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
    /**
     * `failed`: the scope will never be granted (its `lock_failed` is
     * committed); `reason` says why.
     */
    status: z.enum(['held', 'pending', 'released', 'failed']),
    /**
     * For `pending`: when the runtime should try again. World-computed: the
     * stage-1 backoff, or for a queued scope its backstop
     * ({@link lockBackstopAt}).
     */
    retryAt: z.coerce.date().optional(),
    /**
     * For `pending` on a FIFO World: the scope's waiter row state. A queued
     * scope is woken by a handoff; it retries only at its backstop.
     */
    waiter: z.enum(['queued', 'reserved']).optional(),
    /** For `failed`. */
    reason: z.enum(['waitlist_full']).optional(),
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
  options: {
    baseMs?: number;
    capMs?: number;
    minMs?: number;
    /**
     * A flat schedule of one point per `periodMs`-wide window, at a seeded
     * offset in each: shorthand for `baseMs = capMs = periodMs`. The
     * backstop of a queued scope ({@link lockBackstopAt}).
     */
    periodMs?: number;
  } = {}
): number {
  const baseMs = options.periodMs ?? options.baseMs ?? LOCK_RETRY_BASE_MS;
  const capMs = options.periodMs ?? options.capMs ?? LOCK_RETRY_CAP_MS;
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

/**
 * The backstop retry of a queued scope on a FIFO World: {@link lockRetryAt}
 * with a flat `periodMs` schedule ({@link LOCK_BACKSTOP_MS} by default), from
 * when it queued. A queued scope is woken by its handoff; the backstop only
 * recovers a lost wake, so one point per window is enough, and every attempt
 * within a window gets the same point, so duplicate wakes still collapse onto
 * one retry message.
 */
export function lockBackstopAt(
  seed: string,
  queuedSinceMs: number,
  nowMs: number,
  periodMs: number = LOCK_BACKSTOP_MS
): number {
  return lockRetryAt(seed, queuedSinceMs, nowMs, { periodMs });
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

/** Reference backstop period for a queued scope (5 minutes). */
export const LOCK_BACKSTOP_MS = 300_000;
/**
 * Reference grant grace (60s): how long a reserved slot waits for its grantee
 * to claim it before a write that touches the key may move it on.
 */
export const LOCK_GRANT_GRACE_MS = 60_000;
/** Reference cap on a key's waiter rows (queued plus reserved). */
export const LOCK_WAITLIST_CAP = 100_000;

/**
 * The waitlist policy of a World that implements stage 2 itself (the Local
 * and Postgres Worlds), from the environment, read per write so a test or an
 * operator can change it without a restart:
 *
 * - `WORKFLOW_LOCKS_FIFO` (default on): `0` keeps the stage-1 behavior, where
 *   a refused acquisition polls instead of queueing. The World then does not
 *   declare `locks.fifo`.
 * - `WORKFLOW_LOCK_GRANT_GRACE_MS` (default {@link LOCK_GRANT_GRACE_MS}).
 * - `WORKFLOW_LOCK_WAITLIST_CAP` (default {@link LOCK_WAITLIST_CAP}).
 * - `WORKFLOW_LOCK_BACKSTOP_MS` (default {@link LOCK_BACKSTOP_MS}).
 */
export interface LockWaitlistPolicy {
  fifo: boolean;
  graceMs: number;
  waitlistCap: number;
  backstopMs: number;
}

export function getLockWaitlistPolicy(): LockWaitlistPolicy {
  return {
    fifo: envFlag('WORKFLOW_LOCKS_FIFO', true),
    graceMs: envNumber('WORKFLOW_LOCK_GRANT_GRACE_MS', LOCK_GRANT_GRACE_MS, {
      integer: true,
    }),
    waitlistCap: envNumber('WORKFLOW_LOCK_WAITLIST_CAP', LOCK_WAITLIST_CAP, {
      integer: true,
      min: 1,
    }),
    backstopMs: envNumber('WORKFLOW_LOCK_BACKSTOP_MS', LOCK_BACKSTOP_MS, {
      integer: true,
      min: 1_000,
    }),
  };
}
