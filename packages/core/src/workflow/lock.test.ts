import { TooEarlyError, WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event, EventResult, LimitLease } from '@workflow/world';
import {
  createLockCorrelationId,
  createLockWakeCorrelationId,
} from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from '../events-consumer.js';
import { WorkflowSuspension } from '../global.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { setWorld } from '../runtime/world.js';
import { createContext } from '../vm/index.js';
import { createLock } from './lock.js';
import { createSleep } from './sleep.js';

function createLease(): LimitLease {
  return {
    leaseId: 'lmt_lease',
    key: 'workflow:user:test',
    lockId: 'wrun_test:0',
    runId: 'wrun_test',
    lockIndex: 0,
    acquiredAt: new Date('2025-01-01T00:00:00.000Z'),
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    definition: {
      concurrency: { max: 1 },
    },
  };
}

function setupWorkflowContext(
  events: Event[],
  options?: { onUnconsumedEvent?: (event: Event) => void }
): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  const workflowContext: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    lockPreApproval: undefined,
    encryptionKey: undefined,
    globalThis: context.globalThis,
    advanceTimestamp: vi.fn(),
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: options?.onUnconsumedEvent ?? (() => {}),
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    nextLockIndex: 0,
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    pendingDeliveries: 0,
  };
  Object.defineProperty(workflowContext, 'promiseQueue', {
    get() {
      return promiseQueueHolder.current;
    },
    set(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
    enumerable: true,
    configurable: true,
  });
  workflowContext.promiseQueue = Promise.resolve();
  return workflowContext;
}

function asEventResult(event: Event): EventResult {
  return { event };
}

afterEach(() => {
  setWorld(undefined as any);
  vi.restoreAllMocks();
});

