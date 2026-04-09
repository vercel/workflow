import { type CreateEventRequest, EventSchema, type Event } from './events.js';
import {
  type LimitAcquireRequest,
  type LimitLease,
  type LimitPromotedWaiter,
  type LimitReleaseRequest,
  type Limits,
  parseLockCorrelationId,
} from './limits.js';
import type { Queue } from './queue.js';
import type { WorkflowRunWithoutData } from './runs.js';

export type LockCreatedEvent = Extract<Event, { eventType: 'lock_created' }>;
export type LockAcquiredEvent = Extract<Event, { eventType: 'lock_acquired' }>;
export type LockReleaseEvent = Extract<Event, { eventType: 'lock_release' }>;
export type LockHistoryEvent =
  | LockCreatedEvent
  | LockAcquiredEvent
  | LockReleaseEvent;

export type LockHistory =
  | {
      type: 'created';
      created: LockCreatedEvent;
      acquired?: LockAcquiredEvent;
      released?: LockReleaseEvent;
    }
  | {
      type: 'acquired';
      created?: LockCreatedEvent;
      acquired: LockAcquiredEvent;
      released?: LockReleaseEvent;
    }
  | {
      type: 'released';
      created?: LockCreatedEvent;
      acquired?: LockAcquiredEvent;
      released: LockReleaseEvent;
    }
  | {
      type: 'empty';
      created?: undefined;
      acquired?: undefined;
      released?: undefined;
    };

export type LockEventRequest = Extract<
  CreateEventRequest,
  { eventType: 'lock_created' | 'lock_acquired' | 'lock_release' }
>;

export type PreparedLockEvent =
  | {
      type: 'invalid';
      message: string;
    }
  | {
      type: 'return_existing';
      event: LockHistoryEvent;
    }
  | {
      type: 'too_early';
      retryAfterMs: number | undefined;
    }
  | {
      type: 'store';
      event: LockHistoryEvent;
    };

export type LockEventResolution =
  | {
      type: 'return_existing';
      event: LockHistoryEvent;
    }
  | {
      type: 'acquire_from_created';
      request: LimitAcquireRequest;
      createdEventData: LockCreatedEvent['eventData'];
    }
  | {
      type: 'acquire_after_wait';
      request: LimitAcquireRequest;
    }
  | {
      type: 'release';
      lease: LimitLease;
      request: LimitReleaseRequest;
    };

function isLeaseLive(lease: LimitLease, now: number): boolean {
  return lease.expiresAt === undefined || lease.expiresAt.getTime() > now;
}

function getLockIndex(correlationId: string): number {
  const parsed = parseLockCorrelationId(correlationId);
  if (!parsed) {
    throw new Error(`Invalid lock correlation ID "${correlationId}"`);
  }

  return parsed.lockIndex;
}

function createAcquireRequest(
  runId: string,
  correlationId: string,
  eventData: LockCreatedEvent['eventData']
): LimitAcquireRequest {
  return {
    key: eventData.key,
    runId,
    lockIndex: getLockIndex(correlationId),
    definition: eventData.definition,
    leaseTtlMs: eventData.leaseTtlMs,
  };
}

export function parseLockHistoryEvent(event: unknown): LockHistoryEvent {
  const parsed = EventSchema.parse(event);

  switch (parsed.eventType) {
    case 'lock_created':
    case 'lock_acquired':
    case 'lock_release':
      return parsed;
    default:
      throw new Error(`Expected lock event, got "${parsed.eventType}"`);
  }
}

export function getLockHistory(
  events: readonly LockHistoryEvent[]
): LockHistory {
  let created: LockCreatedEvent | undefined;
  let acquired: LockAcquiredEvent | undefined;
  let released: LockReleaseEvent | undefined;

  for (const event of events) {
    switch (event.eventType) {
      case 'lock_created':
        created ??= event;
        break;
      case 'lock_acquired':
        acquired = event;
        break;
      case 'lock_release':
        released = event;
        break;
    }
  }

  if (released) {
    return { type: 'released', created, acquired, released };
  }
  if (acquired) {
    return { type: 'acquired', created, acquired };
  }
  if (created) {
    return { type: 'created', created };
  }

  return { type: 'empty' };
}

export function getLiveAcquiredEvent(
  history: LockHistory,
  now = Date.now()
): LockAcquiredEvent | undefined {
  if (history.type !== 'acquired' && history.type !== 'released') {
    return undefined;
  }

  const acquired = history.acquired;
  if (!acquired) {
    return undefined;
  }

  return isLeaseLive(acquired.eventData.lease, now) ? acquired : undefined;
}

