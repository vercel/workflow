import { JsonTransport } from '@vercel/queue';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { WorkflowWorldError } from '@workflow/errors';
import {
  createLockId,
  createLockWakeCorrelationId,
  LimitAcquireRequestSchema,
  type LimitAcquireResult,
  LimitHeartbeatRequestSchema,
  type LimitLease,
  LimitReleaseRequestSchema,
  type Limits,
  MessageId,
  parseLockId,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { PostgresWorldConfig } from './config.js';
import type { Drizzle } from './drizzle/index.js';
import * as Schema from './drizzle/schema.js';
import { MessageData } from './message.js';

type LeaseRow = typeof Schema.limitLeases.$inferSelect;
type TokenRow = typeof Schema.limitTokens.$inferSelect;
type WaiterRow = typeof Schema.limitWaiters.$inferSelect;
type RunRow = Pick<
  typeof Schema.runs.$inferSelect,
  'workflowName' | 'startedAt' | 'status'
>;
type Tx = Parameters<Parameters<Drizzle['transaction']>[0]>[0];
type Db = Drizzle | Tx;

type HolderTarget =
  | {
      kind: 'lock';
      runId: string;
      correlationId: string;
    }
  | {
      kind: 'opaque';
    };

const transport = new JsonTransport();
const generateId = monotonicFactory();

function getQueues(config: PostgresWorldConfig) {
  const prefix = config.jobPrefix || 'workflow_';
  return {
    workflow: `${prefix}flows`,
  } as const;
}

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

/*
Holder ids double as wake-up hints.
When a waiter is promoted, we decode the holder id to decide which queue to poke.
*/
function parseHolderId(lockId: string): HolderTarget {
  const parsedLockId = parseLockId(lockId);
  if (parsedLockId) {
    return {
      kind: 'lock',
      runId: parsedLockId.runId,
      correlationId: createLockWakeCorrelationId(
        parsedLockId.runId,
        parsedLockId.lockIndex
      ),
    };
  }

  return { kind: 'opaque' };
}

function toLease(row: LeaseRow): LimitLease {
  const parsedLockId = parseLockId(row.holderId);
  return {
    leaseId: row.leaseId,
    key: row.limitKey,
    lockId: row.holderId,
    runId: parsedLockId?.runId ?? row.holderId,
    lockIndex: parsedLockId?.lockIndex ?? 0,
    acquiredAt: toDate(row.acquiredAt)!,
    expiresAt: toDate(row.expiresAt),
    definition: {
      concurrency:
        row.concurrencyMax !== null ? { max: row.concurrencyMax } : undefined,
      rate:
        row.rateCount !== null && row.ratePeriodMs !== null
          ? {
              count: row.rateCount,
              periodMs: row.ratePeriodMs,
            }
          : undefined,
    },
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

async function queueWorkflowWake(
  tx: Db,
  config: PostgresWorldConfig,
  runId: string,
  workflowName: string,
  idempotencyKey: string
) {
  const messageId = MessageId.parse(`msg_${generateId()}`);
  const payload = MessageData.encode({
    id: workflowName,
    data: Buffer.from(
      transport.serialize({
        runId,
        requestedAt: new Date(),
      })
    ),
    attempt: 1,
    idempotencyKey,
    messageId,
  });

  await tx.execute(sql`
    select graphile_worker.add_job(
      ${getQueues(config).workflow}::text,
      payload := ${JSON.stringify(payload)}::json,
      max_attempts := 3,
      job_key := ${idempotencyKey}::text,
      job_key_mode := 'replace'
    )
  `);
}

async function queueWakeForHolder(
  tx: Db,
  config: PostgresWorldConfig,
  holderId: string
) {
  /*
  Limit state is durable in Postgres, but wake-ups still need a runtime target.
  If the workflow is already terminal, there is nothing left to resume.
  */
  const target = parseHolderId(holderId);
  if (target.kind === 'opaque') {
    return;
  }

  const [run] = (await tx
    .select({
      workflowName: Schema.runs.workflowName,
      startedAt: Schema.runs.startedAt,
      status: Schema.runs.status,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, target.runId))
    .limit(1)) as RunRow[];
  if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) {
    return;
  }

  await queueWorkflowWake(
    tx,
    config,
    target.runId,
    run.workflowName,
    target.correlationId
  );
}

async function pruneExpired(tx: Db, key: string): Promise<void> {
  /*
  Capacity is reclaimed opportunistically whenever a key is touched.
  This keeps v1 simple and avoids needing a separate cleanup worker.
  */
  const now = new Date();

  await tx
    .delete(Schema.limitTokens)
    .where(
      and(
        eq(Schema.limitTokens.limitKey, key),
        lte(Schema.limitTokens.expiresAt, now)
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
  leases: LeaseRow[];
  tokens: TokenRow[];
  waiters: WaiterRow[];
}> {
  const [leases, tokens, waiters] = await Promise.all([
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
      .from(Schema.limitTokens)
      .where(eq(Schema.limitTokens.limitKey, key))
      .orderBy(asc(Schema.limitTokens.expiresAt)),
    tx
      .select()
      .from(Schema.limitWaiters)
      .where(eq(Schema.limitWaiters.limitKey, key))
      .orderBy(
        asc(Schema.limitWaiters.createdAt),
        asc(Schema.limitWaiters.waiterId)
      ),
  ]);

  return { leases, tokens, waiters };
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
  const target = parseHolderId(holderId);
  if (target.kind === 'opaque') {
    return true;
  }

  const [run] = (await tx
    .select({
      status: Schema.runs.status,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, target.runId))
    .limit(1)) as Pick<typeof Schema.runs.$inferSelect, 'status'>[];

  return !!run && !['completed', 'failed', 'cancelled'].includes(run.status);
}

async function promoteWaiters(
  tx: Db,
  config: PostgresWorldConfig,
  key: string
): Promise<void> {
  /*
  We walk waiters in FIFO order and stop at the first waiter that is still blocked.
  Later waiters cannot jump ahead of an earlier waiter for the same key. (getActiveState returns waiters in FIFO order)
  */
  const state = await getActiveState(tx, key);
  let activeLeases = state.leases.length;
  let activeTokens = state.tokens.length;

  for (const waiter of state.waiters) {
    if (!(await isHolderLive(tx, waiter.holderId))) {
      await tx
        .delete(Schema.limitWaiters)
        .where(eq(Schema.limitWaiters.waiterId, waiter.waiterId));
      continue;
    }

    const concurrencyBlocked =
      waiter.concurrencyMax !== null && activeLeases >= waiter.concurrencyMax;
    const rateBlocked =
      waiter.rateCount !== null && activeTokens >= waiter.rateCount;

    if (concurrencyBlocked || rateBlocked) {
      break;
    }

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
        concurrencyMax: waiter.concurrencyMax,
        rateCount: waiter.rateCount,
        ratePeriodMs: waiter.ratePeriodMs,
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
      continue;
    }

    if (waiter.rateCount !== null && waiter.ratePeriodMs !== null) {
      await tx.insert(Schema.limitTokens).values({
        tokenId: `lmttok_${generateId()}`,
        limitKey: key,
        holderId: waiter.holderId,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + waiter.ratePeriodMs),
      });
      activeTokens += 1;
    }

    await tx
      .delete(Schema.limitWaiters)
      .where(eq(Schema.limitWaiters.waiterId, waiter.waiterId));

    activeLeases += 1;
    await queueWakeForHolder(tx, config, acquiredLease.holderId);
  }
}

export function createLimits(
  config: PostgresWorldConfig,
  drizzle: Drizzle
): Limits {
  return {
    async acquire(request) {
      const parsed = LimitAcquireRequestSchema.parse(request);

      return drizzle.transaction(async (tx) => {
        await lockLimitKey(tx, parsed.key);
        // Prune expired leases and tokens, promote pre-existing waiters before attempting to acquire a new lease or token.
        await pruneExpired(tx, parsed.key);
        await promoteWaiters(tx, config, parsed.key);

        const state = await getActiveState(tx, parsed.key);
        const lockId = createLockId(parsed.runId, parsed.lockIndex);
        const existingLease = state.leases.find(
          (lease) => lease.holderId === lockId
        );
        if (existingLease) {
          return {
            status: 'acquired',
            lease: toLease(existingLease),
          } satisfies LimitAcquireResult;
        }

        const existingWaiter = state.waiters.find(
          (waiter) => waiter.holderId === lockId
        );
        // If there are already waiters for this key and holder no need to queue a new waiter.
        if (existingWaiter) {
          const now = Date.now();
          const concurrencyBlocked =
            parsed.definition.concurrency !== undefined &&
            state.leases.length >= parsed.definition.concurrency.max;
          const rateBlocked =
            parsed.definition.rate !== undefined &&
            state.tokens.length >= parsed.definition.rate.count;
          return {
            status: 'blocked',
            reason: getBlockedReason(concurrencyBlocked, rateBlocked),
            retryAfterMs:
              getRetryAfterMs(
                state.leases,
                state.tokens,
                now,
                concurrencyBlocked,
                rateBlocked
              ) ?? 1000,
          } satisfies LimitAcquireResult;
        }

        const concurrencyBlocked =
          parsed.definition.concurrency !== undefined &&
          state.leases.length >= parsed.definition.concurrency.max;
        const rateBlocked =
          parsed.definition.rate !== undefined &&
          state.tokens.length >= parsed.definition.rate.count;

        // If we are not blocked, and there are no waiters for this key and holder, we can acquire a new lease or token.
        if (!concurrencyBlocked && !rateBlocked && state.waiters.length === 0) {
          const expiresAt = nowPlus(parsed.leaseTtlMs);
          const [lease] = await tx
            .insert(Schema.limitLeases)
            .values({
              leaseId: `lmt_${generateId()}`,
              limitKey: parsed.key,
              holderId: lockId,
              acquiredAt: new Date(),
              expiresAt,
              concurrencyMax: parsed.definition.concurrency?.max ?? null,
              rateCount: parsed.definition.rate?.count ?? null,
              ratePeriodMs: parsed.definition.rate?.periodMs ?? null,
            })
            .returning();

          if (parsed.definition.rate) {
            await tx.insert(Schema.limitTokens).values({
              tokenId: `lmttok_${generateId()}`,
              limitKey: parsed.key,
              holderId: lockId,
              acquiredAt: new Date(),
              expiresAt: new Date(Date.now() + parsed.definition.rate.periodMs),
            });
          }

          return {
            status: 'acquired',
            lease: toLease(lease),
          } satisfies LimitAcquireResult;
        }

        // If we are blocked, we need to queue a waiter.
        await tx
          .insert(Schema.limitWaiters)
          .values({
            waiterId: `lmtwait_${generateId()}`,
            limitKey: parsed.key,
            holderId: lockId,
            createdAt: new Date(),
            leaseTtlMs: parsed.leaseTtlMs ?? null,
            concurrencyMax: parsed.definition.concurrency?.max ?? null,
            rateCount: parsed.definition.rate?.count ?? null,
            ratePeriodMs: parsed.definition.rate?.periodMs ?? null,
          })
          .onConflictDoNothing();

        const now = Date.now();
        return {
          status: 'blocked',
          reason: getBlockedReason(concurrencyBlocked, rateBlocked),
          retryAfterMs:
            getRetryAfterMs(
              state.leases,
              state.tokens,
              now,
              parsed.definition.concurrency !== undefined,
              parsed.definition.rate !== undefined
            ) ?? 1000,
        } satisfies LimitAcquireResult;
      });
    },

    async release(request) {
      const parsed = LimitReleaseRequestSchema.parse(request);

      await drizzle.transaction(async (tx) => {
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
        }

        let where = eq(Schema.limitLeases.leaseId, parsed.leaseId);
        if (parsed.key) {
          where = and(where, eq(Schema.limitLeases.limitKey, parsed.key))!;
        }
        if (parsed.lockId) {
          where = and(where, eq(Schema.limitLeases.holderId, parsed.lockId))!;
        }

        const [deleted] = await tx
          .delete(Schema.limitLeases)
          .where(where)
          .returning({ limitKey: Schema.limitLeases.limitKey });

        if (deleted?.limitKey) {
          await pruneExpired(tx, deleted.limitKey);
          await promoteWaiters(tx, config, deleted.limitKey);
        }
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

        const now = Date.now();
        const currentExpiry = toMillis(existing.expiresAt);
        const ttlMs =
          parsed.ttlMs ?? (currentExpiry ? currentExpiry - now : 30_000);
        const expiresAt = new Date(now + Math.max(1, ttlMs));

        const [updated] = await tx
          .update(Schema.limitLeases)
          .set({ expiresAt })
          .where(eq(Schema.limitLeases.leaseId, parsed.leaseId))
          .returning();

        return toLease(updated);
      });
    },
  };
}
