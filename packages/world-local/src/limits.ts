import path from 'node:path';
import {
  LimitDefinitionConflictError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { Storage, WorkflowRunWithoutData } from '@workflow/world';
import {
  areLimitDefinitionsEqual,
  createLockId,
  createPromotedWaiter,
  decideLimitAcquire,
  getHeartbeatExpiry,
  getPromotableWaiter,
  isLimitStateEmpty,
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

function isTerminalRun(run: WorkflowRunWithoutData | undefined) {
  return !!run && ['completed', 'failed', 'cancelled'].includes(run.status);
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

    if (definition.rate !== undefined) {
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
      promotedWaiter: createPromotedWaiter({
        leaseId: lease.leaseId,
        key: lease.key,
        lockId: lease.lockId,
      }) satisfies LimitPromotedWaiter,
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
      const headWaiter = getPromotableWaiter(keyState);
      if (!headWaiter) {
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
        if (isLimitStateEmpty(keyState)) {
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
        const decision = decideLimitAcquire({
          state: keyState,
          lockId,
          getLeaseLockId: (lease) => lease.lockId,
          getWaiterLockId: (waiter) => waiter.lockId,
        });

        if (decision.type === 'reuse_lease') {
          await writeState(state);
          return {
            status: 'acquired',
            lease: decision.lease,
          };
        }

        if (decision.type === 'promote_waiter') {
          const promoted = promoteWaiter(keyState, decision.waiter);
          state.keys[parsed.key] = promoted.keyState;
          await writeState(state);
          return {
            status: 'acquired',
            lease: promoted.lease,
          };
        }

        if (decision.type === 'block') {
          if (decision.enqueueWaiter) {
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
            reason: decision.reason,
            retryAfterMs: decision.retryAfterMs,
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

        if (keyState.definition.rate !== undefined) {
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
        if (isLimitStateEmpty(promoted.keyState)) {
          delete state.keys[parsed.key];
        }

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
          const updatedLease: LimitLease = {
            ...lease,
            expiresAt: getHeartbeatExpiry({
              currentExpiresAt: lease.expiresAt,
              ttlMs: parsed.ttlMs,
              now,
            }),
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
