import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import {
  LimitDefinitionConflictError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  createLockId,
  type LimitDefinition,
  LimitAcquireRequestSchema,
  type LimitAcquireResult,
  LimitHeartbeatRequestSchema,
  type LimitLease,
  type LimitNextWaiter,
  type LimitReleaseResult,
  LimitReleaseRequestSchema,
  type Limits,
  parseLockId,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { PostgresWorldConfig } from './config.js';
import type { Drizzle } from './drizzle/index.js';
import * as Schema from './drizzle/schema.js';

type LeaseRow = typeof Schema.limitLeases.$inferSelect;
type LimitKeyRow = typeof Schema.limitKeys.$inferSelect;
type TokenRow = typeof Schema.rateLimitTokens.$inferSelect;
type WaiterRow = typeof Schema.limitWaiters.$inferSelect;
type Tx = Parameters<Parameters<Drizzle['transaction']>[0]>[0];
type Db = Drizzle | Tx;
const generateId = monotonicFactory();

function nowPlus(ms?: number): Date | undefined {
  if (ms === undefined) return undefined;
  return new Date(Date.now() + ms);
}

function toDate(value: Date | string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function toMillis(value: Date | string | null | undefined): number | undefined {
  const date = toDate(value);
  return date ? date.getTime() : undefined;
}

function toLease(row: LeaseRow, definition: LimitDefinition): LimitLease {
  const parsedLockId = parseLockId(row.holderId);
  return {
    leaseId: row.leaseId,
    key: row.limitKey,
    lockId: row.holderId,
    runId: parsedLockId?.runId ?? row.holderId,
    lockIndex: parsedLockId?.lockIndex ?? 0,
    acquiredAt: toDate(row.acquiredAt)!,
    expiresAt: toDate(row.expiresAt),
    definition,
  };
}

function definitionFromRow(
  row: Pick<LimitKeyRow, 'concurrencyMax' | 'rateCount' | 'ratePeriodMs'>
): LimitDefinition {
  return {
    concurrency:
      row.concurrencyMax !== null ? { max: row.concurrencyMax } : undefined,
    rate:
      row.rateCount !== null && row.ratePeriodMs !== null
        ? { count: row.rateCount, periodMs: row.ratePeriodMs }
        : undefined,
  };
}

function areLimitDefinitionsEqual(
  left: LimitDefinition | undefined,
  right: LimitDefinition
): boolean {
  return (
    left?.concurrency?.max === right.concurrency?.max &&
    left?.rate?.count === right.rate?.count &&
    left?.rate?.periodMs === right.rate?.periodMs
  );
}

function toNextWaiter(holderId: string): LimitNextWaiter | undefined {
  const parsedLockId = parseLockId(holderId);
  if (!parsedLockId) {
    return undefined;
  }

  return {
    runId: parsedLockId.runId,
    lockIndex: parsedLockId.lockIndex,
    wakeCorrelationId: `wflock_wait_${parsedLockId.runId}:${parsedLockId.lockIndex}`,
    lockCorrelationId: `wflock_${parsedLockId.runId}:${parsedLockId.lockIndex}`,
  };
}

function getBlockedReason(
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): 'concurrency' | 'rate' | 'concurrency_and_rate' {
  if (concurrencyBlocked && rateBlocked) return 'concurrency_and_rate';
  if (concurrencyBlocked) return 'concurrency';
  return 'rate';
}

/*
When a workflow or step is blocked, we need to calculate the retry after time.
We do this by finding the earliest expiration time for any leases or tokens.
*/
function getRetryAfterMs(
  leases: LeaseRow[],
  tokens: TokenRow[],
  now: number,
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): number | undefined {
  const candidates: number[] = [];

  if (concurrencyBlocked) {
    for (const lease of leases) {
      if (lease.expiresAt) {
        candidates.push(Math.max(0, toMillis(lease.expiresAt)! - now));
      }
    }
  }

  if (rateBlocked) {
    for (const token of tokens) {
      candidates.push(Math.max(0, toMillis(token.expiresAt)! - now));
    }
  }

  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

function getWaiterRetryAfterMs(
  leases: LeaseRow[],
  tokens: TokenRow[],
  now: number,
  definition: LimitDefinition
): number | undefined {
  return getRetryAfterMs(
    leases,
    tokens,
    now,
    definition.concurrency !== undefined &&
      leases.length >= definition.concurrency.max,
    definition.rate !== undefined && tokens.length >= definition.rate.count
  );
}

function getBlockedRetryAfterMs(
  state: {
    keyRow?: LimitKeyRow;
    leases: LeaseRow[];
    tokens: TokenRow[];
    waiters: WaiterRow[];
  },
  now: number,
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): number {
  const headWaiter = state.waiters[0];
  const definition = state.keyRow ? definitionFromRow(state.keyRow) : undefined;
  return (
    (headWaiter && definition
      ? getWaiterRetryAfterMs(state.leases, state.tokens, now, definition)
      : undefined) ??
    getRetryAfterMs(
      state.leases,
      state.tokens,
      now,
      concurrencyBlocked,
      rateBlocked
    ) ??
    1000
  );
}

async function pruneExpired(tx: Db, key: string): Promise<void> {
  /*
  Capacity is reclaimed opportunistically whenever a key is touched.
  This keeps v1 simple and avoids needing a separate cleanup worker.
  */
  const now = new Date();

  await tx
    .delete(Schema.rateLimitTokens)
    .where(
      and(
        eq(Schema.rateLimitTokens.limitKey, key),
        lte(Schema.rateLimitTokens.expiresAt, now)
      )
    );

  await tx
    .delete(Schema.limitLeases)
    .where(
      and(
        eq(Schema.limitLeases.limitKey, key),
        isNotNull(Schema.limitLeases.expiresAt),
        lte(Schema.limitLeases.expiresAt, now)
      )
    );
}

async function getActiveState(
  tx: Db,
  key: string
): Promise<{
  keyRow?: LimitKeyRow;
  leases: LeaseRow[];
  tokens: TokenRow[];
  waiters: WaiterRow[];
}> {
  const [keyRow, leases, tokens, waiters] = await Promise.all([
    tx.query.limitKeys.findFirst({
      where: eq(Schema.limitKeys.limitKey, key),
    }),
    tx
      .select()
      .from(Schema.limitLeases)
      .where(eq(Schema.limitLeases.limitKey, key))
      .orderBy(
        asc(Schema.limitLeases.acquiredAt),
        asc(Schema.limitLeases.leaseId)
      ),
    tx
      .select()
      .from(Schema.rateLimitTokens)
      .where(eq(Schema.rateLimitTokens.limitKey, key))
      .orderBy(asc(Schema.rateLimitTokens.expiresAt)),
    tx
      .select()
      .from(Schema.limitWaiters)
      .where(eq(Schema.limitWaiters.limitKey, key))
      .orderBy(
        asc(Schema.limitWaiters.createdAt),
        asc(Schema.limitWaiters.waiterId)
      ),
  ]);

  return { keyRow, leases, tokens, waiters };
}

/*
We serialize limit mutations per key inside the transaction so concurrent
acquire/release flows cannot both observe the same free capacity.
*/
async function lockLimitKey(tx: Db, key: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  );
}

async function isHolderLive(tx: Db, holderId: string): Promise<boolean> {
  const parsedLockId = parseLockId(holderId);
  if (!parsedLockId) {
    return true;
  }

  const [run] = (await tx
    .select({
      status: Schema.runs.status,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, parsedLockId.runId))
    .limit(1)) as Pick<typeof Schema.runs.$inferSelect, 'status'>[];

  return !run || !['completed', 'failed', 'cancelled'].includes(run.status);
}

async function pruneDeadWaiters(tx: Db, key: string): Promise<void> {
  const waiters = await tx
    .select({
      waiterId: Schema.limitWaiters.waiterId,
      holderId: Schema.limitWaiters.holderId,
    })
    .from(Schema.limitWaiters)
    .where(eq(Schema.limitWaiters.limitKey, key));

  for (const waiter of waiters) {
    if (!(await isHolderLive(tx, waiter.holderId))) {
      await tx
        .delete(Schema.limitWaiters)
        .where(eq(Schema.limitWaiters.waiterId, waiter.waiterId));
    }
  }
}

async function pruneDeadHolders(tx: Db, key: string): Promise<void> {
  const leases = await tx
    .select({
      leaseId: Schema.limitLeases.leaseId,
      holderId: Schema.limitLeases.holderId,
    })
    .from(Schema.limitLeases)
    .where(eq(Schema.limitLeases.limitKey, key));

  for (const lease of leases) {
    if (!(await isHolderLive(tx, lease.holderId))) {
      await tx
        .delete(Schema.limitLeases)
        .where(eq(Schema.limitLeases.leaseId, lease.leaseId));
    }
  }
}

async function ensureCanonicalDefinition(
  tx: Db,
  key: string,
  requested: LimitDefinition,
  state: {
    keyRow?: LimitKeyRow;
    leases: LeaseRow[];
    tokens: TokenRow[];
    waiters: WaiterRow[];
  }
) {
  const existing = state.keyRow;

  if (
    existing &&
    state.leases.length === 0 &&
    state.tokens.length === 0 &&
    state.waiters.length === 0
  ) {
    await tx.delete(Schema.limitKeys).where(eq(Schema.limitKeys.limitKey, key));
  }

  const current =
    existing &&
    state.leases.length === 0 &&
    state.tokens.length === 0 &&
    state.waiters.length === 0
      ? undefined
      : (existing ??
        (await tx.query.limitKeys.findFirst({
          where: eq(Schema.limitKeys.limitKey, key),
        })));

  if (!current) {
    await tx.insert(Schema.limitKeys).values({
      limitKey: key,
      concurrencyMax: requested.concurrency?.max ?? null,
      rateCount: requested.rate?.count ?? null,
      ratePeriodMs: requested.rate?.periodMs ?? null,
    });
    return;
  }

  const currentDefinition = definitionFromRow(current);
  if (!areLimitDefinitionsEqual(currentDefinition, requested)) {
    throw new LimitDefinitionConflictError(key, currentDefinition, requested);
  }
}

async function promoteWaiter(
  tx: Db,
  key: string,
  waiter: WaiterRow,
  definition: LimitDefinition
): Promise<{ lease: LimitLease; nextWaiter?: LimitNextWaiter }> {
  const leaseId = `lmt_${generateId()}`;
  const expiresAt = nowPlus(waiter.leaseTtlMs ?? undefined);
  const [lease] = await tx
    .insert(Schema.limitLeases)
    .values({
      leaseId,
      limitKey: key,
      holderId: waiter.holderId,
      acquiredAt: new Date(),
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();

  const acquiredLease =
    lease ??
    (await tx.query.limitLeases.findFirst({
      where: and(
        eq(Schema.limitLeases.limitKey, key),
        eq(Schema.limitLeases.holderId, waiter.holderId)
      ),
    }));

  if (!acquiredLease) {
    throw new WorkflowWorldError(`Failed to promote waiter for key "${key}"`);
  }

  if (definition.rate) {
    await tx.insert(Schema.rateLimitTokens).values({
      tokenId: `lmttok_${generateId()}`,
      limitKey: key,
      holderId: waiter.holderId,
      acquiredAt: new Date(),
      expiresAt: new Date(Date.now() + definition.rate.periodMs),
    });
  }

  await tx
    .delete(Schema.limitWaiters)
    .where(eq(Schema.limitWaiters.waiterId, waiter.waiterId));

  return {
    lease: toLease(acquiredLease, definition),
    nextWaiter: toNextWaiter(waiter.holderId),
  };
}

export function createLimits(
  _config: PostgresWorldConfig,
  drizzle: Drizzle
): Limits {
  return {
    async acquire(request) {
      const parsed = LimitAcquireRequestSchema.parse(request);

      return drizzle.transaction(async (tx) => {
        await lockLimitKey(tx, parsed.key);
        await pruneExpired(tx, parsed.key);
        await pruneDeadHolders(tx, parsed.key);
        await pruneDeadWaiters(tx, parsed.key);

        const state = await getActiveState(tx, parsed.key);
        await ensureCanonicalDefinition(
          tx,
          parsed.key,
          parsed.definition,
          state
        );
        const currentState = await getActiveState(tx, parsed.key);
        const definition =
          currentState.keyRow && definitionFromRow(currentState.keyRow);
        const lockId = createLockId(parsed.runId, parsed.lockIndex);
        const existingLease = currentState.leases.find(
          (lease) => lease.holderId === lockId
        );
        if (existingLease) {
          if (!definition) {
            throw new WorkflowWorldError(
              `Missing canonical definition for key "${parsed.key}"`
            );
          }
          return {
            status: 'acquired',
            lease: toLease(existingLease, definition),
          } satisfies LimitAcquireResult;
        }

        const existingWaiter = currentState.waiters.find(
          (waiter) => waiter.holderId === lockId
        );
        if (existingWaiter) {
          const concurrencyBlocked =
            parsed.definition.concurrency !== undefined &&
            currentState.leases.length >= parsed.definition.concurrency.max;
          const rateBlocked =
            parsed.definition.rate !== undefined &&
            currentState.tokens.length >= parsed.definition.rate.count;

          if (
            currentState.waiters[0]?.waiterId === existingWaiter.waiterId &&
            !concurrencyBlocked &&
            !rateBlocked
          ) {
            if (!definition) {
              throw new WorkflowWorldError(
                `Missing canonical definition for key "${parsed.key}"`
              );
            }
            const promoted = await promoteWaiter(
              tx,
              parsed.key,
              existingWaiter,
              definition
            );
            return {
              status: 'acquired',
              lease: promoted.lease,
            } satisfies LimitAcquireResult;
          }

          const now = Date.now();
          return {
            status: 'blocked',
            reason: getBlockedReason(concurrencyBlocked, rateBlocked),
            retryAfterMs: getBlockedRetryAfterMs(
              currentState,
              now,
              concurrencyBlocked,
              rateBlocked
            ),
          } satisfies LimitAcquireResult;
        }

        const concurrencyBlocked =
          parsed.definition.concurrency !== undefined &&
          currentState.leases.length >= parsed.definition.concurrency.max;
        const rateBlocked =
          parsed.definition.rate !== undefined &&
          currentState.tokens.length >= parsed.definition.rate.count;

        if (
          !concurrencyBlocked &&
          !rateBlocked &&
          currentState.waiters.length === 0
        ) {
          const expiresAt = nowPlus(parsed.leaseTtlMs);
          const [lease] = await tx
            .insert(Schema.limitLeases)
            .values({
              leaseId: `lmt_${generateId()}`,
              limitKey: parsed.key,
              holderId: lockId,
              acquiredAt: new Date(),
              expiresAt,
            })
            .returning();

          if (parsed.definition.rate) {
            await tx.insert(Schema.rateLimitTokens).values({
              tokenId: `lmttok_${generateId()}`,
              limitKey: parsed.key,
              holderId: lockId,
              acquiredAt: new Date(),
              expiresAt: new Date(Date.now() + parsed.definition.rate.periodMs),
            });
          }

          return {
            status: 'acquired',
            lease: toLease(lease, definition ?? parsed.definition),
          } satisfies LimitAcquireResult;
        }

        await tx
          .insert(Schema.limitWaiters)
          .values({
            waiterId: `lmtwait_${generateId()}`,
            limitKey: parsed.key,
            holderId: lockId,
            createdAt: new Date(),
            leaseTtlMs: parsed.leaseTtlMs ?? null,
          })
          .onConflictDoNothing();

        const now = Date.now();
        return {
          status: 'blocked',
          reason: getBlockedReason(concurrencyBlocked, rateBlocked),
          retryAfterMs: getBlockedRetryAfterMs(
            currentState,
            now,
            parsed.definition.concurrency !== undefined,
            parsed.definition.rate !== undefined
          ),
        } satisfies LimitAcquireResult;
      });
    },

    async release(request) {
      const parsed = LimitReleaseRequestSchema.parse(request);

      return drizzle.transaction(async (tx): Promise<LimitReleaseResult> => {
        const key =
          parsed.key ??
          (
            await tx.query.limitLeases.findFirst({
              columns: { limitKey: true },
              where: eq(Schema.limitLeases.leaseId, parsed.leaseId),
            })
          )?.limitKey;

        if (key) {
          await lockLimitKey(tx, key);
          await pruneExpired(tx, key);
        }

        const beforeState = key ? await getActiveState(tx, key) : undefined;

        let where = eq(Schema.limitLeases.leaseId, parsed.leaseId);
        if (parsed.key) {
          where = and(where, eq(Schema.limitLeases.limitKey, parsed.key))!;
        }
        if (parsed.lockId) {
          where = and(where, eq(Schema.limitLeases.holderId, parsed.lockId))!;
        }

        await tx.delete(Schema.limitLeases).where(where).returning({
          limitKey: Schema.limitLeases.limitKey,
          holderId: Schema.limitLeases.holderId,
        });

        if (key) {
          await pruneDeadHolders(tx, key);
          await pruneDeadWaiters(tx, key);
          const state = await getActiveState(tx, key);
          const headWaiter = state.waiters[0];
          const capacityFreed =
            (beforeState?.leases.length ?? 0) > state.leases.length;

          if (headWaiter && capacityFreed) {
            const definition = state.keyRow && definitionFromRow(state.keyRow);
            if (!definition) {
              throw new WorkflowWorldError(
                `Missing canonical definition for key "${key}"`
              );
            }
            const concurrencyBlocked =
              definition.concurrency !== undefined &&
              state.leases.length >= definition.concurrency.max;
            const rateBlocked =
              definition.rate !== undefined &&
              state.tokens.length >= definition.rate.count;

            if (!concurrencyBlocked && !rateBlocked) {
              const promoted = await promoteWaiter(
                tx,
                key,
                headWaiter,
                definition
              );
              return { nextWaiter: promoted.nextWaiter };
            }
          }

          if (
            state.leases.length === 0 &&
            state.tokens.length === 0 &&
            state.waiters.length === 0
          ) {
            await tx
              .delete(Schema.limitKeys)
              .where(eq(Schema.limitKeys.limitKey, key));
          }
        }

        return {};
      });
    },

    async heartbeat(request) {
      const parsed = LimitHeartbeatRequestSchema.parse(request);

      // Heartbeat a lease to extend its expiry.
      return drizzle.transaction(async (tx) => {
        const existing = await tx.query.limitLeases.findFirst({
          where: eq(Schema.limitLeases.leaseId, parsed.leaseId),
        });

        if (!existing) {
          throw new WorkflowWorldError(`Lease "${parsed.leaseId}" not found`);
        }

        await lockLimitKey(tx, existing.limitKey);
        await pruneExpired(tx, existing.limitKey);

        const current = await tx.query.limitLeases.findFirst({
          where: and(
            eq(Schema.limitLeases.leaseId, parsed.leaseId),
            eq(Schema.limitLeases.limitKey, existing.limitKey)
          ),
        });

        if (!current) {
          throw new WorkflowWorldError(`Lease "${parsed.leaseId}" not found`);
        }

        const now = Date.now();
        const currentExpiry = toMillis(current.expiresAt);
        const ttlMs =
          parsed.ttlMs ?? (currentExpiry ? currentExpiry - now : 30_000);
        const expiresAt = new Date(now + Math.max(1, ttlMs));

        const [updated] = await tx
          .update(Schema.limitLeases)
          .set({ expiresAt })
          .where(eq(Schema.limitLeases.leaseId, parsed.leaseId))
          .returning();

        if (!updated) {
          throw new WorkflowWorldError(`Lease "${parsed.leaseId}" not found`);
        }

        const keyRow = await tx.query.limitKeys.findFirst({
          where: eq(Schema.limitKeys.limitKey, current.limitKey),
        });

        if (!keyRow) {
          throw new WorkflowWorldError(
            `Missing canonical definition for key "${current.limitKey}"`
          );
        }

        return toLease(updated, definitionFromRow(keyRow));
      });
    },
  };
}
