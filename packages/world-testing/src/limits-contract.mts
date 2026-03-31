import { setTimeout as sleep } from 'node:timers/promises';
import {
  SPEC_VERSION_CURRENT,
  type LimitDefinition,
  type LimitLease,
  type Limits,
  type Storage,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';

export interface LimitsHarness {
  limits: Limits;
  storage?: Pick<Storage, 'events'>;
  inspectKeyState: (key: string) => Promise<{
    leaseHolderIds: string[];
    waiterHolderIds: string[];
    tokenHolderIds: string[];
  }>;
  close?: () => Promise<void>;
}

interface LockOwner {
  lockId: string;
  runId: string;
  lockIndex: number;
}

function createTestLockId(runId: string, lockIndex: number) {
  return `${runId}:${lockIndex}`;
}

async function createRun(
  storage: Pick<Storage, 'events'>,
  workflowName: string
) {
  const result = await storage.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'deployment-123',
      workflowName,
      input: [],
    },
  });
  if (!result.run) {
    throw new Error('expected run');
  }
  return result.run;
}

function requireEventsStorage(
  storage: LimitsHarness['storage']
): Pick<Storage, 'events'> {
  if (!storage) {
    throw new Error('storage.events is required for limits tests');
  }
  return storage;
}

async function createLockOwner(
  storage: LimitsHarness['storage'],
  workflowName: string,
  lockIndex = 0
): Promise<LockOwner> {
  const run = await createRun(requireEventsStorage(storage), workflowName);
  return {
    lockId: createTestLockId(run.runId, lockIndex),
    runId: run.runId,
    lockIndex,
  };
}

function acquireRequest(
  owner: LockOwner,
  key: string,
  definition: LimitDefinition,
  leaseTtlMs?: number
) {
  return {
    key,
    runId: owner.runId,
    lockIndex: owner.lockIndex,
    definition,
    ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
  };
}

function releaseRequest(lease: LimitLease) {
  return {
    leaseId: lease.leaseId,
    key: lease.key,
    lockId: lease.lockId,
  };
}

