import type { LimitLease, World } from '@workflow/world';
import type { LockHandle, LockOptions } from '../lock.js';
import { contextStorage } from './context-storage.js';

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

    while (true) {
      const result = await world.limits.acquire({
        key: options.key,
        holderId,
        definition,
        leaseTtlMs: options.leaseTtlMs,
      });

      if (result.status === 'acquired') {
        return createStepLockHandle(result.lease, world);
      }

      await new Promise((resolve) =>
        setTimeout(resolve, result.retryAfterMs || 1000)
      );
    }
  };
}
