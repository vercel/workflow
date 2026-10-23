/**
 * Native concurrency locks (`experimental_lock()`) for the Postgres World: a
 * per-key counter with a FIFO waitlist and direct handoff (the contract in
 * `@workflow/world`'s `locks.ts`), or polling waiters with
 * `WORKFLOW_LOCKS_FIFO=0`.
 *
 * `workflow_locks.count` equals the key's rows in `workflow_lock_holders`
 * plus its reserved rows in `workflow_lock_waiters` (`reserved_count`), and
 * `queued_count` its queued rows. Every statement keeps them so:
 *
 * - A grant is one conditional `UPDATE ... SET count = count + 1, grant_seq =
 *   grant_seq + 1 WHERE count < concurrency`, in the transaction that inserts
 *   the holder row and the `lock_acquired` event.
 * - Every decrement (release, lease prune, terminal reclaim, admin release)
 *   is a `DELETE ... RETURNING` of specific holder rows feeding an `UPDATE`
 *   that subtracts exactly how many rows that delete removed, in one
 *   statement. A release racing a terminal reclaim deletes the row once: the
 *   loser's `DELETE` returns nothing and subtracts nothing.
 *
 * - Every path that frees a slot (release, lease prune, terminal
 *   reclaim, admin release, a reserved waiter's removal) reserves it for the
 *   head of the queue instead whenever anyone is queued, so `count` drops
 *   only when nobody waits. Every one of these writes, the grant and the
 *   enqueue included, holds the key row `FOR UPDATE`, which serializes them:
 *   a release cannot observe an empty queue while an enqueue is committing
 *   behind it, so the release-vs-enqueue race the contract conditions against
 *   cannot occur.
 *
 * Lock order, to keep grants, releases and reclaims deadlock-free: the run
 * row first (a grant or release takes it `FOR SHARE`, the terminal
 * transition's `UPDATE` takes it exclusively), then key rows (`FOR UPDATE`,
 * sorted when there are several), then holder rows. The run row lock is
 * also what orders a grant against its run's terminal reclaim: a grant
 * either commits before the terminal transition locks the run (and the
 * reclaim deletes its holder row) or reads the run as terminal and refuses.
 */
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import {
  type Event,
  EventSchema,
  getLockWaitlistPolicy,
  isTerminalWorkflowRunStatus,
  type Lock,
  type LockAttempt,
  type LockHandoff,
  type LockHolder,
  type LockWaiter,
  type LockWaitlistPolicy,
  type LockWakeTarget,
  lockBackstopAt,
  lockRetryAt,
  type Storage,
} from '@workflow/world';
import { and, asc, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import type {
  Drizzle,
  DrizzleHandle,
  DrizzleTransaction,
} from './drizzle/index.js';
import { Schema } from './drizzle/index.js';
import { compact } from './util.js';

const LOCK_EVENT_TYPES = [
  'lock_created',
  'lock_acquired',
  'lock_failed',
  'lock_released',
] as const;

const READ_COMMITTED = { isolationLevel: 'read committed' } as const;

/** Inserts this create's own event on `tx` and returns it as stored. */
export type LockEventInserter = (
  tx: DrizzleTransaction,
  event: {
    eventType:
      | 'lock_created'
      | 'lock_acquired'
      | 'lock_failed'
      | 'lock_released';
    correlationId: string;
    eventData: Record<string, unknown>;
  }
) => Promise<Event>;

interface LockScopeEvents {
  created?: Event;
  acquired?: Event;
  failed?: Event;
  released?: Event;
}

/** A lock write's result, as `events.create` returns it. */
export interface LockWriteResult {
  event: Event;
  lock: LockAttempt;
  lockHandoffs?: LockHandoff[];
}

async function scopeEvents(
  tx: DrizzleTransaction,
  runId: string,
  correlationId: string
): Promise<LockScopeEvents> {
  const rows = await tx
    .select()
    .from(Schema.events)
    .where(
      and(
        eq(Schema.events.runId, runId),
        eq(Schema.events.correlationId, correlationId),
        inArray(Schema.events.eventType, [...LOCK_EVENT_TYPES])
      )
    );
  const scope: LockScopeEvents = {};
  for (const row of rows) {
    row.eventData ||= row.eventDataJson;
    const event = EventSchema.parse(compact(row));
    if (event.eventType === 'lock_created') scope.created = event;
    if (event.eventType === 'lock_acquired') scope.acquired = event;
    if (event.eventType === 'lock_failed') scope.failed = event;
    if (event.eventType === 'lock_released') scope.released = event;
  }
  return scope;
}

/** The key a scope's first lock event named, which every later one must. */
function scopeKeyOf(scope: LockScopeEvents): string | undefined {
  const first =
    scope.created ?? scope.acquired ?? scope.failed ?? scope.released;
  return (first as { eventData?: { key?: string } } | undefined)?.eventData
    ?.key;
}

/** Takes the run row `FOR SHARE` and refuses a terminal run. */
async function lockLiveRun(
  tx: DrizzleTransaction,
  runId: string,
  action: string
): Promise<void> {
  const [run] = await tx
    .select({ status: Schema.runs.status })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, runId))
    .for('share')
    .limit(1);
  if (run && isTerminalWorkflowRunStatus(run.status)) {
    throw new EntityConflictError(
      `Cannot ${action} a lock on run in terminal state "${run.status}"`
    );
  }
}

