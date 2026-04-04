import type { CreateEventRequest, Event } from './events.js';
import {
  type LimitAcquireRequest,
  type LimitLease,
  type LimitReleaseRequest,
  parseLockCorrelationId,
} from './limits.js';

export type LockCreatedEvent = Extract<Event, { eventType: 'lock_created' }>;
export type LockAcquiredEvent = Extract<Event, { eventType: 'lock_acquired' }>;
export type LockReleaseEvent = Extract<Event, { eventType: 'lock_release' }>;
export type LockWaiterQueuedEvent = Extract<
  Event,
  { eventType: 'lock_waiter_queued' }
>;
export type LockStoredEvent =
  | LockCreatedEvent
  | LockAcquiredEvent
  | LockReleaseEvent;
export type LockHistoryEvent = LockStoredEvent | LockWaiterQueuedEvent;

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

type LockEventRequest = Extract<
  CreateEventRequest,
  { eventType: 'lock_created' | 'lock_acquired' | 'lock_release' }
>;

export type LockEventResolution =
  | {
      type: 'return_existing';
      event: LockStoredEvent;
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

function isLeaseLive(
  lease: Pick<LimitLease, 'expiresAt'>,
  now: number
): boolean {
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
      case 'lock_waiter_queued':
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
