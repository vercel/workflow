import { createLockCorrelationId } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';

type LockOwner = {
  runId: string;
  lockIndex: number;
};

type EventsHarness = {
  queue: {
    queue: ReturnType<typeof vi.fn>;
  };
  prepareQueueFailure?(): void;
  createOwner(workflowName: string): Promise<LockOwner>;
  startRun(runId: string): Promise<void>;
  completeRun(runId: string): Promise<void>;
  createLock(
    runId: string,
    correlationId: string,
    key: string,
    leaseTtlMs: number,
    concurrencyMax: number
  ): Promise<{
    event?: {
      eventType: string;
      eventData?: {
        promotedWaiters?: unknown[];
      };
    };
  }>;
  releaseLock(
    runId: string,
    correlationId: string
  ): Promise<{
    event?: {
      eventType: string;
      eventData?: {
        promotedWaiters?: unknown[];
      };
    };
  }>;
  listEvents(correlationId: string): Promise<
    {
      eventType: string;
    }[]
  >;
};

function hasQueuedEvent(events: { eventType: string }[]) {
  return events.some((event) => event.eventType === 'lock_waiter_queued');
}

const EVENT_TEST_LEASE_TTL_MS = 30_000;

export function createLimitsEventsContractSuite(
  name: string,
  createHarness: () => Promise<EventsHarness>
) {
  describe(name, () => {
    it('persists promotedWaiters metadata and emits lock_waiter_queued for every promoted waiter', async () => {
      const harness = await createHarness();
      const ownerA = await harness.createOwner('holder-a');
      const ownerB = await harness.createOwner('holder-b');
      const ownerC = await harness.createOwner('holder-c');
      const ownerD = await harness.createOwner('holder-d');
      const correlationA = createLockCorrelationId(
        ownerA.runId,
        ownerA.lockIndex
      );
      const correlationB = createLockCorrelationId(
        ownerB.runId,
        ownerB.lockIndex
      );
      const correlationC = createLockCorrelationId(
        ownerC.runId,
        ownerC.lockIndex
      );
      const correlationD = createLockCorrelationId(
        ownerD.runId,
        ownerD.lockIndex
      );

      for (const owner of [ownerA, ownerB, ownerC, ownerD]) {
        await harness.startRun(owner.runId);
      }

      const first = await harness.createLock(
        ownerA.runId,
        correlationA,
        'workflow:user:test',
        EVENT_TEST_LEASE_TTL_MS,
        2
      );
      const second = await harness.createLock(
        ownerB.runId,
        correlationB,
        'workflow:user:test',
        EVENT_TEST_LEASE_TTL_MS,
        2
      );
      const third = await harness.createLock(
        ownerC.runId,
        correlationC,
        'workflow:user:test',
        EVENT_TEST_LEASE_TTL_MS,
        2
      );
      const fourth = await harness.createLock(
        ownerD.runId,
        correlationD,
        'workflow:user:test',
        EVENT_TEST_LEASE_TTL_MS,
        2
      );

      expect(first.event?.eventType).toBe('lock_acquired');
      expect(second.event?.eventType).toBe('lock_acquired');
      expect(third.event?.eventType).toBe('lock_created');
      expect(fourth.event?.eventType).toBe('lock_created');

      await harness.completeRun(ownerB.runId);

      const released = await harness.releaseLock(ownerA.runId, correlationA);
      expect(released.event?.eventType).toBe('lock_release');
      expect(released.event?.eventData?.promotedWaiters).toEqual([
        expect.objectContaining({
          runId: ownerC.runId,
          lockIndex: ownerC.lockIndex,
          lockCorrelationId: correlationC,
        }),
        expect.objectContaining({
          runId: ownerD.runId,
          lockIndex: ownerD.lockIndex,
          lockCorrelationId: correlationD,
        }),
      ]);
      expect(harness.queue.queue).toHaveBeenCalledTimes(2);

      for (const correlationId of [correlationC, correlationD]) {
        expect(hasQueuedEvent(await harness.listEvents(correlationId))).toBe(
          true
        );
      }
    });

    it('compensates skipped or failed waiter wake-ups and recursively queues the next waiter', async () => {
      const harness = await createHarness();
      const holder = await harness.createOwner('holder-a');
      const terminalWaiter = await harness.createOwner('holder-b');
      const liveWaiter = await harness.createOwner('holder-c');
      const holderCorrelation = createLockCorrelationId(
        holder.runId,
        holder.lockIndex
      );
      const terminalCorrelation = createLockCorrelationId(
        terminalWaiter.runId,
        terminalWaiter.lockIndex
      );
      const liveCorrelation = createLockCorrelationId(
        liveWaiter.runId,
        liveWaiter.lockIndex
      );

      for (const owner of [holder, terminalWaiter, liveWaiter]) {
        await harness.startRun(owner.runId);
      }

      await harness.createLock(
        holder.runId,
        holderCorrelation,
        'workflow:user:terminal-promoted',
        EVENT_TEST_LEASE_TTL_MS,
        1
      );
      await harness.createLock(
        terminalWaiter.runId,
        terminalCorrelation,
        'workflow:user:terminal-promoted',
        EVENT_TEST_LEASE_TTL_MS,
        1
      );
      await harness.createLock(
        liveWaiter.runId,
        liveCorrelation,
        'workflow:user:terminal-promoted',
        EVENT_TEST_LEASE_TTL_MS,
        1
      );

      await harness.completeRun(terminalWaiter.runId);
      await harness.releaseLock(holder.runId, holderCorrelation);

      expect(harness.queue.queue).toHaveBeenCalledTimes(1);
      expect(harness.queue.queue.mock.calls[0]?.[1]).toMatchObject({
        runId: liveWaiter.runId,
        lockPreApproval: liveCorrelation,
      });
      expect(
        hasQueuedEvent(await harness.listEvents(terminalCorrelation))
      ).toBe(false);
      expect(hasQueuedEvent(await harness.listEvents(liveCorrelation))).toBe(
        true
      );

      const failedHolder = await harness.createOwner('holder-d');
      const failedFirstWaiter = await harness.createOwner('holder-e');
      const failedSecondWaiter = await harness.createOwner('holder-f');
      harness.prepareQueueFailure?.();
      const failedHolderCorrelation = createLockCorrelationId(
        failedHolder.runId,
        failedHolder.lockIndex
      );
      const failedFirstCorrelation = createLockCorrelationId(
        failedFirstWaiter.runId,
        failedFirstWaiter.lockIndex
      );
      const failedSecondCorrelation = createLockCorrelationId(
        failedSecondWaiter.runId,
        failedSecondWaiter.lockIndex
      );

      for (const owner of [
        failedHolder,
        failedFirstWaiter,
        failedSecondWaiter,
      ]) {
        await harness.startRun(owner.runId);
      }

      await harness.createLock(
        failedHolder.runId,
        failedHolderCorrelation,
        'workflow:user:queue-failure',
        EVENT_TEST_LEASE_TTL_MS,
        1
      );
      await harness.createLock(
        failedFirstWaiter.runId,
        failedFirstCorrelation,
        'workflow:user:queue-failure',
        EVENT_TEST_LEASE_TTL_MS,
        1
      );
      await harness.createLock(
        failedSecondWaiter.runId,
        failedSecondCorrelation,
        'workflow:user:queue-failure',
        EVENT_TEST_LEASE_TTL_MS,
        1
      );

      await harness.releaseLock(failedHolder.runId, failedHolderCorrelation);

      expect(harness.queue.queue).toHaveBeenCalledTimes(3);
      expect(harness.queue.queue.mock.calls[1]?.[1]).toMatchObject({
        runId: failedFirstWaiter.runId,
        lockPreApproval: failedFirstCorrelation,
      });
      expect(harness.queue.queue.mock.calls[2]?.[1]).toMatchObject({
        runId: failedSecondWaiter.runId,
        lockPreApproval: failedSecondCorrelation,
      });
      expect(
        hasQueuedEvent(await harness.listEvents(failedFirstCorrelation))
      ).toBe(false);
      expect(
        hasQueuedEvent(await harness.listEvents(failedSecondCorrelation))
      ).toBe(true);
    });
  });
}