describe('createLock', () => {
  it('creates and immediately acquires a fresh lock via world events', async () => {
    const lease = createLease();
    const createEvent = vi
      .fn<() => Promise<EventResult>>()
      .mockResolvedValueOnce(
        asEventResult({
          eventId: 'evnt_lock_acquired',
          runId: 'wrun_test',
          eventType: 'lock_acquired',
          correlationId: createLockCorrelationId('wrun_test', 0),
          eventData: { lease },
          createdAt: new Date(),
        })
      )
      .mockResolvedValueOnce(
        asEventResult({
          eventId: 'evnt_lock_release',
          runId: 'wrun_test',
          eventType: 'lock_release',
          correlationId: createLockCorrelationId('wrun_test', 0),
          eventData: {
            leaseId: lease.leaseId,
            key: lease.key,
            lockId: lease.lockId,
          },
          createdAt: new Date(),
        })
      );
    const heartbeat = vi.fn().mockResolvedValue(lease);

    setWorld({
      events: { create: createEvent },
      limits: { heartbeat },
    } as any);

    const ctx = setupWorkflowContext([]);
    const lock = createLock(ctx);
    const handle = await lock({
      key: lease.key,
      concurrency: { max: 1 },
    });

    expect(createEvent).toHaveBeenNthCalledWith(
      1,
      'wrun_test',
      expect.objectContaining({
        eventType: 'lock_created',
        correlationId: createLockCorrelationId('wrun_test', 0),
      })
    );
    expect(handle.leaseId).toBe(lease.leaseId);

    await handle.dispose();

    expect(createEvent).toHaveBeenNthCalledWith(
      2,
      'wrun_test',
      expect.objectContaining({
        eventType: 'lock_release',
        correlationId: createLockCorrelationId('wrun_test', 0),
      })
    );
  });

  it('replays a rate-only lock from lock_acquired without creating new events', async () => {
    const lease = {
      ...createLease(),
      key: 'workflow:rate:test',
      definition: {
        rate: { count: 1, periodMs: 60_000 },
      },
    };
    const createEvent = vi.fn();
    const heartbeat = vi.fn().mockResolvedValue(lease);

    setWorld({
      events: { create: createEvent },
      limits: { heartbeat },
    } as any);

    const correlationId = createLockCorrelationId('wrun_test', 0);
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_lock_acquired',
        runId: 'wrun_test',
        eventType: 'lock_acquired',
        correlationId,
        eventData: { lease },
        createdAt: new Date(),
      },
    ]);

    const lock = createLock(ctx);
    const handle = await lock({
      key: lease.key,
      rate: { count: 1, periodMs: 60_000 },
    });

    expect(createEvent).not.toHaveBeenCalled();
    expect(handle.leaseId).toBe(lease.leaseId);
  });

  it('ignores an expired lock_acquired event and reacquires the lease', async () => {
    const expiredLease = {
      ...createLease(),
      expiresAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const freshLease = {
      ...createLease(),
      leaseId: 'lmt_fresh',
      expiresAt: new Date('2027-06-01T00:00:00.000Z'),
    };
    const createEvent = vi
      .fn<() => Promise<EventResult>>()
      .mockResolvedValueOnce(
        asEventResult({
          eventId: 'evnt_lock_acquired_fresh',
          runId: 'wrun_test',
          eventType: 'lock_acquired',
          correlationId: createLockCorrelationId('wrun_test', 0),
          eventData: { lease: freshLease },
          createdAt: new Date(),
        })
      );

    setWorld({
      events: { create: createEvent },
      limits: { heartbeat: vi.fn() },
    } as any);

    const correlationId = createLockCorrelationId('wrun_test', 0);
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_lock_created',
        runId: 'wrun_test',
        eventType: 'lock_created',
        correlationId,
        eventData: {
          key: expiredLease.key,
          definition: expiredLease.definition,
          leaseTtlMs: 1_000,
        },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_lock_acquired_expired',
        runId: 'wrun_test',
        eventType: 'lock_acquired',
        correlationId,
        eventData: { lease: expiredLease },
        createdAt: new Date(),
      },
    ]);

    const lock = createLock(ctx);
    const handle = await lock({
      key: expiredLease.key,
      concurrency: { max: 1 },
    });

    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith(
      'wrun_test',
      expect.objectContaining({
        eventType: 'lock_acquired',
        correlationId,
      })
    );
    expect(handle.leaseId).toBe(freshLease.leaseId);
  });

  it('replays a released scope as a no-op without double-releasing', async () => {
    const lease = createLease();
    const createEvent = vi.fn();
    const heartbeat = vi.fn().mockResolvedValue(lease);

    setWorld({
      events: { create: createEvent },
      limits: { heartbeat },
    } as any);

    const correlationId = createLockCorrelationId('wrun_test', 0);
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_lock_acquired',
        runId: 'wrun_test',
        eventType: 'lock_acquired',
        correlationId,
        eventData: { lease },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_lock_release',
        runId: 'wrun_test',
        eventType: 'lock_release',
        correlationId,
        eventData: {
          leaseId: lease.leaseId,
          key: lease.key,
          lockId: lease.lockId,
        },
        createdAt: new Date(),
      },
    ]);

    const lock = createLock(ctx);
    const handle = await lock({
      key: lease.key,
      concurrency: { max: 1 },
    });

    await handle.dispose();

    expect(createEvent).not.toHaveBeenCalled();
  });

  it('re-suspends when a stale lock wake-up becomes too early again', async () => {
    const workflowNow = 1753481739458;
    const retryAfterSeconds = 30;
    const retryAfter = new Date(workflowNow + retryAfterSeconds * 1000);
    const createEvent = vi
      .fn<() => Promise<EventResult>>()
      .mockRejectedValueOnce(
        new TooEarlyError('not ready yet', { retryAfter: retryAfterSeconds })
      );

    setWorld({
      events: { create: createEvent },
      limits: { heartbeat: vi.fn() },
    } as any);
    vi.spyOn(Date, 'now').mockReturnValue(workflowNow);

    const correlationId = createLockCorrelationId('wrun_test', 0);
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_lock_created',
        runId: 'wrun_test',
        eventType: 'lock_created',
        correlationId,
        eventData: {
          key: 'workflow:rate:test',
          definition: { rate: { count: 1, periodMs: 60_000 } },
          acquireAt: new Date(workflowNow - 1_000),
        },
        createdAt: new Date(),
      },
    ]);
    const errorReceived = withResolvers<Error>();
    ctx.onWorkflowError = errorReceived.resolve;

    const lock = createLock(ctx);
    void lock({
      key: 'workflow:rate:test',
      rate: { count: 1, periodMs: 60_000 },
    });

    const workflowError = await errorReceived.promise;
    expect(workflowError).toBeInstanceOf(WorkflowSuspension);
    expect(createEvent).toHaveBeenCalledTimes(1);
    const waitItem = ctx.invocationsQueue.get(
      createLockWakeCorrelationId('wrun_test', 0)
    );
    expect(waitItem).toMatchObject({
      type: 'limit_wait',
      correlationId: createLockWakeCorrelationId('wrun_test', 0),
      resumeAt: retryAfter,
    });
  });

  it('retries a timed lock when wall time has passed even if replay time has not', async () => {
    const workflowNow = 1753481739458;
    const acquireAt = new Date(workflowNow + 1_000);
    const lease = {
      ...createLease(),
      key: 'workflow:rate:test',
      definition: { rate: { count: 1, periodMs: 60_000 } },
    };
    const createEvent = vi
      .fn<() => Promise<EventResult>>()
      .mockResolvedValueOnce(
        asEventResult({
          eventId: 'evnt_lock_acquired',
          runId: 'wrun_test',
          eventType: 'lock_acquired',
          correlationId: createLockCorrelationId('wrun_test', 0),
          eventData: { lease },
          createdAt: new Date(workflowNow + 2_000),
        })
      );

    vi.spyOn(Date, 'now').mockReturnValue(workflowNow + 2_000);
    setWorld({
      events: { create: createEvent },
      limits: { heartbeat: vi.fn() },
    } as any);

    const correlationId = createLockCorrelationId('wrun_test', 0);
    const ctx = setupWorkflowContext([
      {
        eventId: 'evnt_lock_created',
        runId: 'wrun_test',
        eventType: 'lock_created',
        correlationId,
        eventData: {
          key: lease.key,
          definition: lease.definition,
          acquireAt,
        },
        createdAt: new Date(workflowNow),
      },
    ]);

    const lock = createLock(ctx);
    const handle = await lock({
      key: lease.key,
      rate: { count: 1, periodMs: 60_000 },
    });

    expect(createEvent).toHaveBeenCalledWith(
      'wrun_test',
      expect.objectContaining({
        eventType: 'lock_acquired',
        correlationId,
      })
    );
    expect(handle.leaseId).toBe(lease.leaseId);
  });

  it('does not orphan wait_created when a replayed lock is immediately followed by sleep', async () => {
    const lease = createLease();
    const createEvent = vi.fn();
    const tempCtx = setupWorkflowContext([]);
    const waitCorrelationId = `wait_${tempCtx.generateUlid()}`;
    const onUnconsumedEvent = vi.fn();

    setWorld({
      events: { create: createEvent },
      limits: { heartbeat: vi.fn() },
    } as any);

    const correlationId = createLockCorrelationId('wrun_test', 0);
    const ctx = setupWorkflowContext(
      [
        {
          eventId: 'evnt_lock_acquired',
          runId: 'wrun_test',
          eventType: 'lock_acquired',
          correlationId,
          eventData: { lease },
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
        {
          eventId: 'evnt_wait_created',
          runId: 'wrun_test',
          eventType: 'wait_created',
          correlationId: waitCorrelationId,
          eventData: {
            resumeAt: new Date('2025-01-01T00:00:01.000Z'),
          },
          createdAt: new Date('2025-01-01T00:00:00.010Z'),
        },
        {
          eventId: 'evnt_wait_completed',
          runId: 'wrun_test',
          eventType: 'wait_completed',
          correlationId: waitCorrelationId,
          createdAt: new Date('2025-01-01T00:00:01.000Z'),
        },
      ],
      { onUnconsumedEvent }
    );
    const lock = createLock(ctx);
    const sleep = createSleep(ctx);

    await lock({
      key: lease.key,
      concurrency: { max: 1 },
    });
    await sleep(1_000);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(createEvent).not.toHaveBeenCalled();
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
    expect(ctx.onWorkflowError).not.toHaveBeenCalled();
  });

  it('rejects heartbeat in workflow scope to preserve replay determinism', async () => {
    const lease = createLease();
    const createEvent = vi
      .fn<() => Promise<EventResult>>()
      .mockResolvedValueOnce(
        asEventResult({
          eventId: 'evnt_lock_acquired',
          runId: 'wrun_test',
          eventType: 'lock_acquired',
          correlationId: createLockCorrelationId('wrun_test', 0),
          eventData: { lease },
          createdAt: new Date(),
        })
      );
    const heartbeat = vi.fn().mockResolvedValue(lease);

    setWorld({
      events: { create: createEvent },
      limits: { heartbeat },
    } as any);

    const ctx = setupWorkflowContext([]);
    const lock = createLock(ctx);
    const handle = await lock({
      key: lease.key,
      concurrency: { max: 1 },
    });

    await expect(handle.heartbeat()).rejects.toBeInstanceOf(
      WorkflowRuntimeError
    );
    await expect(handle.heartbeat()).rejects.toThrow(
      'Lock heartbeat is not supported in workflow functions yet'
    );
    expect(heartbeat).not.toHaveBeenCalled();
  });
});