export function createLimitsContractSuite(
  name: string,
  createHarness: () => Promise<LimitsHarness>
) {
  describe(name, () => {
    it('throws a workflow world error when heartbeating a missing lease', async () => {
      const harness = await createHarness();
      try {
        await expect(
          harness.limits.heartbeat({
            leaseId: 'lmt_missing',
          })
        ).rejects.toMatchObject({
          name: 'WorkflowWorldError',
          message: expect.stringContaining('not found'),
        });
      } finally {
        await harness.close?.();
      }
    });

    it('enforces per-key concurrency limits', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'step:db:cheap',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'step:db:cheap',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(second).toMatchObject({
          status: 'blocked',
          reason: 'concurrency',
        });

        await harness.limits.release(releaseRequest(first.lease));

        const third = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'step:db:cheap',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(third.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('isolates unrelated keys at the raw limits layer', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const [first, second] = await Promise.all([
          harness.limits.acquire(
            acquireRequest(
              ownerA,
              'workflow:user:a',
              { concurrency: { max: 1 } },
              1_000
            )
          ),
          harness.limits.acquire(
            acquireRequest(
              ownerB,
              'workflow:user:b',
              { concurrency: { max: 1 } },
              1_000
            )
          ),
        ]);

        expect(first.status).toBe('acquired');
        expect(second.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('serializes concurrent acquires for the same key', async () => {
      const harness = await createHarness();
      try {
        const owners = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            createLockOwner(harness.storage, `holder-${index}`)
          )
        );
        const results = await Promise.all(
          owners.map((owner) =>
            harness.limits.acquire(
              acquireRequest(
                owner,
                'workflow:user:concurrent',
                { concurrency: { max: 1 } },
                1_000
              )
            )
          )
        );

        const acquired = results.filter(
          (result) => result.status === 'acquired'
        );
        const blocked = results.filter((result) => result.status === 'blocked');

        expect(acquired).toHaveLength(1);
        expect(blocked).toHaveLength(11);
      } finally {
        await harness.close?.();
      }
    });

    it('keeps rate capacity consumed until the window expires', async () => {
      const harness = await createHarness();
      try {
        const periodMs = 3_000;
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const ownerC = await createLockOwner(harness.storage, 'holder-c');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'step:provider:openai',
            { rate: { count: 1, periodMs } },
            5_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        await harness.limits.release(releaseRequest(first.lease));

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'step:provider:openai',
            { rate: { count: 1, periodMs } },
            5_000
          )
        );
        expect(second.status).toBe('blocked');
        if (second.status !== 'blocked') throw new Error('expected blocked');
        expect(second.reason).toBe('rate');
        expect(second.retryAfterMs).toBeGreaterThanOrEqual(0);

        let secondRetry = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'step:provider:openai',
            { rate: { count: 1, periodMs } },
            5_000
          )
        );
        const deadline = Date.now() + periodMs + 1_000;
        while (secondRetry.status === 'blocked' && Date.now() < deadline) {
          await sleep(Math.max(25, secondRetry.retryAfterMs ?? 0) + 50);
          secondRetry = await harness.limits.acquire(
            acquireRequest(
              ownerB,
              'step:provider:openai',
              { rate: { count: 1, periodMs } },
              1_000
            )
          );
        }

        expect(secondRetry.status).toBe('acquired');
        if (secondRetry.status !== 'acquired')
          throw new Error('expected acquisition');

        await harness.limits.release(releaseRequest(secondRetry.lease));

        let third = await harness.limits.acquire(
          acquireRequest(
            ownerC,
            'step:provider:openai',
            { rate: { count: 1, periodMs } },
            5_000
          )
        );
        const thirdDeadline = Date.now() + periodMs + 1_000;
        while (third.status === 'blocked' && Date.now() < thirdDeadline) {
          await sleep(Math.max(25, third.retryAfterMs ?? 0) + 50);
          third = await harness.limits.acquire(
            acquireRequest(
              ownerC,
              'step:provider:openai',
              { rate: { count: 1, periodMs } },
              1_000
            )
          );
        }
        expect(third.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('returns a combined blocked reason when both limits are saturated', async () => {
      const harness = await createHarness();
      try {
        const periodMs = 1_500;
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'step:mixed',
            {
              concurrency: { max: 1 },
              rate: { count: 1, periodMs },
            },
            5_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'step:mixed',
            {
              concurrency: { max: 1 },
              rate: { count: 1, periodMs },
            },
            5_000
          )
        );
        expect(second).toMatchObject({
          status: 'blocked',
          reason: 'concurrency_and_rate',
        });
        if (second.status !== 'blocked') throw new Error('expected blocked');

        await harness.limits.release(releaseRequest(first.lease));

        const third = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'step:mixed',
            {
              concurrency: { max: 1 },
              rate: { count: 1, periodMs },
            },
            1_000
          )
        );
        expect(third).toMatchObject({
          status: 'blocked',
          reason: 'rate',
        });

        let fourth = third;
        const deadline = Date.now() + periodMs + 1_000;
        while (fourth.status === 'blocked' && Date.now() < deadline) {
          await sleep(Math.max(25, fourth.retryAfterMs ?? 0) + 50);
          fourth = await harness.limits.acquire(
            acquireRequest(
              ownerB,
              'step:mixed',
              {
                concurrency: { max: 1 },
                rate: { count: 1, periodMs },
              },
              5_000
            )
          );
        }

        expect(fourth.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('restores capacity immediately when a lease is released', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'workflow:user:123',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'workflow:user:123',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(second.status).toBe('blocked');

        await harness.limits.release(releaseRequest(first.lease));

        const third = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'workflow:user:123',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(third.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('extends lease expiry when heartbeated', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'workflow:user:heartbeat',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const heartbeat = await harness.limits.heartbeat({
          leaseId: first.lease.leaseId,
          ttlMs: 5_000,
        });

        expect(heartbeat.expiresAt?.getTime()).toBeGreaterThan(
          first.lease.expiresAt?.getTime() ?? 0
        );

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'workflow:user:heartbeat',
            { concurrency: { max: 1 } },
            5_000
          )
        );
        expect(second.status).toBe('blocked');
      } finally {
        await harness.close?.();
      }
    });

    it('reclaims expired leases without manual cleanup', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'workflow:user:expired',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'workflow:user:expired',
            { concurrency: { max: 1 } },
            5_000
          )
        );
        expect(second.status).toBe('blocked');

        await sleep(1_500);

        const third = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'workflow:user:expired',
            { concurrency: { max: 1 } },
            5_000
          )
        );
        expect(third.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('reuses an existing lease for the same holder', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'workflow:user:reacquire',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'workflow:user:reacquire',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(second).toMatchObject({
          status: 'acquired',
          lease: {
            leaseId: first.lease.leaseId,
            lockId: first.lease.lockId,
          },
        });

        if (!harness.inspectKeyState) {
          throw new Error(
            'inspectKeyState is required for duplicate lease checks'
          );
        }
        const keyState = await harness.inspectKeyState(
          'workflow:user:reacquire'
        );
        expect(
          keyState.leaseHolderIds.filter((lockId) => lockId === ownerA.lockId)
        ).toHaveLength(1);
        expect(
          keyState.waiterHolderIds.filter((lockId) => lockId === ownerA.lockId)
        ).toHaveLength(0);
      } finally {
        await harness.close?.();
      }
    });

    it('promotes waiters in FIFO order per key', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const ownerC = await createLockOwner(harness.storage, 'holder-c');
        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'workflow:user:ordered',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'workflow:user:ordered',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        const third = await harness.limits.acquire(
          acquireRequest(
            ownerC,
            'workflow:user:ordered',
            { concurrency: { max: 1 } },
            1_000
          )
        );

        expect(second.status).toBe('blocked');
        expect(third.status).toBe('blocked');

        await harness.limits.release(releaseRequest(first.lease));

        const promoted = await harness.limits.acquire(
          acquireRequest(
            ownerB,
            'workflow:user:ordered',
            { concurrency: { max: 1 } },
            1_000
          )
        );
        const stillWaiting = await harness.limits.acquire(
          acquireRequest(
            ownerC,
            'workflow:user:ordered',
            { concurrency: { max: 1 } },
            1_000
          )
        );

        expect(promoted.status).toBe('acquired');
        expect(stillWaiting.status).toBe('blocked');
        if (promoted.status !== 'acquired')
          throw new Error('expected waiter-b promotion');

        await harness.limits.release(releaseRequest(promoted.lease));

        const thirdPromoted = await harness.limits.acquire(
          acquireRequest(
            ownerC,
            'workflow:user:ordered',
            { concurrency: { max: 1 } },
            1_000
          )
        );

        expect(thirdPromoted.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('skips cancelled workflow waiters before promotion', async () => {
      const harness = await createHarness();
      try {
        if (!harness.storage) {
          throw new Error('storage is required for workflow waiter liveness');
        }

        const deadRun = await createRun(harness.storage, 'dead-workflow');
        await harness.storage.events.create(deadRun.runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
        await harness.storage.events.create(deadRun.runId, {
          eventType: 'run_cancelled',
          specVersion: SPEC_VERSION_CURRENT,
        });

        const liveRun = await createRun(harness.storage, 'live-workflow');
        await harness.storage.events.create(liveRun.runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
        const liveOwner = {
          lockId: createTestLockId(liveRun.runId, 0),
          runId: liveRun.runId,
          lockIndex: 0,
        };
        const deadOwner = {
          lockId: createTestLockId(deadRun.runId, 0),
          runId: deadRun.runId,
          lockIndex: 0,
        };
        const ownerA = await createLockOwner(harness.storage, 'holder-a');

        const first = await harness.limits.acquire(
          acquireRequest(
            ownerA,
            'workflow:user:skip-dead-workflow',
            { concurrency: { max: 1 } },
            5_000
          )
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        await harness.limits.acquire(
          acquireRequest(
            deadOwner,
            'workflow:user:skip-dead-workflow',
            { concurrency: { max: 1 } },
            5_000
          )
        );
        await harness.limits.acquire(
          acquireRequest(
            liveOwner,
            'workflow:user:skip-dead-workflow',
            { concurrency: { max: 1 } },
            5_000
          )
        );

        await harness.limits.release(releaseRequest(first.lease));

        const promoted = await harness.limits.acquire(
          acquireRequest(
            liveOwner,
            'workflow:user:skip-dead-workflow',
            { concurrency: { max: 1 } },
            5_000
          )
        );

        expect(promoted.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('does not duplicate a replayed blocked holder waiter or lease', async () => {
      const harness = await createHarness();
      try {
        const key = 'workflow:user:replay';
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const replayOwner = await createLockOwner(
          harness.storage,
          'holder-replay'
        );
        const blockedLockId = replayOwner.lockId;

        const first = await harness.limits.acquire(
          acquireRequest(ownerA, key, { concurrency: { max: 1 } }, 1_000)
        );
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const blockedA = await harness.limits.acquire(
          acquireRequest(replayOwner, key, { concurrency: { max: 1 } }, 1_000)
        );
        const blockedB = await harness.limits.acquire(
          acquireRequest(replayOwner, key, { concurrency: { max: 1 } }, 1_000)
        );

        expect(blockedA.status).toBe('blocked');
        expect(blockedB.status).toBe('blocked');

        const blockedState = await harness.inspectKeyState(key);
        expect(
          blockedState.waiterHolderIds.filter(
            (lockId) => lockId === blockedLockId
          )
        ).toHaveLength(1);
        expect(
          blockedState.leaseHolderIds.filter(
            (lockId) => lockId === blockedLockId
          )
        ).toHaveLength(0);

        await harness.limits.release(releaseRequest(first.lease));

        const acquired = await harness.limits.acquire(
          acquireRequest(replayOwner, key, { concurrency: { max: 1 } }, 1_000)
        );
        expect(acquired.status).toBe('acquired');
        if (acquired.status !== 'acquired')
          throw new Error('expected replayed holder acquisition');

        const acquiredState = await harness.inspectKeyState(key);
        expect(
          acquiredState.waiterHolderIds.filter(
            (lockId) => lockId === blockedLockId
          )
        ).toHaveLength(0);
        expect(
          acquiredState.leaseHolderIds.filter(
            (lockId) => lockId === blockedLockId
          )
        ).toHaveLength(1);
      } finally {
        await harness.close?.();
      }
    });
  });
}