export function resolveLockEvent(
  event: LockEventRequest,
  runId: string,
  history: LockHistory
): LockEventResolution {
  switch (event.eventType) {
    case 'lock_created': {
      const existing =
        history.type === 'released'
          ? history.released
          : (getLiveAcquiredEvent(history) ?? history.created);
      if (existing) {
        return { type: 'return_existing', event: existing };
      }

      return {
        type: 'acquire_from_created',
        request: createAcquireRequest(
          runId,
          event.correlationId,
          event.eventData
        ),
        createdEventData: event.eventData,
      };
    }

    case 'lock_acquired': {
      if (history.type === 'released') {
        return { type: 'return_existing', event: history.released };
      }

      const acquired = getLiveAcquiredEvent(history);
      if (acquired) {
        return { type: 'return_existing', event: acquired };
      }

      if (!history.created) {
        throw new Error(
          `Lock "${event.correlationId}" cannot be acquired before lock_created`
        );
      }

      return {
        type: 'acquire_after_wait',
        request: createAcquireRequest(
          runId,
          event.correlationId,
          history.created.eventData
        ),
      };
    }

    case 'lock_release': {
      if (history.type === 'released') {
        return { type: 'return_existing', event: history.released };
      }
      if (!history.acquired) {
        throw new Error(
          `Lock "${event.correlationId}" cannot be released before lock_acquired`
        );
      }

      const lease = history.acquired.eventData.lease;
      return {
        type: 'release',
        lease,
        request: {
          leaseId: lease.leaseId,
          key: lease.key,
          lockId: lease.lockId,
        },
      };
    }
  }
}

export async function prepareLockEvent(input: {
  event: LockEventRequest;
  runId: string;
  eventId: string;
  specVersion: number;
  limits: Limits;
  existingEvents: readonly unknown[];
  createdAt?: Date;
}): Promise<PreparedLockEvent> {
  const history = getLockHistory(
    input.existingEvents.map(parseLockHistoryEvent)
  );
  let resolution: LockEventResolution;

  try {
    resolution = resolveLockEvent(input.event, input.runId, history);
  } catch (error) {
    return {
      type: 'invalid',
      message: (error as Error).message,
    };
  }

  if (resolution.type === 'return_existing') {
    return resolution;
  }

  if (resolution.type === 'release') {
    const releaseResult = await input.limits.release(resolution.request);
    return {
      type: 'store',
      event: parseLockHistoryEvent({
        eventType: 'lock_release',
        correlationId: input.event.correlationId,
        eventData: {
          lease: resolution.lease,
          promotedWaiters: releaseResult.promotedWaiters,
        },
        runId: input.runId,
        eventId: input.eventId,
        createdAt: input.createdAt ?? new Date(),
        specVersion: input.specVersion,
      }),
    };
  }

  const acquireResult = await input.limits.acquire(resolution.request);
  if (
    resolution.type === 'acquire_after_wait' &&
    acquireResult.status !== 'acquired'
  ) {
    return {
      type: 'too_early',
      retryAfterMs: acquireResult.retryAfterMs,
    };
  }

  const createdAt = input.createdAt ?? new Date();
  if (acquireResult.status === 'blocked') {
    if (resolution.type !== 'acquire_from_created') {
      return {
        type: 'invalid',
        message: `Lock "${input.event.correlationId}" is not ready to acquire`,
      };
    }

    return {
      type: 'store',
      event: parseLockHistoryEvent({
        eventType: 'lock_created',
        correlationId: input.event.correlationId,
        eventData: {
          ...resolution.createdEventData,
          acquireAt:
            acquireResult.retryAfterMs === undefined
              ? undefined
              : new Date(createdAt.getTime() + acquireResult.retryAfterMs),
        },
        runId: input.runId,
        eventId: input.eventId,
        createdAt,
        specVersion: input.specVersion,
      }),
    };
  }

  return {
    type: 'store',
    event: parseLockHistoryEvent({
      eventType: 'lock_acquired',
      correlationId: input.event.correlationId,
      eventData: { lease: acquireResult.lease },
      runId: input.runId,
      eventId: input.eventId,
      createdAt,
      specVersion: input.specVersion,
    }),
  };
}

export async function processPromotedWaiters(input: {
  promotedWaiters: LimitPromotedWaiter[];
  limits: Limits;
  queueWaiter?: (waiter: LimitPromotedWaiter) => Promise<boolean>;
}): Promise<void> {
  const pending = [...input.promotedWaiters];

  while (pending.length > 0) {
    const promotedWaiter = pending.shift();
    if (!promotedWaiter) {
      continue;
    }

    if (input.queueWaiter && (await input.queueWaiter(promotedWaiter))) {
      continue;
    }

    const releaseResult = await input.limits.release({
      leaseId: promotedWaiter.leaseId,
      key: promotedWaiter.key,
      lockId: promotedWaiter.lockId,
    });
    pending.push(...releaseResult.promotedWaiters);
  }
}

export async function wakePromotedWaiters(input: {
  promotedWaiters: LimitPromotedWaiter[];
  limits: Limits;
  runs?: Pick<
    {
      get(
        runId: string,
        params: { resolveData: 'none' }
      ): Promise<WorkflowRunWithoutData>;
    },
    'get'
  >;
  queue?: Pick<Queue, 'queue'>;
}): Promise<void> {
  await processPromotedWaiters({
    promotedWaiters: input.promotedWaiters,
    limits: input.limits,
    queueWaiter: async (waiter) => {
      if (!input.runs || !input.queue) {
        return false;
      }

      try {
        const run = await input.runs.get(waiter.runId, {
          resolveData: 'none',
        });
        if (['completed', 'failed', 'cancelled'].includes(run.status)) {
          return false;
        }

        await input.queue.queue(
          `__wkf_workflow_${run.workflowName}`,
          {
            runId: waiter.runId,
            lockPreApproval: waiter.lockCorrelationId,
            requestedAt: new Date(),
          },
          {
            idempotencyKey: waiter.wakeCorrelationId,
          }
        );
        return true;
      } catch {
        return false;
      }
    },
  });
}
