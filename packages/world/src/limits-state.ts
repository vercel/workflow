import {
  createLockCorrelationId,
  createLockWakeCorrelationId,
  getBlockedReason,
  type LimitBlockedReason,
  type LimitDefinition,
  type LimitPromotedWaiter,
  parseLockId,
} from './limits.js';

type ExpiringValue = {
  expiresAt?: Date | string | null | undefined;
};

type WaiterValue = {
  waiterId: string;
};

export interface LimitStateSnapshot<
  TLease = ExpiringValue,
  TToken = ExpiringValue,
  TWaiter = WaiterValue,
> {
  definition: LimitDefinition;
  leases: readonly TLease[];
  tokens: readonly TToken[];
  waiters: readonly TWaiter[];
}

export interface LimitStateBlock {
  queuedBlocked: boolean;
  concurrencyBlocked: boolean;
  rateBlocked: boolean;
  retryAfterMs: number | undefined;
}

export type LimitAcquireDecision<TLease, TWaiter> =
  | {
      type: 'reuse_lease';
      lease: TLease;
    }
  | {
      type: 'promote_waiter';
      waiter: TWaiter;
    }
  | {
      type: 'block';
      enqueueWaiter: boolean;
      reason: LimitBlockedReason;
      retryAfterMs: number | undefined;
    }
  | {
      type: 'acquire_new';
    };

function toTimestamp(
  value: Date | string | null | undefined
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function getRetryAfterMs(
  leases: readonly ExpiringValue[],
  tokens: readonly ExpiringValue[],
  now: number,
  concurrencyBlocked: boolean,
  rateBlocked: boolean
): number | undefined {
  let retryAfterMs: number | undefined;

  if (concurrencyBlocked) {
    for (const lease of leases) {
      const expiresAt = toTimestamp(lease.expiresAt);
      if (expiresAt === undefined) {
        continue;
      }

      const candidate = Math.max(0, expiresAt - now);
      retryAfterMs =
        retryAfterMs === undefined
          ? candidate
          : Math.min(retryAfterMs, candidate);
    }
  }

  if (rateBlocked) {
    for (const token of tokens) {
      const expiresAt = toTimestamp(token.expiresAt);
      if (expiresAt === undefined) {
        continue;
      }

      const candidate = Math.max(0, expiresAt - now);
      retryAfterMs =
        retryAfterMs === undefined
          ? candidate
          : Math.min(retryAfterMs, candidate);
    }
  }

  return retryAfterMs;
}

export function inspectLimitState<
  TLease extends ExpiringValue,
  TToken extends ExpiringValue,
  TWaiter extends WaiterValue,
>(
  state: LimitStateSnapshot<TLease, TToken, TWaiter>,
  existingWaiterId?: string,
  now = Date.now()
): LimitStateBlock {
  const concurrencyBlocked =
    state.definition.concurrency !== undefined &&
    state.leases.length >= state.definition.concurrency.max;
  const rateBlocked =
    state.definition.rate !== undefined &&
    state.tokens.length >= state.definition.rate.count;

  const queuedBlocked =
    state.waiters.length > 0 && state.waiters[0]?.waiterId !== existingWaiterId;
  const headWaiterRetryAfterMs =
    state.waiters.length === 0
      ? undefined
      : getRetryAfterMs(
          state.leases,
          state.tokens,
          now,
          concurrencyBlocked,
          rateBlocked
        );

  return {
    queuedBlocked,
    concurrencyBlocked,
    rateBlocked,
    retryAfterMs:
      headWaiterRetryAfterMs ??
      getRetryAfterMs(
        state.leases,
        state.tokens,
        now,
        concurrencyBlocked,
        rateBlocked
      ),
  };
}

export function canAcquireFromState(state: LimitStateBlock): boolean {
  return (
    !state.queuedBlocked && !state.concurrencyBlocked && !state.rateBlocked
  );
}

export function decideLimitAcquire<
  TLease extends ExpiringValue,
  TToken extends ExpiringValue = ExpiringValue,
  TWaiter extends WaiterValue = WaiterValue,
>(input: {
  state: LimitStateSnapshot<TLease, TToken, TWaiter>;
  lockId: string;
  getLeaseLockId(lease: TLease): string;
  getWaiterLockId(waiter: TWaiter): string;
}): LimitAcquireDecision<TLease, TWaiter> {
  const existingLease = input.state.leases.find(
    (lease) => input.getLeaseLockId(lease) === input.lockId
  );
  if (existingLease) {
    return {
      type: 'reuse_lease',
      lease: existingLease,
    };
  }

  const existingWaiter = input.state.waiters.find(
    (waiter) => input.getWaiterLockId(waiter) === input.lockId
  );
  const blockedState = inspectLimitState(input.state, existingWaiter?.waiterId);

  if (existingWaiter && canAcquireFromState(blockedState)) {
    return {
      type: 'promote_waiter',
      waiter: existingWaiter,
    };
  }

  if (existingWaiter || !canAcquireFromState(blockedState)) {
    return {
      type: 'block',
      enqueueWaiter: !existingWaiter,
      reason: getBlockedReasonFromState(blockedState),
      retryAfterMs: blockedState.retryAfterMs,
    };
  }

  return {
    type: 'acquire_new',
  };
}

export function getBlockedReasonFromState(
  state: LimitStateBlock
): LimitBlockedReason {
  return getBlockedReason(
    state.queuedBlocked,
    state.concurrencyBlocked,
    state.rateBlocked
  );
}

export function isLimitStateEmpty(
  state: Pick<LimitStateSnapshot, 'leases' | 'tokens' | 'waiters'>
): boolean {
  return (
    state.leases.length === 0 &&
    state.tokens.length === 0 &&
    state.waiters.length === 0
  );
}

export function createPromotedWaiter(input: {
  leaseId: string;
  key: string;
  lockId: string;
}): LimitPromotedWaiter {
  const parsed = parseLockId(input.lockId);
  if (!parsed) {
    throw new Error(`Invalid lock ID "${input.lockId}"`);
  }

  return {
    leaseId: input.leaseId,
    key: input.key,
    lockId: input.lockId,
    runId: parsed.runId,
    lockIndex: parsed.lockIndex,
    wakeCorrelationId: createLockWakeCorrelationId(
      parsed.runId,
      parsed.lockIndex
    ),
    lockCorrelationId: createLockCorrelationId(parsed.runId, parsed.lockIndex),
  };
}
