import path from 'node:path';
import {
  LimitDefinitionConflictError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { Storage, WorkflowRunWithoutData } from '@workflow/world';
import {
  areLimitDefinitionsEqual,
  createLockCorrelationId,
  createLockId,
  createLockWakeCorrelationId,
  getBlockedReason,
  LimitAcquireRequestSchema,
  type LimitAcquireResult,
  LimitDefinitionSchema,
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
});

const KeyStateSchema = z.object({
  key: z.string(),
  definition: LimitDefinitionSchema,
  leases: z.array(LimitLeaseSchema),
  tokens: z.array(LimitTokenSchema),
  waiters: z.array(LimitWaiterSchema),
});

const LimitsStateSchema = z.object({
  keys: z.record(z.string(), KeyStateSchema),
});

type LimitWaiter = z.infer<typeof LimitWaiterSchema>;
type KeyState = z.infer<typeof KeyStateSchema>;
type LimitsState = z.infer<typeof LimitsStateSchema>;

export interface LocalLimitsOptions {
  tag?: string;
  storage?: Pick<Storage, 'runs'>;
}

function getStatePath(dataDir: string, tag?: string): string {
  return path.join(dataDir, 'limits', tag ? `state.${tag}.json` : 'state.json');
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
    waiters: [...keyState.waiters],
  };
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
  now: number
): number | undefined {
  return getRetryAfterMs(
    keyState,
    now,
    keyState.definition.concurrency !== undefined &&
      keyState.leases.length >= keyState.definition.concurrency.max,
    keyState.definition.rate !== undefined &&
      keyState.tokens.length >= keyState.definition.rate.count
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
    (headWaiter ? getWaiterRetryAfterMs(keyState, now) : undefined) ??
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

function parseRequiredLockId(lockId: string) {
  const parsedLockId = parseLockId(lockId);
  if (!parsedLockId) {
    throw new WorkflowWorldError(`Invalid lock ID "${lockId}"`);
  }
  return parsedLockId;
}

function toPromotedWaiter(
  holderId: string,
  lease: Pick<LimitLease, 'leaseId' | 'key' | 'lockId'>
): LimitPromotedWaiter {
  const parsedLockId = parseRequiredLockId(holderId);

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
    typeof tagOrOptions === 'string'
      ? { tag: tagOrOptions }
      : (tagOrOptions ?? {});
  const statePath = getStatePath(dataDir, options.tag);
  const runsStorage = options.storage?.runs;
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
    return (await readJSON(statePath, LimitsStateSchema)) ?? { keys: {} };
  };

  const writeState = async (state: LimitsState): Promise<void> => {
    await writeJSON(statePath, state, { overwrite: true });
  };

  const getRun = async (
    runId: string
  ): Promise<WorkflowRunWithoutData | undefined> => {
    if (!runsStorage) {
      return undefined;
    }

    try {
      return await runsStorage.get(runId, { resolveData: 'none' });
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error)) {
        return undefined;
      }
      throw error;
    }
  };

  const isHolderLive = async (holderId: string): Promise<boolean> => {
    if (!runsStorage) {
      return true;
    }

    const run = await getRun(parseRequiredLockId(holderId).runId);
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
    keyState: KeyState,
    waiter: LimitWaiter
  ): {
    keyState: KeyState;
    lease: LimitLease;
    promotedWaiter: LimitPromotedWaiter;
  } => {
    const acquiredAt = new Date();
    const definition = keyState.definition;

    const lease = createLease(
      keyState.key,
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

    if (definition.rate) {
      insertToken(
        keyState,
        waiter.lockId,
        acquiredAt,
        definition.rate.periodMs
      );
    }

    return {
      keyState,
      lease,
      promotedWaiter: toPromotedWaiter(waiter.lockId, lease),
    };
  };

  const promoteEligibleWaiters = (
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
        keyState.definition.concurrency !== undefined &&
        keyState.leases.length >= keyState.definition.concurrency.max;
      const rateBlocked =
        keyState.definition.rate !== undefined &&
        keyState.tokens.length >= keyState.definition.rate.count;

      if (concurrencyBlocked || rateBlocked) {
        break;
      }

      const promoted = promoteWaiter(keyState, headWaiter);
      keyState = promoted.keyState;
      promotedWaiters.push(promoted.promotedWaiter);
    }

    return { keyState, promotedWaiters };
  };

  return {
    async acquire(request) {
      const parsed = LimitAcquireRequestSchema.parse(request);
      const lockId = createLockId(parsed.runId, parsed.lockIndex);

      return withStateLock(async (): Promise<LimitAcquireResult> => {
        const state = await readState();
        let keyState = await pruneDeadHoldersAndWaiters(
          state.keys[parsed.key] ?? {
            key: parsed.key,
            definition: parsed.definition,
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
          keyState = {
            key: parsed.key,
            definition: parsed.definition,
            leases: [],
            tokens: [],
            waiters: [],
          };
        } else if (
          !areLimitDefinitionsEqual(keyState.definition, parsed.definition)
        ) {
          throw new LimitDefinitionConflictError(
            parsed.key,
            keyState.definition,
            parsed.definition
          );
        }
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
          keyState.definition.concurrency !== undefined &&
          keyState.leases.length >= keyState.definition.concurrency.max;
        const rateBlocked =
          keyState.definition.rate !== undefined &&
          keyState.tokens.length >= keyState.definition.rate.count;
        const existingWaiter = keyState.waiters.find(
          (waiter) => waiter.lockId === lockId
        );
        const queuedBlocked =
          keyState.waiters.length > 0 &&
          keyState.waiters[0]?.waiterId !== existingWaiter?.waiterId;

        if (
          existingWaiter &&
          keyState.waiters[0]?.waiterId === existingWaiter.waiterId
        ) {
          if (!concurrencyBlocked && !rateBlocked) {
            const promoted = promoteWaiter(keyState, existingWaiter);
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
          queuedBlocked ||
          concurrencyBlocked ||
          rateBlocked
        ) {
          if (!existingWaiter) {
            keyState.waiters.push({
              waiterId: `lmtwait_${monotonicUlid()}`,
              lockId,
              runId: parsed.runId,
              lockIndex: parsed.lockIndex,
              createdAt: new Date(),
              leaseTtlMs: parsed.leaseTtlMs,
            });
          }

          state.keys[parsed.key] = keyState;
          await writeState(state);
          return {
            status: 'blocked',
            reason: getBlockedReason(
              queuedBlocked,
              concurrencyBlocked,
              rateBlocked
            ),
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
          keyState.definition,
          acquiredAt,
          parsed.leaseTtlMs
        );

        keyState.leases.push(lease);

        if (keyState.definition.rate) {
          insertToken(
            keyState,
            lockId,
            acquiredAt,
            keyState.definition.rate.periodMs
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
        const state = await readState();
        const keyStateValue = state.keys[parsed.key];
        if (!keyStateValue) {
          return { promotedWaiters: [] };
        }

        const beforeLeases = keyStateValue.leases.length;
        const keyState = await pruneDeadHoldersAndWaiters(keyStateValue);
        let capacityFreed = keyState.leases.length !== beforeLeases;
        const beforeExplicitRelease = keyState.leases.length;
        keyState.leases = keyState.leases.filter((lease) => {
          if (lease.leaseId !== parsed.leaseId) return true;
          if (lease.lockId !== parsed.lockId) {
            return true;
          }
          return false;
        });
        capacityFreed ||= keyState.leases.length !== beforeExplicitRelease;

        const promoted = capacityFreed
          ? promoteEligibleWaiters(keyState)
          : { keyState, promotedWaiters: [] };
        state.keys[parsed.key] = promoted.keyState;
        deleteEmptyKey(state, parsed.key);

        await writeState(state);
        return { promotedWaiters: promoted.promotedWaiters };
      });
    },

    async heartbeat(request) {
      const parsed = LimitHeartbeatRequestSchema.parse(request);

      return withStateLock(async () => {
        const state = await readState();
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
