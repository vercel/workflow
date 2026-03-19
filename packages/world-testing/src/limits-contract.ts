import { setTimeout as sleep } from 'node:timers/promises';
import {
  SPEC_VERSION_CURRENT,
  type Limits,
  type Storage,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';

export interface LimitsHarness {
  limits: Limits;
  storage?: Pick<Storage, 'events'>;
  close?: () => Promise<void>;
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

async function createStep(
  storage: Pick<Storage, 'events'>,
  runId: string,
  stepId: string
) {
  const result = await storage.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: {
      stepName: 'test-step',
      input: [],
    },
  });
  if (!result.step) {
    throw new Error('expected step');
  }
  return result.step;
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
        const first = await harness.limits.acquire({
          key: 'step:db:cheap',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire({
          key: 'step:db:cheap',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(second).toMatchObject({
          status: 'blocked',
          reason: 'concurrency',
        });

        await harness.limits.release({
          leaseId: first.lease.leaseId,
          key: first.lease.key,
          holderId: first.lease.holderId,
        });

        const third = await harness.limits.acquire({
          key: 'step:db:cheap',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(third.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('serializes concurrent acquires for the same key', async () => {
      const harness = await createHarness();
      try {
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            harness.limits.acquire({
              key: 'workflow:user:concurrent',
              holderId: `holder-${index}`,
              definition: { concurrency: { max: 1 } },
              leaseTtlMs: 1_000,
            })
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
        const periodMs = 200;
        const first = await harness.limits.acquire({
          key: 'step:provider:openai',
          holderId: 'holder-a',
          definition: { rate: { count: 1, periodMs } },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        await harness.limits.release({
          leaseId: first.lease.leaseId,
          key: first.lease.key,
          holderId: first.lease.holderId,
        });

        const second = await harness.limits.acquire({
          key: 'step:provider:openai',
          holderId: 'holder-b',
          definition: { rate: { count: 1, periodMs } },
          leaseTtlMs: 1_000,
        });
        expect(second.status).toBe('blocked');
        if (second.status !== 'blocked') throw new Error('expected blocked');
        expect(second.reason).toBe('rate');
        expect(second.retryAfterMs).toBeGreaterThanOrEqual(0);

        let third = await harness.limits.acquire({
          key: 'step:provider:openai',
          holderId: 'holder-c',
          definition: { rate: { count: 1, periodMs } },
          leaseTtlMs: 1_000,
        });
        const deadline = Date.now() + periodMs + 1_000;
        while (third.status === 'blocked' && Date.now() < deadline) {
          await sleep(Math.max(25, third.retryAfterMs) + 50);
          third = await harness.limits.acquire({
            key: 'step:provider:openai',
            holderId: 'holder-c',
            definition: { rate: { count: 1, periodMs } },
            leaseTtlMs: 1_000,
          });
        }
        expect(third.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('returns a combined blocked reason when both limits are saturated', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'step:mixed',
          holderId: 'holder-a',
          definition: {
            concurrency: { max: 1 },
            rate: { count: 1, periodMs: 1_000 },
          },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire({
          key: 'step:mixed',
          holderId: 'holder-b',
          definition: {
            concurrency: { max: 1 },
            rate: { count: 1, periodMs: 1_000 },
          },
          leaseTtlMs: 1_000,
        });
        expect(second).toMatchObject({
          status: 'blocked',
          reason: 'concurrency_and_rate',
        });
      } finally {
        await harness.close?.();
      }
    });

    it('restores capacity when a lease is released or expires', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'workflow:user:123',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 500,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const heartbeat = await harness.limits.heartbeat({
          leaseId: first.lease.leaseId,
          ttlMs: 1_000,
        });
        expect(heartbeat.expiresAt?.getTime()).toBeGreaterThan(
          first.lease.expiresAt?.getTime() ?? 0
        );

        await sleep(1_100);

        const second = await harness.limits.acquire({
          key: 'workflow:user:123',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(second.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('reuses an existing lease for the same holder', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'workflow:user:reacquire',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire({
          key: 'workflow:user:reacquire',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(second).toMatchObject({
          status: 'acquired',
          lease: {
            leaseId: first.lease.leaseId,
            holderId: first.lease.holderId,
          },
        });
      } finally {
        await harness.close?.();
      }
    });

    it('promotes waiters in FIFO order per key', async () => {
      const harness = await createHarness();
      try {
        const first = await harness.limits.acquire({
          key: 'workflow:user:ordered',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        const second = await harness.limits.acquire({
          key: 'workflow:user:ordered',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        const third = await harness.limits.acquire({
          key: 'workflow:user:ordered',
          holderId: 'holder-c',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });

        expect(second.status).toBe('blocked');
        expect(third.status).toBe('blocked');

        await harness.limits.release({
          leaseId: first.lease.leaseId,
          holderId: first.lease.holderId,
          key: first.lease.key,
        });

        const promoted = await harness.limits.acquire({
          key: 'workflow:user:ordered',
          holderId: 'holder-b',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });
        const stillWaiting = await harness.limits.acquire({
          key: 'workflow:user:ordered',
          holderId: 'holder-c',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });

        expect(promoted.status).toBe('acquired');
        expect(stillWaiting.status).toBe('blocked');
        if (promoted.status !== 'acquired')
          throw new Error('expected waiter-b promotion');

        await harness.limits.release({
          leaseId: promoted.lease.leaseId,
          holderId: promoted.lease.holderId,
          key: promoted.lease.key,
        });

        const thirdPromoted = await harness.limits.acquire({
          key: 'workflow:user:ordered',
          holderId: 'holder-c',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 1_000,
        });

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

        const first = await harness.limits.acquire({
          key: 'workflow:user:skip-dead-workflow',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        await harness.limits.acquire({
          key: 'workflow:user:skip-dead-workflow',
          holderId: `wflock_${deadRun.runId}:limitwait_dead`,
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });
        await harness.limits.acquire({
          key: 'workflow:user:skip-dead-workflow',
          holderId: `wflock_${liveRun.runId}:limitwait_live`,
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });

        await harness.limits.release({
          leaseId: first.lease.leaseId,
          holderId: first.lease.holderId,
          key: first.lease.key,
        });

        const promoted = await harness.limits.acquire({
          key: 'workflow:user:skip-dead-workflow',
          holderId: `wflock_${liveRun.runId}:limitwait_live`,
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });

        expect(promoted.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });

    it('skips failed step waiters before promotion', async () => {
      const harness = await createHarness();
      try {
        if (!harness.storage) {
          throw new Error('storage is required for step waiter liveness');
        }

        const deadRun = await createRun(harness.storage, 'dead-step-workflow');
        await harness.storage.events.create(deadRun.runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
        const deadStep = await createStep(
          harness.storage,
          deadRun.runId,
          'step-dead'
        );
        await harness.storage.events.create(deadRun.runId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: deadStep.stepId,
        });
        await harness.storage.events.create(deadRun.runId, {
          eventType: 'step_failed',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: deadStep.stepId,
          eventData: {
            error: { name: 'Error', message: 'failed waiter' },
          },
        } as any);

        const liveRun = await createRun(harness.storage, 'live-step-workflow');
        await harness.storage.events.create(liveRun.runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
        const liveStep = await createStep(
          harness.storage,
          liveRun.runId,
          'step-live'
        );

        const first = await harness.limits.acquire({
          key: 'step:skip-dead-step',
          holderId: 'holder-a',
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired')
          throw new Error('expected acquisition');

        await harness.limits.acquire({
          key: 'step:skip-dead-step',
          holderId: `stplock_${deadRun.runId}:${deadStep.stepId}:0`,
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });
        await harness.limits.acquire({
          key: 'step:skip-dead-step',
          holderId: `stplock_${liveRun.runId}:${liveStep.stepId}:0`,
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });

        await harness.limits.release({
          leaseId: first.lease.leaseId,
          holderId: first.lease.holderId,
          key: first.lease.key,
        });

        const promoted = await harness.limits.acquire({
          key: 'step:skip-dead-step',
          holderId: `stplock_${liveRun.runId}:${liveStep.stepId}:0`,
          definition: { concurrency: { max: 1 } },
          leaseTtlMs: 5_000,
        });

        expect(promoted.status).toBe('acquired');
      } finally {
        await harness.close?.();
      }
    });
  });
}
