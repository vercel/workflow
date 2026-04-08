import {
  EntityConflictError,
  TooEarlyError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import {
  type Event,
  createLockCorrelationId,
  createLockWakeCorrelationId,
  type LockHistoryEvent,
  type LimitLease,
  type LimitDefinition,
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

type PendingLockState = {
  status: 'pending';
  isCreated: boolean;
  acquireAt?: Date;
};

type FinalLockState =
  | {
      status: 'acquired';
      event: Extract<LockHistoryEvent, { eventType: 'lock_acquired' }>;
    }
  | {
      status: 'released';
      event: Extract<LockHistoryEvent, { eventType: 'lock_release' }>;
    };

type LockState = {
  correlationId: string;
  wakeCorrelationId: string;
  key: string;
  leaseTtlMs: number;
  definition: LimitDefinition;
} & (PendingLockState | FinalLockState);

function createSuspension(ctx: WorkflowOrchestratorContext) {
  scheduleWhenIdle(ctx, () => {
    ctx.onWorkflowError(
      new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
    );
  });
}

function isLeaseLive(lease: LimitLease, now: number): boolean {
  return lease.expiresAt === undefined || lease.expiresAt.getTime() > now;
}

function isRuntimeLockEvent(event: Event): event is LockHistoryEvent {
  switch (event.eventType) {
    case 'lock_created':
    case 'lock_acquired':
    case 'lock_release':
    case 'lock_waiter_queued':
      return true;
    default:
      return false;
  }
}

function createLimitDefinition(options: LockOptions): LimitDefinition {
  if (options.concurrency !== undefined && options.rate !== undefined) {
    return {
      concurrency: options.concurrency,
      rate: options.rate,
    };
  }

  if (options.concurrency !== undefined) {
    return {
      concurrency: options.concurrency,
    };
  }

  return {
    rate: options.rate,
  };
}

function createLockHandle(
  state: LockState,
  ctx: WorkflowOrchestratorContext
): LockHandle {
  let disposed = false;
  if (state.status !== 'acquired' && state.status !== 'released') {
    throw new WorkflowRuntimeError(
      `Corrupted event log: lock ${state.correlationId} is missing lease metadata`
    );
  }

  const lease = state.event.eventData.lease;

  const markReleased = () => {
    if (state.status !== 'acquired') {
      throw new WorkflowRuntimeError(
        `Corrupted event log: lock ${state.correlationId} cannot be released from status "${state.status}"`
      );
    }

    Object.assign(state, {
      status: 'released',
      event: {
        ...state.event,
        eventType: 'lock_release',
        eventData: {
          lease: state.event.eventData.lease,
        },
      },
    });
  };

  const dispose = async () => {
    if (disposed || state.status === 'released') {
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
        markReleased();
        return;
      }
      throw error;
    }

    markReleased();
    if (eventCreatedAt) {
      ctx.advanceTimestamp(+eventCreatedAt);
    }
  };

  const heartbeat = async () => {
    if (state.status === 'released') return;
    throw new WorkflowRuntimeError(LOCK_HEARTBEAT_UNSUPPORTED_MESSAGE);
  };

  const handle: LockHandle = {
    ...lease,
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
    const lockIndex = ctx.nextLockIndex++;
    const { key, leaseTtlMs } = options;
    const state: LockState = {
      correlationId: createLockCorrelationId(ctx.runId, lockIndex),
      wakeCorrelationId: createLockWakeCorrelationId(ctx.runId, lockIndex),
      key,
      leaseTtlMs: leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS,
      definition: createLimitDefinition(options),
      status: 'pending',
      isCreated: false,
    };

    const { promise, resolve, reject } = withResolvers<LockHandle>();
    let resolved = false;
    let pendingRuntimeRequest = false;
    let suspensionScheduled = false;

    const resolveHandle = () => {
      if (resolved) return;
      resolved = true;
      ctx.invocationsQueue.delete(state.wakeCorrelationId);
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        resolve(createLockHandle(state, ctx));
      });
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

    const setPendingState = (acquireAt?: Date) => {
      Object.assign(state, {
        status: 'pending',
        isCreated: true,
        acquireAt,
      });
    };

    const shouldAttemptAcquire = () => {
      if (ctx.lockPreApproval === state.correlationId) {
        return true;
      }
      if (state.status !== 'pending') {
        return false;
      }
      if (state.acquireAt === undefined) {
        return true;
      }
      return state.acquireAt.getTime() <= Date.now();
    };

    const applyLockEvent = (
      event: LockHistoryEvent,
      advanceTimestamp: boolean
    ) => {
      if (advanceTimestamp) {
        ctx.advanceTimestamp(+event.createdAt);
      }

      switch (event.eventType) {
        case 'lock_created':
          setPendingState(event.eventData.acquireAt);
          return;

        case 'lock_acquired':
          if (!isLeaseLive(event.eventData.lease, ctx.globalThis.Date.now())) {
            setPendingState();
            return;
          }
          Object.assign(state, {
            status: 'acquired',
            event,
          });
          resolveHandle();
          return;

        case 'lock_release':
          Object.assign(state, {
            status: 'released',
            event,
          });
          resolveHandle();
          return;

        case 'lock_waiter_queued':
          return;
      }
    };

    const syncWaitingState = () => {
      if (state.status !== 'pending') {
        return;
      }
      if (state.acquireAt === undefined) {
        suspendWorkflow();
        return;
      }
      if (shouldAttemptAcquire()) {
        return;
      }
      scheduleRateRetry(state.acquireAt);
    };

    const requestLockCreated = async () => {
      try {
        const result = await getWorld().events.create(ctx.runId, {
          eventType: 'lock_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: state.correlationId,
          eventData: {
            key: state.key,
            definition: state.definition,
            leaseTtlMs: state.leaseTtlMs,
          },
        });
        const event = result.event;
        if (!event) {
          throw new WorkflowRuntimeError(
            `World did not return an event for lock ${state.correlationId}`
          );
        }
        if (!isRuntimeLockEvent(event)) {
          throw new WorkflowRuntimeError(
            `Unexpected event type for lock ${state.correlationId}: ${event.eventType}`
          );
        }
        applyLockEvent(event, true);
        syncWaitingState();
      } catch (error) {
        reject(error);
      }
    };

    const requestLockAcquired = async () => {
      try {
        const result = await getWorld().events.create(ctx.runId, {
          eventType: 'lock_acquired',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: state.correlationId,
        });
        const event = result.event;
        if (!event) {
          throw new WorkflowRuntimeError(
            `World did not acquire lock ${state.correlationId}`
          );
        }
        if (!isRuntimeLockEvent(event)) {
          throw new WorkflowRuntimeError(
            `Unexpected event type for lock ${state.correlationId}: ${event.eventType}`
          );
        }
        applyLockEvent(event, true);
        syncWaitingState();
      } catch (error) {
        if (TooEarlyError.is(error)) {
          if (error.retryAfter) {
            const acquireAt = new Date(Date.now() + error.retryAfter * 1000);
            setPendingState(acquireAt);
            scheduleRateRetry(acquireAt);
          } else {
            setPendingState();
            suspendWorkflow();
          }
          return;
        }
        reject(error);
      }
    };

    const ensureRuntimeProgress = () => {
      if (resolved || pendingRuntimeRequest) {
        return;
      }

      if (state.status === 'pending') {
        if (!state.isCreated) {
          pendingRuntimeRequest = true;
          void requestLockCreated().finally(() => {
            pendingRuntimeRequest = false;
          });
          return;
        }

        if (!shouldAttemptAcquire()) {
          if (state.acquireAt) {
            scheduleRateRetry(state.acquireAt);
          } else {
            suspendWorkflow();
          }
          return;
        }

        pendingRuntimeRequest = true;
        void requestLockAcquired().finally(() => {
          pendingRuntimeRequest = false;
        });
        return;
      }

      resolveHandle();
    };

    ctx.eventsConsumer.subscribe((event) => {
      if (!event) {
        ensureRuntimeProgress();
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== state.correlationId) {
        return EventConsumerResult.NotConsumed;
      }
      if (!isRuntimeLockEvent(event)) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new WorkflowRuntimeError(
              `Unexpected event type for lock ${state.correlationId} "${event.eventType}"`
            )
          );
        });
        return EventConsumerResult.Finished;
      }

      try {
        applyLockEvent(event, false);
        return event.eventType === 'lock_release'
          ? EventConsumerResult.Finished
          : EventConsumerResult.Consumed;
      } catch (error) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(error as Error);
        });
        return EventConsumerResult.Finished;
      }
    });

    return promise;
  };
}
