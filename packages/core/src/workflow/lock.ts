import {
  EntityConflictError,
  TooEarlyError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import {
  type CreateEventRequest,
  createLockCorrelationId,
  createLockWakeCorrelationId,
  type LimitDefinition,
  type LimitLease,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { EventConsumerResult } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { LockHandle, LockOptions } from '../lock.js';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from '../private.js';
import { getWorld } from '../runtime/world.js';

const DEFAULT_LOCK_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_UNSUPPORTED_MESSAGE =
  'Lock heartbeat is not supported in workflow functions yet because it cannot be replayed deterministically.';

type LockLeaseView = Pick<
  LimitLease,
  'leaseId' | 'key' | 'lockId' | 'runId' | 'lockIndex' | 'expiresAt'
>;

interface LockState {
  correlationId: string;
  wakeCorrelationId: string;
  key: string;
  leaseTtlMs: number;
  definition: LimitDefinition;
  acquireAt?: Date;
  lease?: LockLeaseView;
  hasCreatedEvent: boolean;
  hasAcquiredEvent: boolean;
  hasReleaseEvent: boolean;
}

function createSuspension(ctx: WorkflowOrchestratorContext) {
  scheduleWhenIdle(ctx, () => {
    ctx.onWorkflowError(
      new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
    );
  });
}

function isLeaseLive(lease: Pick<LimitLease, 'expiresAt'>): boolean {
  return (
    lease.expiresAt === undefined || lease.expiresAt.getTime() > Date.now()
  );
}

function getReleasedLeaseView(
  ctx: WorkflowOrchestratorContext,
  event: Extract<CreateEventRequest, { eventType: 'lock_release' }> | any
): LockLeaseView | undefined {
  const data = event.eventData;
  if (!data?.leaseId || !data?.key || !data?.lockId) {
    return undefined;
  }

  return {
    leaseId: data.leaseId,
    key: data.key,
    lockId: data.lockId,
    runId: ctx.runId,
    lockIndex: Number.parseInt(data.lockId.split(':').at(-1) ?? '0', 10),
    expiresAt: undefined,
  };
}

function createLockHandle(
  state: LockState,
  ctx: WorkflowOrchestratorContext
): LockHandle {
  let disposed = false;

  const getLease = () => {
    if (!state.lease) {
      throw new WorkflowRuntimeError(
        `Corrupted event log: lock ${state.correlationId} is missing lease metadata`
      );
    }
    return state.lease;
  };

  const dispose = async () => {
    if (disposed || state.hasReleaseEvent) {
      return;
    }

    disposed = true;
    let eventCreatedAt: Date | undefined;
    try {
      const result = await getWorld().events.create(ctx.runId, {
        eventType: 'lock_release',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: state.correlationId,
      });
      eventCreatedAt = result.event?.createdAt;
    } catch (error) {
      if (EntityConflictError.is(error)) {
        state.hasReleaseEvent = true;
        return;
      }
      throw error;
    }

    state.hasReleaseEvent = true;
    if (eventCreatedAt) {
      ctx.advanceTimestamp(+eventCreatedAt);
    }
  };

  const heartbeat = async (ttlMs?: number) => {
    if (state.hasReleaseEvent) return;
    void ttlMs;
    getLease();
    throw new WorkflowRuntimeError(LOCK_HEARTBEAT_UNSUPPORTED_MESSAGE);
  };

  const handle: LockHandle = {
    get leaseId() {
      return getLease().leaseId;
    },
    get key() {
      return getLease().key;
    },
    get lockId() {
      return getLease().lockId;
    },
    get runId() {
      return getLease().runId;
    },
    get lockIndex() {
      return getLease().lockIndex;
    },
    get expiresAt() {
      return getLease().expiresAt;
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

function createLockCreatedEvent(
  state: LockState
): Extract<CreateEventRequest, { eventType: 'lock_created' }> {
  return {
    eventType: 'lock_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: state.correlationId,
    eventData: {
      key: state.key,
      definition: state.definition,
      leaseTtlMs: state.leaseTtlMs,
    },
  };
}

function createLockAcquiredEvent(
  state: LockState
): Extract<CreateEventRequest, { eventType: 'lock_acquired' }> {
  return {
    eventType: 'lock_acquired',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: state.correlationId,
  };
}

export function createLock(ctx: WorkflowOrchestratorContext) {
  return async function lockImpl(options: LockOptions): Promise<LockHandle> {
    const lockIndex = ctx.nextLockIndex++;
    const state: LockState = {
      correlationId: createLockCorrelationId(ctx.runId, lockIndex),
      wakeCorrelationId: createLockWakeCorrelationId(ctx.runId, lockIndex),
      key: options.key,
      leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS,
      definition: {
        concurrency: options.concurrency,
        rate: options.rate,
      },
      hasCreatedEvent: false,
      hasAcquiredEvent: false,
      hasReleaseEvent: false,
    };

    const { promise, resolve, reject } = withResolvers<LockHandle>();
    let resolved = false;
    let pendingRuntimeRequest = false;
    let suspensionScheduled = false;

    const resolveHandle = () => {
      if (resolved) return;
      resolved = true;
      ctx.invocationsQueue.delete(state.wakeCorrelationId);
      resolve(createLockHandle(state, ctx));
    };

    const suspendWorkflow = () => {
      if (suspensionScheduled || resolved) {
        return;
      }
      suspensionScheduled = true;
      createSuspension(ctx);
    };

    const scheduleRateRetry = (acquireAt: Date) => {
      ctx.invocationsQueue.set(state.wakeCorrelationId, {
        type: 'limit_wait',
        correlationId: state.wakeCorrelationId,
        resumeAt: acquireAt,
      });
      suspendWorkflow();
    };

    const shouldAttemptAcquire = (acquireAt?: Date) => {
      if (ctx.lockPreApproval === state.correlationId) {
        return true;
      }
      if (!acquireAt) {
        return false;
      }
      return acquireAt.getTime() <= Date.now();
    };

    const requestLockCreated = async () => {
      try {
        const result = await getWorld().events.create(
          ctx.runId,
          createLockCreatedEvent(state)
        );
        const event = result.event;
        if (!event) {
          throw new WorkflowRuntimeError(
            `World did not return an event for lock ${state.correlationId}`
          );
        }

        if (event.eventType === 'lock_acquired') {
          if (!event.eventData?.lease) {
            throw new WorkflowRuntimeError(
              `Corrupted event log: lock ${state.correlationId} acquisition is missing lease metadata`
            );
          }
          if (!isLeaseLive(event.eventData.lease)) {
            state.hasCreatedEvent = true;
            state.acquireAt = new Date(0);
            suspendWorkflow();
            return;
          }
          state.hasCreatedEvent = true;
          state.hasAcquiredEvent = true;
          state.lease = event.eventData.lease;
          ctx.advanceTimestamp(+event.createdAt);
          resolveHandle();
          return;
        }

        if (event.eventType === 'lock_release') {
          state.hasCreatedEvent = true;
          state.hasAcquiredEvent = true;
          state.hasReleaseEvent = true;
          state.lease ??= getReleasedLeaseView(ctx, event);
          ctx.advanceTimestamp(+event.createdAt);
          resolveHandle();
          return;
        }

        if (event.eventType !== 'lock_created') {
          throw new WorkflowRuntimeError(
            `Unexpected event type for lock ${state.correlationId}: ${event.eventType}`
          );
        }

        state.hasCreatedEvent = true;
        ctx.advanceTimestamp(+event.createdAt);
        if (event.eventData.acquireAt) {
          state.acquireAt = event.eventData.acquireAt;
          scheduleRateRetry(event.eventData.acquireAt);
          return;
        }

        state.acquireAt = undefined;
        suspendWorkflow();
      } catch (error) {
        reject(error);
      }
    };

    const requestLockAcquired = async () => {
      try {
        const result = await getWorld().events.create(
          ctx.runId,
          createLockAcquiredEvent(state)
        );
        const event = result.event;
        if (
          !event ||
          (event.eventType !== 'lock_acquired' &&
            event.eventType !== 'lock_release')
        ) {
          throw new WorkflowRuntimeError(
            `World did not acquire lock ${state.correlationId}`
          );
        }

        if (event.eventType === 'lock_release') {
          state.hasCreatedEvent = true;
          state.hasAcquiredEvent = true;
          state.hasReleaseEvent = true;
          state.lease ??= getReleasedLeaseView(ctx, event);
          ctx.advanceTimestamp(+event.createdAt);
          resolveHandle();
          return;
        }

        if (!event.eventData?.lease) {
          throw new WorkflowRuntimeError(
            `World did not acquire lock ${state.correlationId}`
          );
        }
        if (!isLeaseLive(event.eventData.lease)) {
          state.acquireAt = new Date(0);
          suspendWorkflow();
          return;
        }
        state.hasAcquiredEvent = true;
        state.lease = event.eventData.lease;
        ctx.advanceTimestamp(+event.createdAt);
        resolveHandle();
      } catch (error) {
        if (TooEarlyError.is(error)) {
          if (error.retryAfter) {
            state.acquireAt = error.retryAfter;
            scheduleRateRetry(error.retryAfter);
          } else {
            state.acquireAt = undefined;
            suspendWorkflow();
          }
          return;
        }
        reject(error);
      }
    };

    const ensureRuntimeProgress = (acquireAt?: Date) => {
      if (resolved || pendingRuntimeRequest) {
        return;
      }

      if (!state.hasCreatedEvent) {
        pendingRuntimeRequest = true;
        void requestLockCreated().finally(() => {
          pendingRuntimeRequest = false;
        });
        return;
      }

      if (state.hasAcquiredEvent) {
        resolveHandle();
        return;
      }

      if (!shouldAttemptAcquire(acquireAt)) {
        if (acquireAt) {
          scheduleRateRetry(acquireAt);
        } else {
          suspendWorkflow();
        }
        return;
      }

      pendingRuntimeRequest = true;
      void requestLockAcquired().finally(() => {
        pendingRuntimeRequest = false;
      });
    };

    ctx.eventsConsumer.subscribe((event) => {
      if (!event) {
        ensureRuntimeProgress(state.acquireAt);
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== state.correlationId) {
        return EventConsumerResult.NotConsumed;
      }

      if (event.eventType === 'lock_created') {
        state.hasCreatedEvent = true;
        state.acquireAt = event.eventData.acquireAt;
        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'lock_acquired') {
        if (!event.eventData?.lease) {
          ctx.promiseQueue = ctx.promiseQueue.then(() => {
            ctx.onWorkflowError(
              new WorkflowRuntimeError(
                `Corrupted event log: lock ${state.correlationId} acquisition is missing lease metadata`
              )
            );
          });
          return EventConsumerResult.Finished;
        }
        if (!isLeaseLive(event.eventData.lease)) {
          state.hasCreatedEvent = true;
          state.acquireAt = new Date(0);
          return EventConsumerResult.Consumed;
        }
        state.hasCreatedEvent = true;
        state.hasAcquiredEvent = true;
        state.lease = event.eventData.lease;
        resolveHandle();
        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'lock_release') {
        state.lease ??= getReleasedLeaseView(ctx, event);
        state.hasCreatedEvent = true;
        state.hasAcquiredEvent = true;
        state.hasReleaseEvent = true;
        ctx.invocationsQueue.delete(state.wakeCorrelationId);
        resolveHandle();
        return EventConsumerResult.Finished;
      }

      if (event.eventType === 'lock_waiter_queued') {
        return EventConsumerResult.Consumed;
      }

      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new WorkflowRuntimeError(
            `Unexpected event type for lock ${state.correlationId} "${event.eventType}"`
          )
        );
      });
      return EventConsumerResult.Finished;
    });

    return promise;
  };
}
