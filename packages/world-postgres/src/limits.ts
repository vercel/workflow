import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import {
  LimitDefinitionConflictError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  areLimitDefinitionsEqual,
  canAcquireFromState,
  createLockId,
  createPromotedWaiter,
  decideLimitAcquire,
  inspectLimitState,
  isLimitStateEmpty,
  type LimitDefinition,
  LimitAcquireRequestSchema,
  type LimitAcquireResult,
  LimitHeartbeatRequestSchema,
  type LimitLease,
  type LimitPromotedWaiter,
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
type LimitState = {
  definition: LimitDefinition;
  leases: LeaseRow[];
  tokens: TokenRow[];
  waiters: WaiterRow[];
};
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

function parseRequiredLockId(lockId: string) {
  const parsed = parseLockId(lockId);
  if (!parsed) {
    throw new WorkflowWorldError(`Invalid lock ID "${lockId}"`);
  }
  return parsed;
}

function toLease(row: LeaseRow, definition: LimitDefinition): LimitLease {
  const parsedLockId = parseRequiredLockId(row.holderId);
  return {
    leaseId: row.leaseId,
    key: row.limitKey,
    lockId: row.holderId,
    runId: parsedLockId.runId,
    lockIndex: parsedLockId.lockIndex,
    acquiredAt: toDate(row.acquiredAt)!,
    expiresAt: toDate(row.expiresAt),
    definition,
  };
}

function definitionFromRow(row: LimitKeyRow): LimitDefinition {
  const concurrency =
    row.concurrencyMax !== null ? { max: row.concurrencyMax } : undefined;
  const rate =
    row.rateCount !== null && row.ratePeriodMs !== null
      ? { count: row.rateCount, periodMs: row.ratePeriodMs }
      : undefined;

  if (concurrency && rate) {
    return { concurrency, rate };
  }
  if (concurrency) {
    return { concurrency };
  }
  if (rate) {
    return { rate };
  }

  throw new WorkflowWorldError('Missing limit definition');
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
): Promise<LimitState | undefined> {
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

  if (!keyRow) {
    if (leases.length > 0 || tokens.length > 0 || waiters.length > 0) {
      throw new WorkflowWorldError(
        `Missing canonical definition for key "${key}"`
      );
    }
    return undefined;
  }

  return {
    definition: definitionFromRow(keyRow),
    leases,
    tokens,
    waiters,
  };
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
  const parsedLockId = parseRequiredLockId(holderId);

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

async function deleteLimitKeyIfEmpty(tx: Db, key: string): Promise<void> {
  const state = await getActiveState(tx, key);
  if (state && isLimitStateEmpty(state)) {
    await tx.delete(Schema.limitKeys).where(eq(Schema.limitKeys.limitKey, key));
  }
}

async function promoteWaiter(
  tx: Db,
  key: string,
  waiter: WaiterRow,
  definition: LimitDefinition
): Promise<{ lease: LimitLease; promotedWaiter: LimitPromotedWaiter }> {
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

  if (definition.rate !== undefined) {
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

  const promotedLease = toLease(acquiredLease, definition);
  return {
    lease: promotedLease,
    promotedWaiter: createPromotedWaiter({
      leaseId: promotedLease.leaseId,
      key: promotedLease.key,
      lockId: promotedLease.lockId,
    }) satisfies LimitPromotedWaiter,
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
        await deleteLimitKeyIfEmpty(tx, parsed.key);
        let state = await getActiveState(tx, parsed.key);
        if (!state) {
          await tx.insert(Schema.limitKeys).values({
            limitKey: parsed.key,
            concurrencyMax: parsed.definition.concurrency?.max ?? null,
            rateCount: parsed.definition.rate?.count ?? null,
            ratePeriodMs: parsed.definition.rate?.periodMs ?? null,
          });
          state = {
            definition: parsed.definition,
            leases: [],
            tokens: [],
            waiters: [],
          };
        } else if (
          !areLimitDefinitionsEqual(state.definition, parsed.definition)
        ) {
          throw new LimitDefinitionConflictError(
            parsed.key,
            state.definition,
            parsed.definition
          );
        }
        const lockId = createLockId(parsed.runId, parsed.lockIndex);
        const decision = decideLimitAcquire({
          state,
          lockId,
          getLeaseLockId: (lease) => lease.holderId,
          getWaiterLockId: (waiter) => waiter.holderId,
        });

        if (decision.type === 'reuse_lease') {
          return {
            status: 'acquired',
            lease: toLease(decision.lease, state.definition),
          } satisfies LimitAcquireResult;
        }

        if (decision.type === 'promote_waiter') {
          const promoted = await promoteWaiter(
            tx,
            parsed.key,
            decision.waiter,
            state.definition
          );
          return {
            status: 'acquired',
            lease: promoted.lease,
          } satisfies LimitAcquireResult;
        }

        if (decision.type === 'block') {
          if (decision.enqueueWaiter) {
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
          }

          return {
            status: 'blocked',
            reason: decision.reason,
            retryAfterMs: decision.retryAfterMs,
          } satisfies LimitAcquireResult;
        }

        if (decision.type === 'acquire_new') {
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

          if (state.definition.rate !== undefined) {
            await tx.insert(Schema.rateLimitTokens).values({
              tokenId: `lmttok_${generateId()}`,
              limitKey: parsed.key,
              holderId: lockId,
              acquiredAt: new Date(),
              expiresAt: new Date(Date.now() + state.definition.rate.periodMs),
            });
          }

          return {
            status: 'acquired',
            lease: toLease(lease, state.definition),
          } satisfies LimitAcquireResult;
        }

        throw new WorkflowWorldError(
          `Unexpected limit acquire decision for key "${parsed.key}"`
        );
      });
    },

    async release(request) {
      const parsed = LimitReleaseRequestSchema.parse(request);

      return drizzle.transaction(async (tx): Promise<LimitReleaseResult> => {
        await lockLimitKey(tx, parsed.key);
        await pruneExpired(tx, parsed.key);
        const beforeState = await getActiveState(tx, parsed.key);
        if (!beforeState) {
          return { promotedWaiters: [] };
        }

        await tx
          .delete(Schema.limitLeases)
          .where(
            and(
              eq(Schema.limitLeases.leaseId, parsed.leaseId),
              eq(Schema.limitLeases.limitKey, parsed.key),
              eq(Schema.limitLeases.holderId, parsed.lockId)
            )
          );

        const promotedWaiters: LimitPromotedWaiter[] = [];
        await pruneDeadHolders(tx, parsed.key);
        await pruneDeadWaiters(tx, parsed.key);
        let state = await getActiveState(tx, parsed.key);
        const capacityFreed =
          beforeState.leases.length > (state?.leases.length ?? 0);

        if (capacityFreed) {
          while (state) {
            const headWaiter = state.waiters[0];
            if (!headWaiter) {
              break;
            }

            if (
              !canAcquireFromState(
                inspectLimitState(state, headWaiter.waiterId)
              )
            ) {
              break;
            }

            const promoted = await promoteWaiter(
              tx,
              parsed.key,
              headWaiter,
              state.definition
            );
            promotedWaiters.push(promoted.promotedWaiter);
            state = await getActiveState(tx, parsed.key);
          }
        }

        await deleteLimitKeyIfEmpty(tx, parsed.key);

        return { promotedWaiters };
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
