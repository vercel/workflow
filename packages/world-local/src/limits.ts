import path from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';
import {
  LimitAcquireRequestSchema,
  type LimitAcquireResult,
  LimitHeartbeatRequestSchema,
  type LimitLease,
  LimitLeaseSchema,
  LimitReleaseRequestSchema,
  type Limits,
} from '@workflow/world';
import { z } from 'zod';
import { readJSON, writeJSON } from './fs.js';
import { monotonicUlid } from './storage/helpers.js';

const LimitTokenSchema = z.object({
  tokenId: z.string(),
  holderId: z.string(),
  acquiredAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
});

const KeyStateSchema = z.object({
  key: z.string(),
  leases: z.array(LimitLeaseSchema),
  tokens: z.array(LimitTokenSchema),
});

const LimitsStateSchema = z.object({
  version: z.literal(1),
  keys: z.record(z.string(), KeyStateSchema),
});

type LimitToken = z.infer<typeof LimitTokenSchema>;
type KeyState = z.infer<typeof KeyStateSchema>;
type LimitsState = z.infer<typeof LimitsStateSchema>;

const EMPTY_STATE: LimitsState = {
  version: 1,
  keys: {},
};

function getStatePath(dataDir: string, tag?: string): string {
  return path.join(dataDir, 'limits', tag ? `state.${tag}.json` : 'state.json');
}

function cloneToken(token: LimitToken): LimitToken {
  return { ...token };
}

function cloneState(state: LimitsState): LimitsState {
  return {
    version: 1,
    keys: Object.fromEntries(
      Object.entries(state.keys).map(([key, keyState]) => [
        key,
        {
          key: keyState.key,
          leases: keyState.leases.map((lease) => ({ ...lease })),
          tokens: keyState.tokens.map(cloneToken),
        },
      ])
    ),
  };
}

function pruneKeyState(keyState: KeyState, now = Date.now()): KeyState {
  return {
    key: keyState.key,
    leases: keyState.leases.filter(
      (lease) =>
        lease.expiresAt === undefined || lease.expiresAt.getTime() > now
    ),
    tokens: keyState.tokens.filter((token) => token.expiresAt.getTime() > now),
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

export function createLimits(dataDir: string, tag?: string): Limits {
  const statePath = getStatePath(dataDir, tag);
  let stateOp = Promise.resolve();

  // This block is an in-process async mutex / operation queue.
  // stateOp starts as an already-resolved promise.
  // Each call to withStateLock() chains a new operation onto the tail of that promise.
  // Because every new operation waits for the previous one, reads/modifies/writes to the limits state file happen serially.
  const withStateLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = stateOp.then(fn, fn);
    stateOp = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const readState = async (): Promise<LimitsState> => {
    return (
      (await readJSON(statePath, LimitsStateSchema)) ?? cloneState(EMPTY_STATE)
    );
  };

  const writeState = async (state: LimitsState): Promise<void> => {
    await writeJSON(statePath, state, { overwrite: true });
  };

  return {
    async acquire(request) {
      const parsed = LimitAcquireRequestSchema.parse(request);

      return withStateLock(async (): Promise<LimitAcquireResult> => {
        const state = cloneState(await readState());
        const now = new Date();
        const nowMs = now.getTime();
        const keyState = pruneKeyState(
          state.keys[parsed.key] ?? {
            key: parsed.key,
            leases: [],
            tokens: [],
          },
          nowMs
        );

        const existingLease = keyState.leases.find(
          (lease) => lease.holderId === parsed.holderId
        );
        if (existingLease) {
          state.keys[parsed.key] = keyState;
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

        if (concurrencyBlocked || rateBlocked) {
          state.keys[parsed.key] = keyState;
          await writeState(state);
          return {
            status: 'blocked',
            reason: getBlockedReason(concurrencyBlocked, rateBlocked),
            retryAfterMs: getRetryAfterMs(
              keyState,
              nowMs,
              concurrencyBlocked,
              rateBlocked
            ),
          };
        }

        const lease: LimitLease = {
          leaseId: `lmt_${monotonicUlid()}`,
          key: parsed.key,
          holderId: parsed.holderId,
          acquiredAt: now,
          expiresAt:
            parsed.leaseTtlMs !== undefined
              ? new Date(nowMs + parsed.leaseTtlMs)
              : undefined,
          definition: parsed.definition,
        };

        keyState.leases.push(lease);

        if (parsed.definition.rate) {
          keyState.tokens.push({
            tokenId: `lmttok_${monotonicUlid()}`,
            holderId: parsed.holderId,
            acquiredAt: now,
            expiresAt: new Date(nowMs + parsed.definition.rate.periodMs),
          });
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

      await withStateLock(async () => {
        const state = cloneState(await readState());

        for (const [key, keyStateValue] of Object.entries(state.keys)) {
          const keyState = pruneKeyState(keyStateValue);
          const nextLeases = keyState.leases.filter((lease) => {
            if (lease.leaseId !== parsed.leaseId) return true;
            if (parsed.key && lease.key !== parsed.key) return true;
            if (parsed.holderId && lease.holderId !== parsed.holderId) {
              return true;
            }
            return false;
          });

          state.keys[key] = {
            ...keyState,
            leases: nextLeases,
          };

          if (
            state.keys[key].leases.length === 0 &&
            state.keys[key].tokens.length === 0
          ) {
            delete state.keys[key];
          }
        }

        await writeState(state);
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
