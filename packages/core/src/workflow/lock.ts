import { EventConsumerResult } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { LockHandle, LockOptions } from '../lock.js';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from '../private.js';
import { getWorld } from '../runtime/world.js';

function createLockHandle(
  lease: {
    leaseId: string;
    key: string;
    holderId: string;
    expiresAt?: Date;
  },
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
      holderId: currentLease.holderId,
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

  const vmAsyncDispose = ctx.globalThis.Symbol.asyncDispose;
  if (vmAsyncDispose && vmAsyncDispose !== Symbol.asyncDispose) {
    (handle as any)[vmAsyncDispose] = dispose;
  }

  return handle;
}

export function createLock(ctx: WorkflowOrchestratorContext) {
  return async function lockImpl(options: LockOptions): Promise<LockHandle> {
    const holderId = `wflock_${ctx.generateUlid()}`;
    const definition = {
      concurrency: options.concurrency,
      rate: options.rate,
    };

    while (true) {
      const result = await getWorld().limits.acquire({
        key: options.key,
        holderId,
        definition,
        leaseTtlMs: options.leaseTtlMs,
      });

      if (result.status === 'acquired') {
        return createLockHandle(result.lease, ctx);
      }

      const correlationId = `wflock_wait_${ctx.generateUlid()}`;
      const resumeAt = new Date(Date.now() + (result.retryAfterMs || 1000));
      ctx.invocationsQueue.set(correlationId, {
        type: 'wait',
        correlationId,
        resumeAt,
      });

      await new Promise<void>((resolve) => {
        ctx.eventsConsumer.subscribe((event) => {
          if (!event) {
            scheduleWhenIdle(ctx, () => {
              ctx.onWorkflowError(
                new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
              );
            });
            return EventConsumerResult.NotConsumed;
          }

          if (event.correlationId !== correlationId) {
            return EventConsumerResult.NotConsumed;
          }

          if (event.eventType === 'wait_created') {
            const queueItem = ctx.invocationsQueue.get(correlationId);
            if (queueItem && queueItem.type === 'wait') {
              queueItem.hasCreatedEvent = true;
              queueItem.resumeAt = event.eventData.resumeAt;
            }
            return EventConsumerResult.Consumed;
          }

          if (event.eventType === 'wait_completed') {
            ctx.invocationsQueue.delete(correlationId);
            ctx.promiseQueue = ctx.promiseQueue.then(() => {
              resolve();
            });
            return EventConsumerResult.Finished;
          }

          return EventConsumerResult.NotConsumed;
        });
      });
    }
  };
}
