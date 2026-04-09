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

type LockWaitingState = {
  type: 'waiting';
  acquireAt?: Date;
};

type LockReadyState = {
  type: 'ready';
  lease: LimitLease;
  released: boolean;
};

type LockState =
  | {
      type: 'create';
    }
  | LockWaitingState
  | LockReadyState;

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
      return true;
    default:
      return false;
  }
}

function createLockHandle(
  getState: () => LockState,
  markReleased: () => void,
  correlationId: string,
  ctx: WorkflowOrchestratorContext
): LockHandle {
  const getReadyState = () => {
    const state = getState();
    if (state.type !== 'ready') {
      throw new WorkflowRuntimeError(
        `Corrupted event log: lock ${correlationId} is missing lease metadata`
      );
    }
    return state;
  };

  let disposed = false;
  const lease = getReadyState().lease;

  const dispose = async () => {
    const state = getReadyState();
    if (disposed || state.released) {
      return;
    }

    disposed = true;
    let eventCreatedAt: Date | undefined;
    try {
      const result = await getWorld().events.create(ctx.runId, {
        eventType: 'lock_release',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId,
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
    if (getReadyState().released) return;
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
    const correlationId = createLockCorrelationId(ctx.runId, lockIndex);
    const wakeCorrelationId = createLockWakeCorrelationId(ctx.runId, lockIndex);
    const effectiveLeaseTtlMs = leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS;
    const definition =
      options.concurrency === undefined
        ? { rate: options.rate }
        : options.rate === undefined
          ? { concurrency: options.concurrency }
          : {
              concurrency: options.concurrency,
              rate: options.rate,
            };
    let state: LockState = { type: 'create' };

    const { promise, resolve, reject } = withResolvers<LockHandle>();
    let resolved = false;
    let pendingRuntimeRequest = false;
    let suspensionScheduled = false;

    const resolveHandle = () => {
      if (resolved) return;
      resolved = true;
      ctx.invocationsQueue.delete(wakeCorrelationId);
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        resolve(
          createLockHandle(
            () => state,
            () => {
              if (state.type !== 'ready') {
                throw new WorkflowRuntimeError(
                  `Corrupted event log: lock ${correlationId} cannot be released from status "${state.type}"`
                );
              }
              state = { ...state, released: true };
            },
            correlationId,
            ctx
          )
        );
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
      ctx.invocationsQueue.set(wakeCorrelationId, {
        type: 'limit_wait',
        correlationId: wakeCorrelationId,
        resumeAt: acquireAt,
      });
      suspendWorkflow();
    };

    const setWaitingState = (acquireAt?: Date) => {
      state = {
        type: 'waiting',
        acquireAt,
      };
    };

    const shouldPauseWhileWaiting = (acquireAt?: Date) => {
      if (ctx.lockPreApproval === correlationId) {
        return false;
      }
      if (acquireAt === undefined) {
        suspendWorkflow();
        return true;
      }
      if (acquireAt.getTime() <= Date.now()) {
        return false;
      }

      scheduleRateRetry(acquireAt);
      return true;
    };

    const getRuntimeLockEvent = (event: Event | undefined) => {
      if (!event) {
        throw new WorkflowRuntimeError(
          `World did not return an event for lock ${correlationId}`
        );
      }
      if (!isRuntimeLockEvent(event)) {
        throw new WorkflowRuntimeError(
          `Unexpected event type for lock ${correlationId}: ${event.eventType}`
        );
      }
      return event;
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
          setWaitingState(event.eventData.acquireAt);
          return;

        case 'lock_acquired': {
          const lease = event.eventData.lease;
          if (!isLeaseLive(lease, ctx.globalThis.Date.now())) {
            setWaitingState();
            return;
          }
          state = {
            type: 'ready',
            lease,
            released: false,
          };
          resolveHandle();
          return;
        }

        case 'lock_release':
          state = {
            type: 'ready',
            lease: event.eventData.lease,
            released: true,
          };
          resolveHandle();
          return;
      }
    };

    const requestLockEvent = async (
      eventType: 'lock_created' | 'lock_acquired'
    ) => {
      try {
        const result = await getWorld().events.create(
          ctx.runId,
          eventType === 'lock_created'
            ? {
                eventType,
                specVersion: SPEC_VERSION_CURRENT,
                correlationId,
                eventData: {
                  key,
                  definition,
                  leaseTtlMs: effectiveLeaseTtlMs,
                },
              }
            : {
                eventType,
                specVersion: SPEC_VERSION_CURRENT,
                correlationId,
              }
        );

        applyLockEvent(getRuntimeLockEvent(result.event), true);
        if (state.type === 'waiting') {
          shouldPauseWhileWaiting(state.acquireAt);
        }
      } catch (error) {
        if (eventType === 'lock_acquired' && TooEarlyError.is(error)) {
          let acquireAt: Date | undefined;
          if (error.retryAfter) {
            acquireAt = new Date(Date.now() + error.retryAfter * 1000);
            setWaitingState(acquireAt);
          } else {
            setWaitingState();
          }
          shouldPauseWhileWaiting(acquireAt);
          return;
        }
        reject(error);
      }
    };

    const ensureRuntimeProgress = () => {
      if (resolved || pendingRuntimeRequest) {
        return;
      }

      switch (state.type) {
        case 'create':
          pendingRuntimeRequest = true;
          void requestLockEvent('lock_created').finally(() => {
            pendingRuntimeRequest = false;
          });
          return;

        case 'waiting':
          if (shouldPauseWhileWaiting(state.acquireAt)) {
            return;
          }

          pendingRuntimeRequest = true;
          void requestLockEvent('lock_acquired').finally(() => {
            pendingRuntimeRequest = false;
          });
          return;

        case 'ready':
          resolveHandle();
          return;
      }
    };

    ctx.eventsConsumer.subscribe((event) => {
      if (!event) {
        ensureRuntimeProgress();
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== correlationId) {
        return EventConsumerResult.NotConsumed;
      }
      if (!isRuntimeLockEvent(event)) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new WorkflowRuntimeError(
              `Unexpected event type for lock ${correlationId} "${event.eventType}"`
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
