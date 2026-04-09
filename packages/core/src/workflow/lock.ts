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
  type: 'waiting';
  acquireAt?: Date;
};

type LockNeedsCreateState = {
  type: 'needs_create';
};

type LockAcquiredEvent = Extract<
  LockHistoryEvent,
  { eventType: 'lock_acquired' }
>;
type LockReleasedEvent = Extract<
  LockHistoryEvent,
  { eventType: 'lock_release' }
>;

type LockAcquiredState = {
  type: 'acquired';
  event: LockAcquiredEvent;
};

type LockReleasedState = {
  type: 'released';
  event: LockReleasedEvent;
};

type LockBaseState = {
  correlationId: string;
  wakeCorrelationId: string;
  key: string;
  leaseTtlMs: number;
  definition: LimitDefinition;
};

type LockState = LockBaseState &
  (
    | LockNeedsCreateState
    | PendingLockState
    | LockAcquiredState
    | LockReleasedState
  );

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
  getState: () => LockState,
  setReleasedState: (event: LockReleasedEvent) => void,
  ctx: WorkflowOrchestratorContext
): LockHandle {
  let disposed = false;
  const initialState = getState();
  if (initialState.type !== 'acquired' && initialState.type !== 'released') {
    throw new WorkflowRuntimeError(
      `Corrupted event log: lock ${initialState.correlationId} is missing lease metadata`
    );
  }

  const lease = initialState.event.eventData.lease;

  const createReleaseEvent = (event: LockAcquiredEvent): LockReleasedEvent => {
    return {
      ...event,
      eventType: 'lock_release',
      eventData: {
        lease: event.eventData.lease,
      },
    };
  };

  const markReleased = () => {
    const state = getState();
    if (state.type !== 'acquired') {
      throw new WorkflowRuntimeError(
        `Corrupted event log: lock ${state.correlationId} cannot be released from status "${state.type}"`
      );
    }

    setReleasedState(createReleaseEvent(state.event));
  };

  const dispose = async () => {
    const state = getState();
    if (disposed || state.type === 'released') {
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
    if (getState().type === 'released') return;
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
    const baseState: LockBaseState = {
      correlationId: createLockCorrelationId(ctx.runId, lockIndex),
      wakeCorrelationId: createLockWakeCorrelationId(ctx.runId, lockIndex),
      key,
      leaseTtlMs: leaseTtlMs ?? DEFAULT_LOCK_LEASE_TTL_MS,
      definition: createLimitDefinition(options),
    };
    let state: LockState = {
      ...baseState,
      type: 'needs_create',
    };

    const { promise, resolve, reject } = withResolvers<LockHandle>();
    let resolved = false;
    let pendingRuntimeRequest = false;
    let suspensionScheduled = false;

    const resolveHandle = () => {
      if (resolved) return;
      resolved = true;
      ctx.invocationsQueue.delete(baseState.wakeCorrelationId);
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        resolve(
          createLockHandle(
            () => state,
            (event) => {
              state = {
                ...baseState,
                type: 'released',
                event,
              };
            },
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
      ctx.invocationsQueue.set(baseState.wakeCorrelationId, {
        type: 'limit_wait',
        correlationId: baseState.wakeCorrelationId,
        resumeAt: acquireAt,
      });
      suspendWorkflow();
    };

    const setWaitingState = (acquireAt?: Date) => {
      state = {
        ...baseState,
        type: 'waiting',
        acquireAt,
      };
    };

    const shouldAttemptAcquire = () => {
      if (ctx.lockPreApproval === baseState.correlationId) {
        return true;
      }
      if (state.type !== 'waiting') {
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
          setWaitingState(event.eventData.acquireAt);
          return;

        case 'lock_acquired':
          if (!isLeaseLive(event.eventData.lease, ctx.globalThis.Date.now())) {
            setWaitingState();
            return;
          }
          state = {
            ...baseState,
            type: 'acquired',
            event,
          };
          resolveHandle();
          return;

        case 'lock_release':
          state = {
            ...baseState,
            type: 'released',
            event,
          };
          resolveHandle();
          return;
      }
    };

    const syncWaitingState = () => {
      if (state.type !== 'waiting') {
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
          correlationId: baseState.correlationId,
          eventData: {
            key: baseState.key,
            definition: baseState.definition,
            leaseTtlMs: baseState.leaseTtlMs,
          },
        });
        const event = result.event;
        if (!event) {
          throw new WorkflowRuntimeError(
            `World did not return an event for lock ${baseState.correlationId}`
          );
        }
        if (!isRuntimeLockEvent(event)) {
          throw new WorkflowRuntimeError(
            `Unexpected event type for lock ${baseState.correlationId}: ${event.eventType}`
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
          correlationId: baseState.correlationId,
        });
        const event = result.event;
        if (!event) {
          throw new WorkflowRuntimeError(
            `World did not acquire lock ${baseState.correlationId}`
          );
        }
        if (!isRuntimeLockEvent(event)) {
          throw new WorkflowRuntimeError(
            `Unexpected event type for lock ${baseState.correlationId}: ${event.eventType}`
          );
        }
        applyLockEvent(event, true);
        syncWaitingState();
      } catch (error) {
        if (TooEarlyError.is(error)) {
          if (error.retryAfter) {
            const acquireAt = new Date(Date.now() + error.retryAfter * 1000);
            setWaitingState(acquireAt);
            scheduleRateRetry(acquireAt);
          } else {
            setWaitingState();
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

      switch (state.type) {
        case 'needs_create':
          pendingRuntimeRequest = true;
          void requestLockCreated().finally(() => {
            pendingRuntimeRequest = false;
          });
          return;

        case 'waiting':
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

        case 'acquired':
        case 'released':
          resolveHandle();
          return;
      }
    };

    ctx.eventsConsumer.subscribe((event) => {
      if (!event) {
        ensureRuntimeProgress();
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== baseState.correlationId) {
        return EventConsumerResult.NotConsumed;
      }
      if (!isRuntimeLockEvent(event)) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new WorkflowRuntimeError(
              `Unexpected event type for lock ${baseState.correlationId} "${event.eventType}"`
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
