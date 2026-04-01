import path from 'node:path';
import {
  LimitDefinitionConflictError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { Storage, WorkflowRunWithoutData } from '@workflow/world';
import {
  createLockCorrelationId,
  createLockId,
  createLockWakeCorrelationId,
  type LimitDefinition,
  LimitAcquireRequestSchema,
  type LimitAcquireResult,
  LimitHeartbeatRequestSchema,
  type LimitLease,
  LimitLeaseSchema,
  type LimitPromotedWaiter,
  type LimitReleaseResult,
  LimitReleaseRequestSchema,
  type Limits,
  parseLockId,
} from '@workflow/world';
import { z } from 'zod';
import { readJSON, writeJSON } from './fs.js';
import { monotonicUlid } from './storage/helpers.js';

const LimitTokenSchema = z.object({
  tokenId: z.string(),
  lockId: z.string(),
  acquiredAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
});

const LimitWaiterSchema = z.object({
  waiterId: z.string(),
  lockId: z.string(),
  runId: z.string(),
  lockIndex: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  leaseTtlMs: z.number().int().positive().optional(),
  concurrencyMax: z.number().int().positive().nullable(),
  rateCount: z.number().int().positive().nullable(),
  ratePeriodMs: z.number().int().positive().nullable(),
});

const KeyStateSchema = z.object({
  key: z.string(),
  definition: z
    .object({
      concurrency: z.object({ max: z.number().int().positive() }).optional(),
      rate: z
        .object({
          count: z.number().int().positive(),
          periodMs: z.number().int().positive(),
        })
        .optional(),
    })
    .optional(),
  leases: z.array(LimitLeaseSchema),
  tokens: z.array(LimitTokenSchema),
  waiters: z.array(LimitWaiterSchema),
});

const LimitsStateSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  keys: z.record(z.string(), KeyStateSchema),
});

type LimitToken = z.infer<typeof LimitTokenSchema>;
type LimitWaiter = z.infer<typeof LimitWaiterSchema>;
type KeyState = z.infer<typeof KeyStateSchema>;
type LimitsState = z.infer<typeof LimitsStateSchema>;

type HolderTarget =
  | {
      kind: 'lock';
      runId: string;
      wakeCorrelationId: string;
      lockCorrelationId: string;
    }
  | {
      kind: 'opaque';
    };

export interface LocalLimitsOptions {
  tag?: string;
  storage?: Pick<Storage, 'runs'>;
}

const EMPTY_STATE: LimitsState = {
  version: 3,
  keys: {},
};

function getStatePath(dataDir: string, tag?: string): string {
  return path.join(dataDir, 'limits', tag ? `state.${tag}.json` : 'state.json');
}

function cloneToken(token: LimitToken): LimitToken {
  return { ...token };
}

function cloneWaiter(waiter: LimitWaiter): LimitWaiter {
  return { ...waiter };
}

function normalizeKeyState(keyState: KeyState): KeyState {
  return {
    key: keyState.key,
    definition: keyState.definition,
    leases: keyState.leases.map((lease) => ({ ...lease })),
    tokens: keyState.tokens.map(cloneToken),
    waiters: keyState.waiters.map(cloneWaiter),
  };
}

function cloneState(state: LimitsState): LimitsState {
  return {
    version: 3,
    keys: Object.fromEntries(
      Object.entries(state.keys).map(([key, keyState]) => [
        key,
        normalizeKeyState(keyState),
      ])
    ),
  };
}