/** Upserts the key's row and takes it `FOR UPDATE`. */
async function lockKeyRow(
  tx: DrizzleTransaction,
  key: string,
  concurrency: number
) {
  await tx
    .insert(Schema.locks)
    .values({ key, concurrency })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(Schema.locks)
    .where(eq(Schema.locks.key, key))
    .for('update')
    .limit(1);
  if (!row) {
    throw new WorkflowWorldError(`Lock "${key}" could not be created`, {
      status: 500,
    });
  }
  return row;
}

/**
 * One slot-taking row of `key` was just deleted: reserve its slot for the head
 * of the queue (`queued_count - 1, reserved_count + 1`, `count` unchanged) or,
 * with nobody queued, give it back (`count - 1`). Call with the key row held
 * `FOR UPDATE`.
 */
async function freeSlot(
  tx: DrizzleTransaction,
  key: string,
  handoffs: LockHandoff[]
): Promise<void> {
  const handed = await handOffHead(tx, key);
  if (handed) {
    handoffs.push(handed);
    await tx
      .update(Schema.locks)
      .set({
        queuedCount: sql`${Schema.locks.queuedCount} - 1`,
        reservedCount: sql`${Schema.locks.reservedCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(Schema.locks.key, key));
    return;
  }
  await tx
    .update(Schema.locks)
    .set({ count: sql`${Schema.locks.count} - 1`, updatedAt: new Date() })
    .where(eq(Schema.locks.key, key));
}

/** Stamps `granted_at` on the head queued row; the counters are the caller's. */
async function handOffHead(
  tx: DrizzleTransaction,
  key: string
): Promise<LockHandoff | null> {
  const result = await tx.execute<{
    run_id: string;
    correlation_id: string;
    granted_at: Date | string;
    wake: LockWakeTarget | null;
  }>(sql`
    UPDATE ${Schema.lockWaiters}
    SET granted_at = now()
    WHERE (run_id, correlation_id) = (
      SELECT run_id, correlation_id FROM ${Schema.lockWaiters}
      WHERE key = ${key} AND granted_at IS NULL
      ORDER BY seq
      LIMIT 1
    )
    RETURNING run_id, correlation_id, granted_at, wake
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    key,
    runId: row.run_id,
    correlationId: row.correlation_id,
    grantedAt: new Date(row.granted_at),
    ...(row.wake && { wake: row.wake }),
  };
}

/** Deletes the key's expired leases, handing each freed slot off. */
async function pruneExpiredLeases(
  tx: DrizzleTransaction,
  key: string,
  handoffs: LockHandoff[]
): Promise<void> {
  const pruned = await tx
    .delete(Schema.lockHolders)
    .where(
      and(
        eq(Schema.lockHolders.key, key),
        sql`${Schema.lockHolders.leaseExpiresAt} <= now()`
      )
    )
    .returning({ runId: Schema.lockHolders.runId });
  for (const _row of pruned) await freeSlot(tx, key, handoffs);
}

/**
 * Grant grace: move each stale reservation of `key` other than the caller's
 * on to the head of the queue, oldest first, while anyone is queued; the slow
 * grantee goes back to the tail. The counters do not change.
 */
async function expireStaleGrants(
  tx: DrizzleTransaction,
  key: string,
  policy: LockWaitlistPolicy,
  caller: { runId: string; correlationId: string } | undefined,
  handoffs: LockHandoff[]
): Promise<void> {
  const stale = await tx
    .select({
      runId: Schema.lockWaiters.runId,
      correlationId: Schema.lockWaiters.correlationId,
    })
    .from(Schema.lockWaiters)
    .where(
      and(
        eq(Schema.lockWaiters.key, key),
        isNotNull(Schema.lockWaiters.grantedAt),
        sql`${Schema.lockWaiters.grantedAt} <= now() - make_interval(secs => ${policy.graceMs / 1000})`,
        ...(caller
          ? [
              or(
                ne(Schema.lockWaiters.runId, caller.runId),
                ne(Schema.lockWaiters.correlationId, caller.correlationId)
              ),
            ]
          : [])
      )
    )
    .orderBy(asc(Schema.lockWaiters.seq));
  for (const row of stale) {
    const handed = await handOffHead(tx, key);
    if (!handed) return;
    handoffs.push(handed);
    const [lock] = await tx
      .update(Schema.locks)
      .set({ tailSeq: sql`${Schema.locks.tailSeq} + 1`, updatedAt: new Date() })
      .where(eq(Schema.locks.key, key))
      .returning({ tailSeq: Schema.locks.tailSeq });
    await tx
      .update(Schema.lockWaiters)
      .set({ grantedAt: null, seq: lock.tailSeq })
      .where(
        and(
          eq(Schema.lockWaiters.runId, row.runId),
          eq(Schema.lockWaiters.correlationId, row.correlationId)
        )
      );
  }
}

/** The caller's own reservation is not a handoff (see locks.ts, "Waking"). */
function othersOf(
  handoffs: LockHandoff[],
  runId: string,
  correlationId: string
): LockHandoff[] | undefined {
  const others = handoffs.filter(
    (h) => h.runId !== runId || h.correlationId !== correlationId
  );
  return others.length > 0 ? others : undefined;
}

/** The transaction's `now()`: the `created_at` its inserts default to. */
async function transactionNow(tx: DrizzleTransaction): Promise<number> {
  const result = await tx.execute<{ now: Date | string }>(
    sql`SELECT now() AS now`
  );
  return new Date(result.rows[0]?.now ?? Date.now()).getTime();
}

const fencingTokenOf = (event: Event) =>
  (event as { eventData: { fencingToken: number } }).eventData.fencingToken;

export async function acquireLock(
  handle: DrizzleHandle,
  insertEvent: LockEventInserter,
  runId: string,
  data: {
    correlationId: string;
    eventData: {
      key: string;
      concurrency: number;
      leaseTtlMs?: number;
      wake?: LockWakeTarget;
    };
  }
): Promise<LockWriteResult> {
  const { correlationId } = data;
  const { key, concurrency, leaseTtlMs, wake } = data.eventData;
  const policy = getLockWaitlistPolicy();
  // A transaction, or a savepoint inside the caller's (the in-band fence).
  const drizzle = handle as Drizzle;
  return drizzle.transaction(async (tx) => {
    await lockLiveRun(tx, runId, 'acquire');
    let row = await lockKeyRow(tx, key, concurrency);
    // Read under the key row's lock, so a concurrent delivery's grant is
    // visible. A mismatched key throws, rolling back the row upsert.
    const scope = await scopeEvents(tx, runId, correlationId);
    const scopeKey = scopeKeyOf(scope);
    if (scopeKey !== undefined && scopeKey !== key) {
      throw new WorkflowWorldError(
        `Lock scope "${correlationId}" was created for key "${scopeKey}", not "${key}"`,
        { status: 409 }
      );
    }
    if (scope.acquired) {
      return {
        event: scope.acquired,
        lock: {
          key,
          status: scope.released ? 'released' : 'held',
          fencingToken: fencingTokenOf(scope.acquired),
          concurrency: row.concurrency,
        },
      };
    }
    // The scope withdrew while it waited (its lock_released left the
    // queue). A later re-POST must not queue or grant it again: nothing
    // would ever release that slot.
    if (scope.released) {
      return {
        event: scope.created ?? scope.released,
        lock: { key, status: 'released', concurrency: row.concurrency },
      };
    }
    if (scope.failed) {
      return {
        event: scope.failed,
        lock: {
          key,
          status: 'failed',
          reason: 'waitlist_full',
          concurrency: row.concurrency,
        },
      };
    }

    const handoffs: LockHandoff[] = [];
    const withHandoffs = (result: LockWriteResult): LockWriteResult => {
      const lockHandoffs = othersOf(handoffs, runId, correlationId);
      return lockHandoffs ? { ...result, lockHandoffs } : result;
    };

    await pruneExpiredLeases(tx, key, handoffs);
    await expireStaleGrants(
      tx,
      key,
      policy,
      { runId, correlationId },
      handoffs
    );
    // First writer wins on concurrency; a key nobody holds or waits on adopts
    // the request's value. Same statement shape as the grant: conditional on
    // the row's own state.
    if (row.concurrency !== concurrency) {
      const [adopted] = await tx
        .update(Schema.locks)
        .set({ concurrency, updatedAt: new Date() })
        .where(
          and(
            eq(Schema.locks.key, key),
            eq(Schema.locks.count, 0),
            eq(Schema.locks.queuedCount, 0)
          )
        )
        .returning();
      if (adopted) row = adopted;
    }

    const [own] = await tx
      .select()
      .from(Schema.lockWaiters)
      .where(
        and(
          eq(Schema.lockWaiters.runId, runId),
          eq(Schema.lockWaiters.correlationId, correlationId)
        )
      )
      .limit(1);

    const commitGrant = async (granted: typeof Schema.locks.$inferSelect) => {
      const leaseExpiresAt =
        leaseTtlMs !== undefined
          ? new Date(Date.now() + leaseTtlMs)
          : undefined;
      await tx.insert(Schema.lockHolders).values({
        runId,
        correlationId,
        key,
        fencingToken: granted.grantSeq,
        leaseExpiresAt,
      });
      const event = await insertEvent(tx, {
        eventType: 'lock_acquired',
        correlationId,
        eventData: {
          key,
          concurrency,
          effectiveConcurrency: granted.concurrency,
          fencingToken: granted.grantSeq,
          ...(leaseTtlMs !== undefined && { leaseTtlMs }),
          ...(leaseExpiresAt && { leaseExpiresAt }),
        },
      });
      return withHandoffs({
        event,
        lock: {
          key,
          status: 'held',
          fencingToken: granted.grantSeq,
          concurrency: granted.concurrency,
        },
      });
    };

    // Claim: the scope's reserved slot, however late it came for it. The
    // slot is already counted; the fence is issued now, in grant order.
    if (own?.grantedAt) {
      await tx
        .delete(Schema.lockWaiters)
        .where(
          and(
            eq(Schema.lockWaiters.runId, runId),
            eq(Schema.lockWaiters.correlationId, correlationId)
          )
        );
      const [claimed] = await tx
        .update(Schema.locks)
        .set({
          reservedCount: sql`${Schema.locks.reservedCount} - 1`,
          grantSeq: sql`${Schema.locks.grantSeq} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(Schema.locks.key, key))
        .returning();
      return commitGrant(claimed);
    }

    // The admission fence: a free slot nobody is queued for.
    if (!own) {
      const [granted] = await tx
        .update(Schema.locks)
        .set({
          count: sql`${Schema.locks.count} + 1`,
          grantSeq: sql`${Schema.locks.grantSeq} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(Schema.locks.key, key),
            lt(Schema.locks.count, Schema.locks.concurrency),
            eq(Schema.locks.queuedCount, 0)
          )
        )
        .returning();
      if (granted) return commitGrant(granted);
    }

    const pending = async (lock: LockAttempt): Promise<LockWriteResult> => {
      if (scope.created) {
        return withHandoffs({ event: scope.created, lock });
      }
      const event = await insertEvent(tx, {
        eventType: 'lock_created',
        correlationId,
        eventData: {
          key,
          concurrency,
          ...(leaseTtlMs !== undefined && { leaseTtlMs }),
          ...(lock.retryAt && { retryAt: lock.retryAt }),
          ...(wake && { wake }),
        },
      });
      return withHandoffs({ event, lock });
    };

    if (!policy.fifo && !own) {
      // Polling. Measured from what the scope's lock_created records as its
      // createdAt, on every attempt including the first: the column default
      // is this transaction's `now()`, so the first refusal reads it here
      // rather than using the app clock, or its schedule would be a few ms
      // off from every later attempt's and its retry messages would not
      // collapse.
      const waitingSince = scope.created
        ? +scope.created.createdAt
        : await transactionNow(tx);
      return pending({
        key,
        status: 'pending',
        retryAt: new Date(
          lockRetryAt(`${runId}:${correlationId}`, waitingSince, Date.now())
        ),
        concurrency: row.concurrency,
      });
    }

    let enqueuedAt = own?.enqueuedAt;
    if (!enqueuedAt) {
      const [current] = await tx
        .select()
        .from(Schema.locks)
        .where(eq(Schema.locks.key, key))
        .limit(1);
      // Refused past the cap: journaled, so the workflow's catch of
      // LockWaitlistFullError replays deterministically.
      if (current.queuedCount + current.reservedCount >= policy.waitlistCap) {
        const event = await insertEvent(tx, {
          eventType: 'lock_failed',
          correlationId,
          eventData: {
            key,
            concurrency,
            reason: 'waitlist_full',
            waitlistCap: policy.waitlistCap,
          },
        });
        return withHandoffs({
          event,
          lock: {
            key,
            status: 'failed',
            reason: 'waitlist_full',
            concurrency: current.concurrency,
          },
        });
      }
      // Enqueue at the tail. The key row is held, so the grant above and
      // this enqueue saw the same state: no release can slip between them.
      const [tail] = await tx
        .update(Schema.locks)
        .set({
          tailSeq: sql`${Schema.locks.tailSeq} + 1`,
          queuedCount: sql`${Schema.locks.queuedCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(Schema.locks.key, key))
        .returning({ tailSeq: Schema.locks.tailSeq });
      const [inserted] = await tx
        .insert(Schema.lockWaiters)
        .values({
          runId,
          correlationId,
          key,
          seq: tail.tailSeq,
          ...(wake && { wake }),
        })
        .returning({ enqueuedAt: Schema.lockWaiters.enqueuedAt });
      enqueuedAt = inserted.enqueuedAt;
    }
    return pending({
      key,
      status: 'pending',
      waiter: 'queued',
      retryAt: new Date(
        lockBackstopAt(
          `${runId}:${correlationId}`,
          +enqueuedAt,
          Date.now(),
          policy.backstopMs
        )
      ),
      concurrency: row.concurrency,
    });
  }, READ_COMMITTED);
}

/**
 * Deletes one scope's waiter row of `key` with its counter update, handing a
 * reserved row's slot off. Returns whether a row was deleted.
 */
async function removeWaiter(
  tx: DrizzleTransaction,
  key: string,
  runId: string,
  correlationId: string,
  handoffs: LockHandoff[]
): Promise<boolean> {
  const [removed] = await tx
    .delete(Schema.lockWaiters)
    .where(
      and(
        eq(Schema.lockWaiters.runId, runId),
        eq(Schema.lockWaiters.correlationId, correlationId)
      )
    )
    .returning({ grantedAt: Schema.lockWaiters.grantedAt });
  if (!removed) return false;
  if (removed.grantedAt) {
    await tx
      .update(Schema.locks)
      .set({ reservedCount: sql`${Schema.locks.reservedCount} - 1` })
      .where(eq(Schema.locks.key, key));
    await freeSlot(tx, key, handoffs);
  } else {
    await tx
      .update(Schema.locks)
      .set({
        queuedCount: sql`${Schema.locks.queuedCount} - 1`,
        updatedAt: new Date(),
      })
      .where(eq(Schema.locks.key, key));
  }
  return true;
}

/** Deletes one holder row of `key`, handing its slot off. */
async function removeHolder(
  tx: DrizzleTransaction,
  key: string,
  runId: string,
  correlationId: string,
  handoffs: LockHandoff[]
): Promise<boolean> {
  const [removed] = await tx
    .delete(Schema.lockHolders)
    .where(
      and(
        eq(Schema.lockHolders.runId, runId),
        eq(Schema.lockHolders.correlationId, correlationId)
      )
    )
    .returning({ key: Schema.lockHolders.key });
  if (!removed) return false;
  await freeSlot(tx, key, handoffs);
  return true;
}

export async function releaseLock(
  handle: DrizzleHandle,
  insertEvent: LockEventInserter,
  runId: string,
  data: { correlationId: string; eventData: { key: string } }
): Promise<LockWriteResult> {
  const { correlationId } = data;
  const { key } = data.eventData;
  const policy = getLockWaitlistPolicy();
  const drizzle = handle as Drizzle;
  return drizzle.transaction(async (tx) => {
    await lockLiveRun(tx, runId, 'release');
    const [row] = await tx
      .select()
      .from(Schema.locks)
      .where(eq(Schema.locks.key, key))
      .for('update')
      .limit(1);
    const scope = await scopeEvents(tx, runId, correlationId);
    // A release must name the key the scope holds or waits on: freeing a
    // slot on any other would leave both keys' counters wrong.
    const scopeKey = scopeKeyOf(scope);
    if (scopeKey !== undefined && scopeKey !== key) {
      throw new EntityConflictError(
        `Lock scope "${correlationId}" does not hold "${key}"`
      );
    }
    // A scope that holds its slot, or one still waiting for it.
    const [waiting] =
      row && !scope.acquired
        ? await tx
            .select({ key: Schema.lockWaiters.key })
            .from(Schema.lockWaiters)
            .where(
              and(
                eq(Schema.lockWaiters.runId, runId),
                eq(Schema.lockWaiters.correlationId, correlationId),
                eq(Schema.lockWaiters.key, key)
              )
            )
            .limit(1)
        : [];
    if (!row || (!scope.acquired && !waiting)) {
      throw new EntityConflictError(
        `Lock scope "${correlationId}" does not hold "${key}"`
      );
    }
    if (scope.released) {
      throw new EntityConflictError(
        `Lock scope "${correlationId}" already released "${key}"`
      );
    }
    const handoffs: LockHandoff[] = [];
    if (scope.acquired) {
      await removeHolder(tx, key, runId, correlationId, handoffs);
    } else {
      await removeWaiter(tx, key, runId, correlationId, handoffs);
    }
    await expireStaleGrants(tx, key, policy, undefined, handoffs);
    const event = await insertEvent(tx, {
      eventType: 'lock_released',
      correlationId,
      eventData: { key },
    });
    return {
      event,
      lock: { key, status: 'released' },
      ...(handoffs.length > 0 && { lockHandoffs: handoffs }),
    };
  }, READ_COMMITTED);
}

/**
 * Terminal reclaim, inside the run's terminal transition (after its run row
 * `UPDATE`): lock the run's keys in a stable order, then delete its holder and
 * waiter rows, each with its counter update, handing every freed slot to its
 * key's queue. Returns the handoffs, for the terminal event's result.
 */
export async function reclaimRunLocks(
  tx: DrizzleTransaction,
  runId: string
): Promise<LockHandoff[]> {
  const holders = await tx
    .select({
      key: Schema.lockHolders.key,
      correlationId: Schema.lockHolders.correlationId,
    })
    .from(Schema.lockHolders)
    .where(eq(Schema.lockHolders.runId, runId));
  const waiters = await tx
    .select({
      key: Schema.lockWaiters.key,
      correlationId: Schema.lockWaiters.correlationId,
    })
    .from(Schema.lockWaiters)
    .where(eq(Schema.lockWaiters.runId, runId));
  const keys = [...new Set([...holders, ...waiters].map((r) => r.key))];
  if (keys.length === 0) return [];
  await tx
    .select({ key: Schema.locks.key })
    .from(Schema.locks)
    .where(inArray(Schema.locks.key, keys))
    .orderBy(asc(Schema.locks.key))
    .for('update');
  const handoffs: LockHandoff[] = [];
  // A slot freed here can land on another of this run's own waiter rows
  // before the loop deletes it, which frees it again; those intermediate
  // handoffs are dropped from the result.
  for (const w of waiters) {
    await removeWaiter(tx, w.key, runId, w.correlationId, handoffs);
  }
  for (const h of holders) {
    await removeHolder(tx, h.key, runId, h.correlationId, handoffs);
  }
  return handoffs.filter((h) => h.runId !== runId);
}

function toHolder(row: typeof Schema.lockHolders.$inferSelect): LockHolder {
  return {
    key: row.key,
    runId: row.runId,
    correlationId: row.correlationId,
    fencingToken: row.fencingToken,
    acquiredAt: row.acquiredAt,
    ...(row.leaseExpiresAt && { leaseExpiresAt: row.leaseExpiresAt }),
  };
}

/** The optional `Storage['locks']` namespace for the Postgres World. */
export function createLocksStorage(
  drizzle: Drizzle
): NonNullable<Storage['locks']> {
  return {
    async get(key): Promise<Lock | null> {
      const [row] = await drizzle
        .select()
        .from(Schema.locks)
        .where(eq(Schema.locks.key, key))
        .limit(1);
      return row ?? null;
    },
    async listHolders({ key, runId }) {
      const conditions = [
        ...(key !== undefined ? [eq(Schema.lockHolders.key, key)] : []),
        ...(runId !== undefined ? [eq(Schema.lockHolders.runId, runId)] : []),
      ];
      const rows = await drizzle
        .select()
        .from(Schema.lockHolders)
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      return rows.map(toHolder);
    },
    async listWaiters({ key, limit }): Promise<LockWaiter[]> {
      const rows = await drizzle
        .select()
        .from(Schema.lockWaiters)
        .where(eq(Schema.lockWaiters.key, key))
        .orderBy(asc(Schema.lockWaiters.seq))
        .limit(limit ?? 100_000);
      return rows.map((row) => ({
        key: row.key,
        seq: row.seq,
        runId: row.runId,
        correlationId: row.correlationId,
        enqueuedAt: row.enqueuedAt,
        ...(row.grantedAt && { grantedAt: row.grantedAt }),
        ...(row.wake && { wake: row.wake }),
      }));
    },
    async releaseHolder({ runId, correlationId }) {
      return drizzle.transaction(async (tx) => {
        const [holder] = await tx
          .select({ key: Schema.lockHolders.key })
          .from(Schema.lockHolders)
          .where(
            and(
              eq(Schema.lockHolders.runId, runId),
              eq(Schema.lockHolders.correlationId, correlationId)
            )
          )
          .limit(1);
        if (!holder) return { released: false };
        await tx
          .select({ key: Schema.locks.key })
          .from(Schema.locks)
          .where(eq(Schema.locks.key, holder.key))
          .for('update');
        // The freed slot goes to the queue's head. Nobody wakes it here: an
        // admin release has no runtime to send the wake, so the grantee
        // claims at its backstop.
        const released = await removeHolder(
          tx,
          holder.key,
          runId,
          correlationId,
          []
        );
        return { released };
      }, READ_COMMITTED);
    },
  };
}
