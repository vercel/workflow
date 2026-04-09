import { type CreateEventRequest, EventSchema, type Event } from './events.js';
import {
  type LimitAcquireRequest,
  type LimitLease,
  type LimitPromotedWaiter,
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

type LockEventRequest = Extract<
  CreateEventRequest,
  { eventType: 'lock_created' | 'lock_acquired' | 'lock_release' }
>;

type LockHistory = {
  created?: LockCreatedEvent;
  acquired?: LockAcquiredEvent;
  released?: LockReleaseEvent;
};

type PreparedLockEvent =
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

function parseLockHistoryEvent(event: unknown): LockHistoryEvent {
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

function getLockHistory(events: readonly LockHistoryEvent[]): LockHistory {
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

  return {
    created,
    acquired,
    released,
  };
}

function getLiveAcquiredEvent(
  history: LockHistory,
  now = Date.now()
): LockAcquiredEvent | undefined {
  const acquired = history.acquired;
  if (!acquired) {
    return undefined;
  }

  return isLeaseLive(acquired.eventData.lease, now) ? acquired : undefined;
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
  const existingAcquired = getLiveAcquiredEvent(history);
  const createdAt = input.createdAt ?? new Date();

  switch (input.event.eventType) {
    case 'lock_created': {
      const existing = history.released ?? existingAcquired ?? history.created;
      if (existing) {
        return {
          type: 'return_existing',
          event: existing,
        };
      }

      const acquireResult = await input.limits.acquire(
        createAcquireRequest(
          input.runId,
          input.event.correlationId,
          input.event.eventData
        )
      );
      if (acquireResult.status === 'blocked') {
        return {
          type: 'store',
          event: parseLockHistoryEvent({
            eventType: 'lock_created',
            correlationId: input.event.correlationId,
            eventData: {
              ...input.event.eventData,
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

    case 'lock_acquired': {
      if (history.released) {
        return {
          type: 'return_existing',
          event: history.released,
        };
      }
      if (existingAcquired) {
        return {
          type: 'return_existing',
          event: existingAcquired,
        };
      }
      if (!history.created) {
        return {
          type: 'invalid',
          message: `Lock "${input.event.correlationId}" cannot be acquired before lock_created`,
        };
      }

      const acquireResult = await input.limits.acquire(
        createAcquireRequest(
          input.runId,
          input.event.correlationId,
          history.created.eventData
        )
      );
      if (acquireResult.status !== 'acquired') {
        return {
          type: 'too_early',
          retryAfterMs: acquireResult.retryAfterMs,
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

    case 'lock_release': {
      if (history.released) {
        return {
          type: 'return_existing',
          event: history.released,
        };
      }
      if (!history.acquired) {
        return {
          type: 'invalid',
          message: `Lock "${input.event.correlationId}" cannot be released before lock_acquired`,
        };
      }

      const lease = history.acquired.eventData.lease;
      const releaseResult = await input.limits.release({
        leaseId: lease.leaseId,
        key: lease.key,
        lockId: lease.lockId,
      });
      return {
        type: 'store',
        event: parseLockHistoryEvent({
          eventType: 'lock_release',
          correlationId: input.event.correlationId,
          eventData: {
            lease,
            promotedWaiters: releaseResult.promotedWaiters,
          },
          runId: input.runId,
          eventId: input.eventId,
          createdAt,
          specVersion: input.specVersion,
        }),
      };
    }
  }
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