function pruneKeyState(keyState: KeyState, now = Date.now()): KeyState {
  return {
    key: keyState.key,
    definition: keyState.definition,
    leases: keyState.leases.filter(
      (lease) =>
        lease.expiresAt === undefined || lease.expiresAt.getTime() > now
    ),
    tokens: keyState.tokens.filter((token) => token.expiresAt.getTime() > now),
    waiters: keyState.waiters.map(cloneWaiter),
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

function assertCanonicalDefinition(
  key: string,
  keyState: KeyState,
  requested: LimitDefinition
) {
  if (!keyState.definition) {
    keyState.definition = requested;
    return;
  }

  if (!areLimitDefinitionsEqual(keyState.definition, requested)) {
    throw new LimitDefinitionConflictError(key, keyState.definition, requested);
  }
}

function getBlockedReason(
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): 'concurrency' | 'rate' | 'concurrency_and_rate' {
  if (concurrencyBlocked && rateBlocked) return 'concurrency_and_rate';
  if (concurrencyBlocked) return 'concurrency';
  return 'rate';
}

function getRetryAfterMs(
  keyState: KeyState,
  now: number,
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): number | undefined {
  const candidates: number[] = [];

  if (concurrencyBlocked) {
    for (const lease of keyState.leases) {
      if (lease.expiresAt) {
        candidates.push(Math.max(0, lease.expiresAt.getTime() - now));
      }
    }
  }

  if (rateBlocked) {
    for (const token of keyState.tokens) {
      candidates.push(Math.max(0, token.expiresAt.getTime() - now));
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  return Math.min(...candidates);
}

function getWaiterRetryAfterMs(
  keyState: KeyState,
  now: number,
  waiter: Pick<LimitWaiter, 'concurrencyMax' | 'rateCount'>
): number | undefined {
  return getRetryAfterMs(
    keyState,
    now,
    waiter.concurrencyMax !== null &&
      keyState.leases.length >= waiter.concurrencyMax,
    waiter.rateCount !== null && keyState.tokens.length >= waiter.rateCount
  );
}

function getBlockedRetryAfterMs(
  keyState: KeyState,
  now: number,
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): number | undefined {
  const headWaiter = keyState.waiters[0];
  return (
    (headWaiter
      ? getWaiterRetryAfterMs(keyState, now, headWaiter)
      : undefined) ??
    getRetryAfterMs(keyState, now, concurrencyBlocked, rateBlocked)
  );
}

function createLease(
  key: string,
  runId: string,
  lockIndex: number,
  definition: LimitLease['definition'],
  acquiredAt: Date,
  leaseTtlMs?: number
): LimitLease {
  return {
    leaseId: `lmt_${monotonicUlid()}`,
    key,
    lockId: createLockId(runId, lockIndex),
    runId,
    lockIndex,
    acquiredAt,
    expiresAt:
      leaseTtlMs !== undefined
        ? new Date(acquiredAt.getTime() + leaseTtlMs)
        : undefined,
    definition,
  };
}

function insertToken(
  keyState: KeyState,
  lockId: string,
  acquiredAt: Date,
  periodMs: number
) {
  keyState.tokens.push({
    tokenId: `lmttok_${monotonicUlid()}`,
    lockId,
    acquiredAt,
    expiresAt: new Date(acquiredAt.getTime() + periodMs),
  });
}

function parseHolderId(lockId: string): HolderTarget {
  const parsedLockId = parseLockId(lockId);
  if (parsedLockId) {
    return {
      kind: 'lock',
      runId: parsedLockId.runId,
      wakeCorrelationId: createLockWakeCorrelationId(
        parsedLockId.runId,
        parsedLockId.lockIndex
      ),
      lockCorrelationId: createLockCorrelationId(
        parsedLockId.runId,
        parsedLockId.lockIndex
      ),
    };
  }

  return { kind: 'opaque' };
}

function toPromotedWaiter(
  holderId: string,
  lease: Pick<LimitLease, 'leaseId' | 'key' | 'lockId'>
): LimitPromotedWaiter | undefined {
  const parsedLockId = parseLockId(holderId);
  if (!parsedLockId) {
    return undefined;
  }

  return {
    leaseId: lease.leaseId,
    key: lease.key,
    lockId: lease.lockId,
    runId: parsedLockId.runId,
    lockIndex: parsedLockId.lockIndex,
    wakeCorrelationId: createLockWakeCorrelationId(
      parsedLockId.runId,
      parsedLockId.lockIndex
    ),
    lockCorrelationId: createLockCorrelationId(
      parsedLockId.runId,
      parsedLockId.lockIndex
    ),
  };
}

function isTerminalRun(run: WorkflowRunWithoutData | undefined) {
  return !!run && ['completed', 'failed', 'cancelled'].includes(run.status);
}

function deleteEmptyKey(state: LimitsState, key: string) {
  const keyState = state.keys[key];
  if (!keyState) return;
  if (
    keyState.leases.length === 0 &&
    keyState.tokens.length === 0 &&
    keyState.waiters.length === 0
  ) {
    delete state.keys[key];
  }
}

export function createLimits(
  dataDir: string,
  tagOrOptions?: string | LocalLimitsOptions
): Limits {
  const options =
    typeof tagOrOptions === 'string' ? { tag: tagOrOptions } : tagOrOptions;
  const statePath = getStatePath(dataDir, options?.tag);
  let stateOp = Promise.resolve();

  const withStateLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = stateOp.then(fn, fn);
    stateOp = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const readState = async (): Promise<LimitsState> => {
    const raw =
      (await readJSON(statePath, LimitsStateSchema)) ?? cloneState(EMPTY_STATE);

    return cloneState(raw);
  };

  const writeState = async (state: LimitsState): Promise<void> => {
    await writeJSON(statePath, state, { overwrite: true });
  };

  const getRun = async (
    runId: string
  ): Promise<WorkflowRunWithoutData | undefined> => {
    try {
      return await options?.storage?.runs.get(runId, { resolveData: 'none' });
    } catch {
      return undefined;
    }
  };

  const isHolderLive = async (holderId: string): Promise<boolean> => {
    const target = parseHolderId(holderId);
    if (target.kind === 'opaque' || !options?.storage) {
      return true;
    }

    const run = await getRun(target.runId);
    return !isTerminalRun(run);
  };

  const pruneDeadHoldersAndWaiters = async (
    keyState: KeyState
  ): Promise<KeyState> => {
    const prunedKeyState = pruneKeyState(keyState);
    const leases: LimitLease[] = [];
    const waiters: LimitWaiter[] = [];

    for (const lease of prunedKeyState.leases) {
      if (await isHolderLive(lease.lockId)) {
        leases.push(lease);
      }
    }

    for (const waiter of prunedKeyState.waiters) {
      if (await isHolderLive(waiter.lockId)) {
        waiters.push(waiter);
      }
    }

    prunedKeyState.leases = leases;
    prunedKeyState.waiters = waiters;
    return prunedKeyState;
  };

  const promoteWaiter = (
    key: string,
    keyState: KeyState,
    waiter: LimitWaiter
  ): {
    keyState: KeyState;
    lease: LimitLease;
    promotedWaiter?: LimitPromotedWaiter;
  } => {
    const acquiredAt = new Date();
    const definition = {
      concurrency:
        waiter.concurrencyMax !== null
          ? { max: waiter.concurrencyMax }
          : undefined,
      rate:
        waiter.rateCount !== null && waiter.ratePeriodMs !== null
          ? {
              count: waiter.rateCount,
              periodMs: waiter.ratePeriodMs,
            }
          : undefined,
    } satisfies LimitDefinition;

    const lease = createLease(
      key,
      waiter.runId,
      waiter.lockIndex,
      definition,
      acquiredAt,
      waiter.leaseTtlMs
    );

    keyState.waiters = keyState.waiters.filter(
      (candidate) => candidate.waiterId !== waiter.waiterId
    );
    keyState.leases.push(lease);

    if (waiter.rateCount !== null && waiter.ratePeriodMs !== null) {
      insertToken(keyState, waiter.lockId, acquiredAt, waiter.ratePeriodMs);
    }

    return {
      keyState,
      lease,
      promotedWaiter: toPromotedWaiter(waiter.lockId, lease),
    };
  };

  const promoteEligibleWaiters = (
    key: string,
    keyState: KeyState
  ): {
    keyState: KeyState;
    promotedWaiters: LimitPromotedWaiter[];
  } => {
    const promotedWaiters: LimitPromotedWaiter[] = [];

    while (true) {
      const headWaiter = keyState.waiters[0];
      if (!headWaiter) {
        break;
      }

      const concurrencyBlocked =
        headWaiter.concurrencyMax !== null &&
        keyState.leases.length >= headWaiter.concurrencyMax;
      const rateBlocked =
        headWaiter.rateCount !== null &&
        keyState.tokens.length >= headWaiter.rateCount;

      if (concurrencyBlocked || rateBlocked) {
        break;
      }

      const promoted = promoteWaiter(key, keyState, headWaiter);
      keyState = promoted.keyState;
      if (promoted.promotedWaiter) {
        promotedWaiters.push(promoted.promotedWaiter);
      }
    }

    return { keyState, promotedWaiters };
  };

  return {
    async acquire(request) {
      const parsed = LimitAcquireRequestSchema.parse(request);
      const lockId = createLockId(parsed.runId, parsed.lockIndex);

      return withStateLock(async (): Promise<LimitAcquireResult> => {
        const state = cloneState(await readState());
        const keyState = await pruneDeadHoldersAndWaiters(
          state.keys[parsed.key] ?? {
            key: parsed.key,
            definition: undefined,
            leases: [],
            tokens: [],
            waiters: [],
          }
        );
        if (
          keyState.leases.length === 0 &&
          keyState.tokens.length === 0 &&
          keyState.waiters.length === 0
        ) {
          keyState.definition = undefined;
        }
        assertCanonicalDefinition(parsed.key, keyState, parsed.definition);
        state.keys[parsed.key] = keyState;

        const existingLease = keyState.leases.find(
          (lease) => lease.lockId === lockId
        );
        if (existingLease) {
          await writeState(state);
          return {
            status: 'acquired',
            lease: existingLease,
          };
        }

        const concurrencyBlocked =
          parsed.definition.concurrency !== undefined &&
          keyState.leases.length >= parsed.definition.concurrency.max;
        const rateBlocked =
          parsed.definition.rate !== undefined &&
          keyState.tokens.length >= parsed.definition.rate.count;
        const existingWaiter = keyState.waiters.find(
          (waiter) => waiter.lockId === lockId
        );

        if (
          existingWaiter &&
          keyState.waiters[0]?.waiterId === existingWaiter.waiterId
        ) {
          if (!concurrencyBlocked && !rateBlocked) {
            const promoted = promoteWaiter(
              parsed.key,
              keyState,
              existingWaiter
            );
            state.keys[parsed.key] = promoted.keyState;
            await writeState(state);
            return {
              status: 'acquired',
              lease: promoted.lease,
            };
          }
        }

        if (
          existingWaiter ||
          concurrencyBlocked ||
          rateBlocked ||
          keyState.waiters.length > 0
        ) {
          if (!existingWaiter) {
            keyState.waiters.push({
              waiterId: `lmtwait_${monotonicUlid()}`,
              lockId,
              runId: parsed.runId,
              lockIndex: parsed.lockIndex,
              createdAt: new Date(),
              leaseTtlMs: parsed.leaseTtlMs,
              concurrencyMax: parsed.definition.concurrency?.max ?? null,
              rateCount: parsed.definition.rate?.count ?? null,
              ratePeriodMs: parsed.definition.rate?.periodMs ?? null,
            });
          }

          state.keys[parsed.key] = keyState;
          await writeState(state);
          return {
            status: 'blocked',
            reason: getBlockedReason(concurrencyBlocked, rateBlocked),
            retryAfterMs: getBlockedRetryAfterMs(
              keyState,
              Date.now(),
              concurrencyBlocked,
              rateBlocked
            ),
          };
        }

        const acquiredAt = new Date();
        const lease = createLease(
          parsed.key,
          parsed.runId,
          parsed.lockIndex,
          parsed.definition,
          acquiredAt,
          parsed.leaseTtlMs
        );

        keyState.leases.push(lease);

        if (parsed.definition.rate) {
          insertToken(
            keyState,
            lockId,
            acquiredAt,
            parsed.definition.rate.periodMs
          );
        }

        state.keys[parsed.key] = keyState;
        await writeState(state);

        return {
          status: 'acquired',
          lease,
        };
      });
    },

    async release(request) {
      const parsed = LimitReleaseRequestSchema.parse(request);

      return withStateLock(async (): Promise<LimitReleaseResult> => {
        const state = cloneState(await readState());
        const key =
          parsed.key ??
          Object.entries(state.keys).find(([, keyState]) =>
            keyState.leases.some((lease) => lease.leaseId === parsed.leaseId)
          )?.[0];

        if (!key) {
          return { promotedWaiters: [] };
        }

        const keyStateValue = state.keys[key];
        if (!keyStateValue) {
          return { promotedWaiters: [] };
        }

        const beforeLeases = keyStateValue.leases.length;
        let keyState = await pruneDeadHoldersAndWaiters(keyStateValue);
        let capacityFreed = keyState.leases.length !== beforeLeases;
        const beforeExplicitRelease = keyState.leases.length;
        keyState.leases = keyState.leases.filter((lease) => {
          if (lease.leaseId !== parsed.leaseId) return true;
          if (parsed.key && lease.key !== parsed.key) return true;
          if (parsed.lockId && lease.lockId !== parsed.lockId) {
            return true;
          }
          return false;
        });
        capacityFreed ||= keyState.leases.length !== beforeExplicitRelease;

        const promoted = capacityFreed
          ? promoteEligibleWaiters(key, keyState)
          : { keyState, promotedWaiters: [] };
        state.keys[key] = promoted.keyState;
        deleteEmptyKey(state, key);

        await writeState(state);
        return { promotedWaiters: promoted.promotedWaiters };
      });
    },

    async heartbeat(request) {
      const parsed = LimitHeartbeatRequestSchema.parse(request);

      return withStateLock(async () => {
        const state = cloneState(await readState());
        const now = Date.now();

        for (const [key, keyStateValue] of Object.entries(state.keys)) {
          const keyState = pruneKeyState(keyStateValue, now);
          const leaseIndex = keyState.leases.findIndex(
            (lease) => lease.leaseId === parsed.leaseId
          );

          if (leaseIndex === -1) {
            state.keys[key] = keyState;
            continue;
          }

          const lease = keyState.leases[leaseIndex];
          const currentExpiry = lease.expiresAt?.getTime();
          const ttlMs =
            parsed.ttlMs ?? (currentExpiry ? currentExpiry - now : 30_000);
          const updatedLease: LimitLease = {
            ...lease,
            expiresAt: new Date(now + Math.max(1, ttlMs)),
          };

          keyState.leases[leaseIndex] = updatedLease;
          state.keys[key] = keyState;
          await writeState(state);
          return updatedLease;
        }

        throw new WorkflowWorldError(`Lease "${parsed.leaseId}" not found`);
      });
    },
  };
}
