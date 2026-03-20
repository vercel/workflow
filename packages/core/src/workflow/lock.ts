import { WorkflowSuspension } from '../global.js';
import type { LockHandle, LockOptions } from '../lock.js';
import { createLockWakeCorrelationId, type LimitLease } from '@workflow/world';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from '../private.js';
import { getWorld } from '../runtime/world.js';

const DEFAULT_LOCK_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

function createLockHandle(
  lease: Pick<
    LimitLease,
    'leaseId' | 'key' | 'lockId' | 'runId' | 'lockIndex' | 'expiresAt'
  >,
  ctx: WorkflowOrchestratorContext
): LockHandle {
  let currentLease = lease;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await getWorld().limits.release({
      leaseId: currentLease.leaseId,
      key: currentLease.key,
      lockId: currentLease.lockId,
    });
  };

  const heartbeat = async (ttlMs?: number) => {
    currentLease = await getWorld().limits.heartbeat({
      leaseId: currentLease.leaseId,
      ttlMs,
    });
  };

  const handle: LockHandle = {
    get leaseId() {
      return currentLease.leaseId;
    },
    get key() {
      return currentLease.key;
    },
    get lockId() {
      return currentLease.lockId;
    },
    get runId() {
      return currentLease.runId;
    },
    get lockIndex() {
      return currentLease.lockIndex;
    },
    get expiresAt() {
      return currentLease.expiresAt;
    },
    dispose,
    heartbeat,
    [Symbol.asyncDispose]: dispose,
  };

  const vmAsyncDispose = ctx.globalThis.Symbol.asyncDispose;
  if (vmAsyncDispose && vmAsyncDispose !== Symbol.asyncDispose) {
    (handle as any)[vmAsyncDispose] = dispose;
  }

  return handle;
}

export function createLock(ctx: WorkflowOrchestratorContext) {
  return async function lockImpl(options: LockOptions): Promise<LockHandle> {
    /*
    Blocked workflow locks suspend the workflow turn instead of creating a real
    wait event. Postgres can wake this correlation id early when the waiter is
    promoted, and the delayed replay is just a fallback.
    */
    const lockIndex = ctx.nextLockIndex++;
    const correlationId = createLockWakeCorrelationId(ctx.runId, lockIndex);
    const definition = {
      concurrency: options.concurrency,
      rate: options.rate,
    };

    while (true) {
      const result = await getWorld().limits.acquire({
        key: options.key,
        runId: ctx.runId,
        lockIndex,
        definition,
        leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS,
      });

      if (result.status === 'acquired') {
        return createLockHandle(result.lease, ctx);
      }

      ctx.invocationsQueue.set(correlationId, {
        type: 'limit_wait',
        correlationId,
        resumeAt: new Date(Date.now() + (result.retryAfterMs || 1000)),
      });

      scheduleWhenIdle(ctx, () => {
        ctx.onWorkflowError(
          new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
        );
      });

      await new Promise<never>(() => {});
    }
  };
}
