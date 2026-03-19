import type { LimitAcquireRequest, LimitLease, World } from '@workflow/world';
import type { LockHandle, LockOptions } from '../lock.js';
import { contextStorage } from './context-storage.js';

export class StepLockBlockedError extends Error {
  retryAfterMs?: number;
  request: LimitAcquireRequest;

  constructor(request: LimitAcquireRequest, retryAfterMs?: number) {
    super('Step lock blocked');
    this.name = 'StepLockBlockedError';
    this.retryAfterMs = retryAfterMs;
    this.request = request;
  }

  static is(value: unknown): value is StepLockBlockedError {
    return value instanceof StepLockBlockedError;
  }
}

function createStepLockHandle(lease: LimitLease, world: World): LockHandle {
  let currentLease = lease;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await world.limits.release({
      leaseId: currentLease.leaseId,
      key: currentLease.key,
      holderId: currentLease.holderId,
    });
  };

  const heartbeat = async (ttlMs?: number) => {
    currentLease = await world.limits.heartbeat({
      leaseId: currentLease.leaseId,
      ttlMs,
    });
  };

  return {
    get leaseId() {
      return currentLease.leaseId;
    },
    get key() {
      return currentLease.key;
    },
    get holderId() {
      return currentLease.holderId;
    },
    get expiresAt() {
      return currentLease.expiresAt;
    },
    dispose,
    heartbeat,
    [Symbol.asyncDispose]: dispose,
  };
}

export function createStepLock(world: World) {
  return async function lockInStep(options: LockOptions): Promise<LockHandle> {
    const store = contextStorage.getStore();
    if (!store) {
      throw new Error(
        '`lock()` can only be called inside a workflow or step function'
      );
    }

    const lockIndex = store.lockCounter++;
    const holderId = `stplock_${store.workflowMetadata.workflowRunId}:${store.stepMetadata.stepId}:${lockIndex}`;
    const definition = {
      concurrency: options.concurrency,
      rate: options.rate,
    };
    const request = {
      key: options.key,
      holderId,
      definition,
      leaseTtlMs: options.leaseTtlMs,
    } satisfies LimitAcquireRequest;

    const preAcquiredLease = store.preAcquiredLocks?.[holderId];
    if (preAcquiredLease) {
      if (store.preAcquiredLocks) {
        delete store.preAcquiredLocks[holderId];
      }
      return createStepLockHandle(preAcquiredLease, world);
    }

    const result = await world.limits.acquire(request);

    if (result.status === 'acquired') {
      return createStepLockHandle(result.lease, world);
    }

    /*
    Steps do not sit inside user code polling for a lease.
    The runtime catches this and re-queues the step attempt at the boundary.
    */
    throw new StepLockBlockedError(request, result.retryAfterMs);
  };
}
