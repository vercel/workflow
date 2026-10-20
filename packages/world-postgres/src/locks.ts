/**
 * Native concurrency locks (`experimental_lock()`) for the Postgres World, stage 1.
 *
 * `workflow_locks.count` equals the key's rows in `workflow_lock_holders`,
 * and every statement keeps it so:
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
  isTerminalWorkflowRunStatus,
  type Lock,
  type LockAttempt,
  type LockHolder,
  lockRetryAt,
  type Storage,
} from '@workflow/world';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
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
  'lock_released',
] as const;

const READ_COMMITTED = { isolationLevel: 'read committed' } as const;

/** Inserts this create's own event on `tx` and returns it as stored. */
export type LockEventInserter = (
  tx: DrizzleTransaction,
  event: {
    eventType: 'lock_created' | 'lock_acquired' | 'lock_released';
    correlationId: string;
    eventData: Record<string, unknown>;
  }
) => Promise<Event>;

interface LockScopeEvents {
  created?: Event;
  acquired?: Event;
  released?: Event;
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
    if (event.eventType === 'lock_released') scope.released = event;
  }
  return scope;
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

/** Deletes the key's expired leases, with their decrement, in one statement. */
async function pruneExpiredLeases(
  tx: DrizzleTransaction,
  key: string
): Promise<void> {
  await tx.execute(sql`
    WITH pruned AS (
      DELETE FROM ${Schema.lockHolders}
      WHERE ${Schema.lockHolders.key} = ${key}
        AND ${Schema.lockHolders.leaseExpiresAt} <= now()
      RETURNING 1
    )
    UPDATE ${Schema.locks}
    SET count = ${Schema.locks.count} - (SELECT count(*)::int FROM pruned),
        updated_at = now()
    WHERE ${Schema.locks.key} = ${key}
      AND EXISTS (SELECT 1 FROM pruned)
  `);
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
    eventData: { key: string; concurrency: number; leaseTtlMs?: number };
  }
): Promise<{ event: Event; lock: LockAttempt }> {
  const { correlationId } = data;
  const { key, concurrency, leaseTtlMs } = data.eventData;
  // A transaction, or a savepoint inside the caller's (the in-band fence).
  const drizzle = handle as Drizzle;
  return drizzle.transaction(async (tx) => {
    await lockLiveRun(tx, runId, 'acquire');
    let row = await lockKeyRow(tx, key, concurrency);
    const scope = await scopeEvents(tx, runId, correlationId);
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

    await pruneExpiredLeases(tx, key);
    // First writer wins on concurrency; a key nobody holds adopts the
    // request's value. Same statement shape as the grant: conditional on the
    // row's own state.
    if (row.concurrency !== concurrency) {
      const [adopted] = await tx
        .update(Schema.locks)
        .set({ concurrency, updatedAt: new Date() })
        .where(and(eq(Schema.locks.key, key), eq(Schema.locks.count, 0)))
        .returning();
      if (adopted) row = adopted;
    }

    // The admission fence.
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
          lt(Schema.locks.count, Schema.locks.concurrency)
        )
      )
      .returning();
    if (granted) {
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
      return {
        event,
        lock: {
          key,
          status: 'held',
          fencingToken: granted.grantSeq,
          concurrency: granted.concurrency,
        },
      };
    }

    // Refused. A retry of a scope that already waited writes nothing.
    const now = Date.now();
    // Measured from what the scope's lock_created records as its createdAt,
    // on every attempt including the first: the column default is this
    // transaction's `now()`, so the first refusal reads it here rather than
    // using the app clock, or its schedule would be a few ms off from every
    // later attempt's and its retry messages would not collapse.
    const waitingSince = scope.created
      ? +scope.created.createdAt
      : await transactionNow(tx);
    // The scope's deterministic schedule: every attempt in this window gets
    // the same instant, so the runtime's retry messages collapse onto one.
    const retryAt = new Date(
      lockRetryAt(`${runId}:${correlationId}`, waitingSince, now)
    );
    const lock: LockAttempt = {
      key,
      status: 'pending',
      retryAt,
      concurrency: row.concurrency,
    };
    if (scope.created) return { event: scope.created, lock };
    const event = await insertEvent(tx, {
      eventType: 'lock_created',
      correlationId,
      eventData: { ...data.eventData, retryAt },
    });
    return { event, lock };
  }, READ_COMMITTED);
}

export async function releaseLock(
  handle: DrizzleHandle,
  insertEvent: LockEventInserter,
  runId: string,
  data: { correlationId: string; eventData: { key: string } }
): Promise<{ event: Event; lock: LockAttempt }> {
  const { correlationId } = data;
  const { key } = data.eventData;
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
    if (!row || !scope.acquired) {
      throw new EntityConflictError(
        `Lock scope "${correlationId}" does not hold "${key}"`
      );
    }
    if (scope.released) {
      throw new EntityConflictError(
        `Lock scope "${correlationId}" already released "${key}"`
      );
    }
    await tx.execute(sql`
      WITH released AS (
        DELETE FROM ${Schema.lockHolders}
        WHERE ${Schema.lockHolders.runId} = ${runId}
          AND ${Schema.lockHolders.correlationId} = ${correlationId}
        RETURNING key
      )
      UPDATE ${Schema.locks}
      SET count = ${Schema.locks.count} - 1, updated_at = now()
      FROM released
      WHERE ${Schema.locks.key} = released.key
    `);
    const event = await insertEvent(tx, {
      eventType: 'lock_released',
      correlationId,
      eventData: { key },
    });
    return { event, lock: { key, status: 'released' } };
  }, READ_COMMITTED);
}

/**
 * Terminal reclaim, inside the run's terminal transition (after its run row
 * `UPDATE`): lock the run's keys in a stable order, then delete its holder
 * rows and subtract exactly what each key lost.
 */
export async function reclaimRunLocks(
  tx: DrizzleTransaction,
  runId: string
): Promise<void> {
  const held = await tx
    .selectDistinct({ key: Schema.lockHolders.key })
    .from(Schema.lockHolders)
    .where(eq(Schema.lockHolders.runId, runId));
  if (held.length === 0) return;
  await tx
    .select({ key: Schema.locks.key })
    .from(Schema.locks)
    .where(
      inArray(
        Schema.locks.key,
        held.map((h) => h.key)
      )
    )
    .orderBy(asc(Schema.locks.key))
    .for('update');
  await tx.execute(sql`
    WITH reclaimed AS (
      DELETE FROM ${Schema.lockHolders}
      WHERE ${Schema.lockHolders.runId} = ${runId}
      RETURNING key
    ),
    per_key AS (
      SELECT key, count(*)::int AS n FROM reclaimed GROUP BY key
    )
    UPDATE ${Schema.locks}
    SET count = ${Schema.locks.count} - per_key.n, updated_at = now()
    FROM per_key
    WHERE ${Schema.locks.key} = per_key.key
  `);
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
        const result = await tx.execute(sql`
          WITH released AS (
            DELETE FROM ${Schema.lockHolders}
            WHERE ${Schema.lockHolders.runId} = ${runId}
              AND ${Schema.lockHolders.correlationId} = ${correlationId}
            RETURNING key
          )
          UPDATE ${Schema.locks}
          SET count = ${Schema.locks.count} - 1, updated_at = now()
          FROM released
          WHERE ${Schema.locks.key} = released.key
          RETURNING ${Schema.locks.key}
        `);
        return { released: (result.rowCount ?? 0) > 0 };
      }, READ_COMMITTED);
    },
  };
}
