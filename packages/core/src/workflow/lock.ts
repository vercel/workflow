import {
  EntityConflictError,
  TooEarlyError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import {
  type CreateEventRequest,
  type Event,
  createLockCorrelationId,
  createLockWakeCorrelationId,
  type LockHistoryEvent,
  type LimitDefinition,
  type LimitLease,
  parseLockId,
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

type LockPhase =
  | {
      type: 'creating';
    }
  | {
      type: 'waiting_for_turn';
    }
  | {
      type: 'waiting_for_time';
      acquireAt: Date;
    }
  | {
      type: 'acquired';
      lease: LockLeaseView;
    }
  | {
      type: 'released';
      lease: LockLeaseView;
    };

interface LockState {
  correlationId: string;
  wakeCorrelationId: string;
  key: string;
  leaseTtlMs: number;
  definition: LimitDefinition;
  phase: LockPhase;
}

function createLimitDefinition(options: LockOptions): LimitDefinition {
  if (options.concurrency && options.rate) {
    return {
      concurrency: options.concurrency,
      rate: options.rate,
    };
  }
  if (options.concurrency) {
    return {
      concurrency: options.concurrency,
    };
  }
  return {
    rate: options.rate,
  };
}

function createSuspension(ctx: WorkflowOrchestratorContext) {
  scheduleWhenIdle(ctx, () => {
    ctx.onWorkflowError(
      new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis)
    );
  });
}

function isLeaseLive(
  lease: Pick<LimitLease, 'expiresAt'>,
  now: number
): boolean {
  return lease.expiresAt === undefined || lease.expiresAt.getTime() > now;
}

function getReleasedLeaseView(
  event: Extract<Event, { eventType: 'lock_release' }>
): LockLeaseView {
  const parsed = parseLockId(event.eventData.lockId);
  if (!parsed) {
    throw new WorkflowRuntimeError(
      `Corrupted event log: lock ${event.correlationId} release has invalid lockId "${event.eventData.lockId}"`
    );
  }

  return {
    leaseId: event.eventData.leaseId,
    key: event.eventData.key,
    lockId: event.eventData.lockId,
    runId: parsed.runId,
    lockIndex: parsed.lockIndex,
    expiresAt: undefined,
  };
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

function createLockHandle(
  state: LockState,
  ctx: WorkflowOrchestratorContext
): LockHandle {
  let disposed = false;

  const getLease = () => {
    if (state.phase.type === 'acquired' || state.phase.type === 'released') {
      return state.phase.lease;
    }

    throw new WorkflowRuntimeError(
      `Corrupted event log: lock ${state.correlationId} is missing lease metadata`
    );
  };

  const markReleased = () => {
    state.phase = {
      type: 'released',
      lease: getLease(),
    };
  };

  const dispose = async () => {
    if (disposed || state.phase.type === 'released') {
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
    if (state.phase.type === 'released') return;
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
      definition: createLimitDefinition(options),
      phase: {
        type: 'creating',
      },
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

    const setWaitingPhase = (acquireAt?: Date) => {
      state.phase = acquireAt
        ? {
            type: 'waiting_for_time',
            acquireAt,
          }
        : {
            type: 'waiting_for_turn',
          };
    };

    const shouldAttemptAcquire = () => {
      if (ctx.lockPreApproval === state.correlationId) {
        return true;
      }

      if (state.phase.type === 'waiting_for_turn') {
        return true;
      }
      if (state.phase.type !== 'waiting_for_time') {
        return false;
      }

      return state.phase.acquireAt.getTime() <= Date.now();
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
          setWaitingPhase(event.eventData.acquireAt);
          return;

        case 'lock_acquired':
          if (!isLeaseLive(event.eventData.lease, ctx.globalThis.Date.now())) {
            setWaitingPhase();
            return;
          }
          state.phase = {
            type: 'acquired',
            lease: event.eventData.lease,
          };
          resolveHandle();
          return;

        case 'lock_release':
          state.phase = {
            type: 'released',
            lease: getReleasedLeaseView(event),
          };
          resolveHandle();
          return;

        case 'lock_waiter_queued':
          return;
      }
    };

    const syncWaitingState = () => {
      switch (state.phase.type) {
        case 'waiting_for_turn':
          suspendWorkflow();
          return;

        case 'waiting_for_time':
          if (shouldAttemptAcquire()) {
            return;
          }
          scheduleRateRetry(state.phase.acquireAt);
          return;

        case 'acquired':
        case 'released':
          return;

        case 'creating':
          throw new WorkflowRuntimeError(
            `Lock ${state.correlationId} did not leave the creating phase`
          );
      }
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
        const result = await getWorld().events.create(
          ctx.runId,
          createLockAcquiredEvent(state)
        );
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
            setWaitingPhase(acquireAt);
            scheduleRateRetry(acquireAt);
          } else {
            setWaitingPhase();
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

      switch (state.phase.type) {
        case 'creating':
          pendingRuntimeRequest = true;
          void requestLockCreated().finally(() => {
            pendingRuntimeRequest = false;
          });
          return;

        case 'acquired':
        case 'released':
          resolveHandle();
          return;

        case 'waiting_for_turn':
        case 'waiting_for_time': {
          if (!shouldAttemptAcquire()) {
            if (state.phase.type === 'waiting_for_time') {
              scheduleRateRetry(state.phase.acquireAt);
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
      }
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
