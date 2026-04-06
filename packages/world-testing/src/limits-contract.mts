import { setTimeout as sleep } from 'node:timers/promises';
import {
  createLockId,
  type LimitDefinition,
  type LimitLease,
  type Limits,
  SPEC_VERSION_CURRENT,
  type Storage,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';

export interface LimitsHarness {
  limits: Limits;
  storage: Pick<Storage, 'events'>;
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

type AcquireResult = Awaited<ReturnType<Limits['acquire']>>;
type AcquiredResult = Extract<AcquireResult, { status: 'acquired' }>;
type BlockedResult = Extract<AcquireResult, { status: 'blocked' }>;

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

async function createLockOwner(
  storage: Pick<Storage, 'events'>,
  workflowName: string,
  lockIndex = 0
): Promise<LockOwner> {
  const run = await createRun(storage, workflowName);
  return {
    lockId: createLockId(run.runId, lockIndex),
    runId: run.runId,
    lockIndex,
  };
}

function acquireRequest(request: {
  owner: LockOwner;
  key: string;
  definition: LimitDefinition;
  leaseTtlMs: number;
}) {
  return {
    key: request.key,
    runId: request.owner.runId,
    lockIndex: request.owner.lockIndex,
    definition: request.definition,
    leaseTtlMs: request.leaseTtlMs,
  };
}

function releaseRequest(lease: LimitLease) {
  return {
    leaseId: lease.leaseId,
    key: lease.key,
    lockId: lease.lockId,
  };
}

function expectAcquired(result: AcquireResult): AcquiredResult {
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired') {
    throw new Error('expected acquisition');
  }
  return result;
}

function expectBlocked(
  result: AcquireResult,
  reason?: BlockedResult['reason']
): BlockedResult {
  expect(result.status).toBe('blocked');
  if (result.status !== 'blocked') {
    throw new Error('expected blocked');
  }
  if (reason) {
    expect(result.reason).toBe(reason);
  }
  return result;
}

async function waitForAcquired(
  acquire: () => Promise<AcquireResult>,
  timeoutMs: number
) {
  let result = await acquire();
  const deadline = Date.now() + timeoutMs;

  while (result.status === 'blocked' && Date.now() < deadline) {
    await sleep(Math.max(25, result.retryAfterMs ?? 0) + 50);
    result = await acquire();
  }

  return expectAcquired(result);
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
        const first = expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerA,
              key: 'step:db:cheap',
              definition: { concurrency: { max: 1 } },
              leaseTtlMs: 1_000,
            })
          )
        );

        const second = await harness.limits.acquire(
          acquireRequest({
            owner: ownerB,
            key: 'step:db:cheap',
            definition: { concurrency: { max: 1 } },
            leaseTtlMs: 1_000,
          })
        );
        expectBlocked(second, 'concurrency');

        await harness.limits.release(releaseRequest(first.lease));

        const third = await harness.limits.acquire(
          acquireRequest({
            owner: ownerB,
            key: 'step:db:cheap',
            definition: { concurrency: { max: 1 } },
            leaseTtlMs: 1_000,
          })
        );
        expectAcquired(third);
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
              acquireRequest({
                owner,
                key: 'workflow:user:concurrent',
                definition: { concurrency: { max: 1 } },
                leaseTtlMs: 10_000,
              })
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
        const key = 'step:provider:openai';
        const definition = { rate: { count: 1, periodMs } } as const;
        const first = expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerA,
              key,
              definition,
              leaseTtlMs: 5_000,
            })
          )
        );

        await harness.limits.release(releaseRequest(first.lease));

        const second = expectBlocked(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerB,
              key,
              definition,
              leaseTtlMs: 5_000,
            })
          ),
          'rate'
        );
        expect(second.retryAfterMs).toBeGreaterThanOrEqual(0);
        const secondRetry = await waitForAcquired(
          () =>
            harness.limits.acquire(
              acquireRequest({
                owner: ownerB,
                key,
                definition,
                leaseTtlMs: 1_000,
              })
            ),
          periodMs + 1_000
        );

        await harness.limits.release(releaseRequest(secondRetry.lease));

        await waitForAcquired(
          () =>
            harness.limits.acquire(
              acquireRequest({
                owner: ownerC,
                key,
                definition,
                leaseTtlMs: 1_000,
              })
            ),
          periodMs + 1_000
        );
      } finally {
        await harness.close?.();
      }
    });

    it('returns a combined blocked reason when both limits are saturated', async () => {
      const harness = await createHarness();
      try {
        const periodMs = 3_000;
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const key = 'step:mixed';
        const definition = {
          concurrency: { max: 1 },
          rate: { count: 1, periodMs },
        } as const;
        const first = expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerA,
              key,
              definition,
              leaseTtlMs: 5_000,
            })
          )
        );

        const second = await harness.limits.acquire(
          acquireRequest({
            owner: ownerB,
            key,
            definition,
            leaseTtlMs: 5_000,
          })
        );
        expectBlocked(second, 'concurrency_and_rate');

        await harness.limits.release(releaseRequest(first.lease));

        expectBlocked(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerB,
              key,
              definition,
              leaseTtlMs: 1_000,
            })
          ),
          'rate'
        );

        await waitForAcquired(
          () =>
            harness.limits.acquire(
              acquireRequest({
                owner: ownerB,
                key,
                definition,
                leaseTtlMs: 5_000,
              })
            ),
          periodMs + 1_000
        );
      } finally {
        await harness.close?.();
      }
    });

    it('throws when the same key is acquired with a conflicting definition', async () => {
      const harness = await createHarness();
      try {
        await expect(
          harness.limits.acquire({
            key: 'shared-key',
            runId: 'run-a',
            lockIndex: 0,
            definition: { concurrency: { max: 1 } },
            leaseTtlMs: 60_000,
          })
        ).resolves.toMatchObject({ status: 'acquired' });

        await expect(
          harness.limits.acquire({
            key: 'shared-key',
            runId: 'run-b',
            lockIndex: 0,
            definition: { rate: { count: 1, periodMs: 5_000 } },
            leaseTtlMs: 60_000,
          })
        ).rejects.toMatchObject({
          name: 'LimitDefinitionConflictError',
        });
      } finally {
        await harness.close?.();
      }
    });

    it('allows a key definition to be reseeded after the key fully drains', async () => {
      const harness = await createHarness();
      try {
        await expect(
          harness.limits.acquire({
            key: 'shared-key',
            runId: 'run-a',
            lockIndex: 0,
            definition: { concurrency: { max: 1 } },
            leaseTtlMs: 200,
          })
        ).resolves.toMatchObject({ status: 'acquired' });

        await sleep(400);

        await expect(
          harness.limits.acquire({
            key: 'shared-key',
            runId: 'run-b',
            lockIndex: 0,
            definition: { rate: { count: 1, periodMs: 5_000 } },
            leaseTtlMs: 200,
          })
        ).resolves.toMatchObject({ status: 'acquired' });
      } finally {
        await harness.close?.();
      }
    });

    it('uses the head waiter retryAfter for backlog-only waiters', async () => {
      const harness = await createHarness();
      try {
        const key = 'workflow:user:queued-behind-rate';
        const periodMs = 5_000;
        const definition = { rate: { count: 1, periodMs } } as const;

        expectAcquired(
          await harness.limits.acquire({
            key,
            runId: 'run-a',
            lockIndex: 0,
            definition,
            leaseTtlMs: 10,
          })
        );

        await sleep(25);

        const headWaiter = expectBlocked(
          await harness.limits.acquire({
            key,
            runId: 'run-b',
            lockIndex: 0,
            definition,
            leaseTtlMs: 10,
          }),
          'rate'
        );
        expect(headWaiter.retryAfterMs).toBeGreaterThan(0);

        const backlogOnlyWaiter = expectBlocked(
          await harness.limits.acquire({
            key,
            runId: 'run-c',
            lockIndex: 0,
            definition,
            leaseTtlMs: 10,
          }),
          'queued'
        );
        expect(backlogOnlyWaiter.retryAfterMs).toBeGreaterThan(0);
      } finally {
        await harness.close?.();
      }
    });

    it('extends lease expiry when heartbeated', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const key = 'workflow:user:heartbeat';
        const definition = { concurrency: { max: 1 } } as const;
        const first = expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerA,
              key,
              definition,
              leaseTtlMs: 1_000,
            })
          )
        );

        const heartbeat = await harness.limits.heartbeat({
          leaseId: first.lease.leaseId,
          ttlMs: 5_000,
        });

        expect(heartbeat.expiresAt?.getTime()).toBeGreaterThan(
          first.lease.expiresAt?.getTime() ?? 0
        );

        expectBlocked(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerB,
              key,
              definition,
              leaseTtlMs: 5_000,
            })
          ),
          'concurrency'
        );
      } finally {
        await harness.close?.();
      }
    });

    it('does not resurrect an expired lease when heartbeating after expiry', async () => {
      const harness = await createHarness();
      try {
        const owner = await createLockOwner(harness.storage, 'holder-a');
        const result = expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner,
              key: 'workflow:user:heartbeat-expired',
              definition: { concurrency: { max: 1 } },
              leaseTtlMs: 50,
            })
          )
        );

        await sleep(75);

        await expect(
          harness.limits.heartbeat({
            leaseId: result.lease.leaseId,
          })
        ).rejects.toMatchObject({
          name: 'WorkflowWorldError',
          message: expect.stringContaining('not found'),
        });
      } finally {
        await harness.close?.();
      }
    });

    it('reclaims expired leases without manual cleanup', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const ownerB = await createLockOwner(harness.storage, 'holder-b');
        const key = 'workflow:user:expired';
        const definition = { concurrency: { max: 1 } } as const;
        expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerA,
              key,
              definition,
              leaseTtlMs: 1_000,
            })
          )
        );

        expectBlocked(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerB,
              key,
              definition,
              leaseTtlMs: 5_000,
            })
          ),
          'concurrency'
        );

        await sleep(1_500);

        expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerB,
              key,
              definition,
              leaseTtlMs: 5_000,
            })
          )
        );
      } finally {
        await harness.close?.();
      }
    });

    it('reuses an existing lease for the same holder', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createLockOwner(harness.storage, 'holder-a');
        const key = 'workflow:user:reacquire';
        const definition = { concurrency: { max: 1 } } as const;
        const first = expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerA,
              key,
              definition,
              leaseTtlMs: 1_000,
            })
          )
        );

        const second = await harness.limits.acquire(
          acquireRequest({
            owner: ownerA,
            key,
            definition,
            leaseTtlMs: 1_000,
          })
        );
        expect(second).toMatchObject({
          status: 'acquired',
          lease: {
            leaseId: first.lease.leaseId,
            lockId: first.lease.lockId,
          },
        });
        const keyState = await harness.inspectKeyState(key);
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

    it('prunes terminal holders during release before promoting the next waiter', async () => {
      const harness = await createHarness();
      try {
        const liveRun = await createRun(harness.storage, 'live-holder');
        const deadRunA = await createRun(harness.storage, 'dead-holder-a');
        const deadRunB = await createRun(harness.storage, 'dead-holder-b');
        const waiterRun = await createRun(harness.storage, 'waiter-holder');

        for (const run of [liveRun, deadRunA, deadRunB, waiterRun]) {
          await harness.storage.events.create(run.runId, {
            eventType: 'run_started',
            specVersion: SPEC_VERSION_CURRENT,
          });
        }

        const key = 'workflow:user:terminal-holder-release';
        const definition = { concurrency: { max: 3 } } as const;
        const acquiredLive = expectAcquired(
          await harness.limits.acquire({
            key,
            runId: liveRun.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );
        expectAcquired(
          await harness.limits.acquire({
            key,
            runId: deadRunA.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );
        expectAcquired(
          await harness.limits.acquire({
            key,
            runId: deadRunB.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );

        expectBlocked(
          await harness.limits.acquire({
            key,
            runId: waiterRun.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 5_000,
          })
        );

        for (const run of [deadRunA, deadRunB]) {
          await harness.storage.events.create(run.runId, {
            eventType: 'run_completed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: { output: null },
          });
        }

        const released = await harness.limits.release(
          releaseRequest(acquiredLive.lease)
        );
        expect(released.promotedWaiters).toEqual([
          expect.objectContaining({
            runId: waiterRun.runId,
            lockIndex: 0,
          }),
        ]);

        expectAcquired(
          await harness.limits.acquire({
            key,
            runId: waiterRun.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 5_000,
          })
        );
      } finally {
        await harness.close?.();
      }
    });

    it('promotes every waiter that fits after a release', async () => {
      const harness = await createHarness();
      try {
        const liveRun = await createRun(harness.storage, 'live-holder');
        const deadRunA = await createRun(harness.storage, 'dead-holder-a');
        const deadRunB = await createRun(harness.storage, 'dead-holder-b');
        const waiterRunA = await createRun(harness.storage, 'waiter-holder-a');
        const waiterRunB = await createRun(harness.storage, 'waiter-holder-b');

        for (const run of [
          liveRun,
          deadRunA,
          deadRunB,
          waiterRunA,
          waiterRunB,
        ]) {
          await harness.storage.events.create(run.runId, {
            eventType: 'run_started',
            specVersion: SPEC_VERSION_CURRENT,
          });
        }

        const key = 'workflow:user:multi-promotion';
        const definition = { concurrency: { max: 3 } } as const;
        const acquiredLive = expectAcquired(
          await harness.limits.acquire({
            key,
            runId: liveRun.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );
        expectAcquired(
          await harness.limits.acquire({
            key,
            runId: deadRunA.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );
        expectAcquired(
          await harness.limits.acquire({
            key,
            runId: deadRunB.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );

        expectBlocked(
          await harness.limits.acquire({
            key,
            runId: waiterRunA.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 5_000,
          })
        );
        expectBlocked(
          await harness.limits.acquire({
            key,
            runId: waiterRunB.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 5_000,
          })
        );

        for (const run of [deadRunA, deadRunB]) {
          await harness.storage.events.create(run.runId, {
            eventType: 'run_completed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: { output: null },
          });
        }

        const released = await harness.limits.release(
          releaseRequest(acquiredLive.lease)
        );
        expect(released.promotedWaiters).toEqual([
          expect.objectContaining({
            runId: waiterRunA.runId,
            lockIndex: 0,
          }),
          expect.objectContaining({
            runId: waiterRunB.runId,
            lockIndex: 0,
          }),
        ]);
      } finally {
        await harness.close?.();
      }
    });

    it('only mutates the targeted key during release bookkeeping', async () => {
      const harness = await createHarness();
      try {
        const ownerA = await createRun(harness.storage, 'holder-a');
        const deadRun = await createRun(harness.storage, 'dead-holder');
        const waiterRun = await createRun(harness.storage, 'waiter-holder');

        for (const run of [ownerA, deadRun, waiterRun]) {
          await harness.storage.events.create(run.runId, {
            eventType: 'run_started',
            specVersion: SPEC_VERSION_CURRENT,
          });
        }

        const keyA = 'workflow:user:target-a';
        const keyB = 'workflow:user:target-b';
        const definition = { concurrency: { max: 1 } } as const;

        const acquiredA = expectAcquired(
          await harness.limits.acquire({
            key: keyA,
            runId: ownerA.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );
        expectAcquired(
          await harness.limits.acquire({
            key: keyB,
            runId: deadRun.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 60_000,
          })
        );

        expectBlocked(
          await harness.limits.acquire({
            key: keyB,
            runId: waiterRun.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 5_000,
          })
        );

        await harness.storage.events.create(deadRun.runId, {
          eventType: 'run_completed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { output: null },
        });

        const released = await harness.limits.release(
          releaseRequest(acquiredA.lease)
        );
        expect(released.promotedWaiters).toEqual([]);

        const stateBeforeTouch = await harness.inspectKeyState(keyB);
        expect(stateBeforeTouch.leaseHolderIds).toHaveLength(1);
        expect(stateBeforeTouch.waiterHolderIds).toHaveLength(1);

        expectAcquired(
          await harness.limits.acquire({
            key: keyB,
            runId: waiterRun.runId,
            lockIndex: 0,
            definition,
            leaseTtlMs: 5_000,
          })
        );
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

        const definition = { concurrency: { max: 1 } } as const;
        const first = expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: ownerA,
              key,
              definition,
              leaseTtlMs: 1_000,
            })
          )
        );

        const blockedA = await harness.limits.acquire(
          acquireRequest({
            owner: replayOwner,
            key,
            definition,
            leaseTtlMs: 1_000,
          })
        );
        const blockedB = await harness.limits.acquire(
          acquireRequest({
            owner: replayOwner,
            key,
            definition,
            leaseTtlMs: 1_000,
          })
        );

        expectBlocked(blockedA, 'concurrency');
        expectBlocked(blockedB, 'concurrency');

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

        expectAcquired(
          await harness.limits.acquire(
            acquireRequest({
              owner: replayOwner,
              key,
              definition,
              leaseTtlMs: 1_000,
            })
          )
        );

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
