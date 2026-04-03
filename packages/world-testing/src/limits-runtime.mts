import { describe, expect, it } from 'vitest';

type LockWindow = {
  acquiredAt: number;
  releasedAt: number;
};

type WorkflowLockResult = {
  label: string;
  lock: LockWindow;
};

type StepLockResult = {
  label: string;
  key: string;
  attempt: number;
  lock: LockWindow;
};

type WorkflowLockContentionResult = {
  workflow: LockWindow;
  step: LockWindow;
};

type WorkflowRateResult = {
  label: string;
  periodMs: number;
  lock: LockWindow;
};

type ReleasedRateLimitReplayResult = {
  elapsedMs: number;
  periodMs: number;
  sleepMs: number;
};

type LeakedLockResult = {
  label: string;
  key: string;
  leaseTtlMs: number;
  lockAcquiredAt: number;
  workflowCompletedAt: number;
};

type WorkflowMultiStepScopeResult = {
  key: string;
  lock: LockWindow;
  firstStepCompletedAt: number;
  secondStepCompletedAt: number;
};

function sortByWorkflowLock<T extends { workflow: LockWindow }>(
  results: [T, T]
): [T, T] {
  return [...results].sort(
    (a, b) => a.workflow.acquiredAt - b.workflow.acquiredAt
  ) as [T, T];
}

export interface LimitsRuntimeHarness {
  runWorkflowWithScopedLocks(userId: string): Promise<{
    workflowKey: string;
    dbKey: string;
    aiKey: string;
    summary: string;
  }>;
  runWorkflowLockContention(
    userId: string,
    holdMs: number
  ): Promise<[WorkflowLockContentionResult, WorkflowLockContentionResult]>;
  runLockedStepCallContention(
    key: string,
    holdMs: number
  ): Promise<[StepLockResult, StepLockResult]>;
  runWorkflowLockAcrossSuspension(
    userId: string,
    holdMs: number
  ): Promise<[WorkflowLockResult, WorkflowLockResult]>;
  runWorkflowExpiredLeaseRecovery(
    userId: string,
    leaseTtlMs: number
  ): Promise<[LeakedLockResult, WorkflowLockResult]>;
  runWorkflowTerminalHolderRecovery(
    userId: string,
    leaseTtlMs: number
  ): Promise<[LeakedLockResult, WorkflowLockResult]>;
  runLeakedKeyExpiredLeaseRecovery(
    userId: string,
    leaseTtlMs: number
  ): Promise<[LeakedLockResult, StepLockResult]>;
  runWorkflowMixedLimitContention(
    userId: string,
    holdMs: number,
    periodMs: number
  ): Promise<[WorkflowRateResult, WorkflowRateResult]>;
  runReleasedRateLimitReplay(
    userId: string,
    periodMs: number,
    sleepMs: number
  ): Promise<ReleasedRateLimitReplayResult>;
  runWorkflowFifoThreeWaiters(
    userId: string,
    holdMs: number
  ): Promise<[WorkflowLockResult, WorkflowLockResult, WorkflowLockResult]>;
  runCancelledWorkflowWaiter(
    userId: string,
    holdMs: number
  ): Promise<{
    cancelledError: unknown;
    resultA: WorkflowLockResult;
    resultC: WorkflowLockResult;
  }>;
  runIndependentWorkflowKeys(
    holdMs: number
  ): Promise<[WorkflowLockResult, WorkflowLockResult]>;
  runIndependentStepKeys(
    holdMs: number
  ): Promise<[StepLockResult, StepLockResult]>;
  runBlockedWaiterWithUnrelatedWorkflow(holdMs: number): Promise<{
    holder: WorkflowLockResult;
    waiter: WorkflowLockResult;
    unrelated: WorkflowLockResult;
  }>;
  runWorkflowSingleLockAcrossMultipleSteps(
    holdMs: number
  ): Promise<WorkflowMultiStepScopeResult>;
}

export function createLimitsRuntimeSuite(
  name: string,
  createHarness: () => Promise<LimitsRuntimeHarness>
) {
  describe(name, () => {
    it('runs locks around individual step calls end-to-end', async () => {
      const harness = await createHarness();
      const userId = 'shared-user';
      const result = await harness.runWorkflowWithScopedLocks(userId);

      expect(result).toMatchObject({
        workflowKey: `workflow:user:${userId}`,
        dbKey: 'step:db:cheap',
        aiKey: 'step:provider:openai',
        summary: `summary:profile:${userId}`,
      });
    });

    it('serializes workflow locks and locks around step calls under contention', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = sortByWorkflowLock(
        await harness.runWorkflowLockContention('shared-user', 750)
      );

      expect(resultB.workflow.acquiredAt).toBeGreaterThanOrEqual(
        resultA.workflow.releasedAt
      );
      expect(resultB.step.acquiredAt).toBeGreaterThanOrEqual(
        resultA.step.releasedAt
      );
    });

    it('wakes promoted workflow and step-call lock waiters promptly', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = sortByWorkflowLock(
        await harness.runWorkflowLockContention('shared-user', 1_500)
      );

      expect(
        resultB.workflow.acquiredAt - resultA.workflow.releasedAt
      ).toBeLessThan(4_000);
      expect(resultB.step.acquiredAt - resultA.step.releasedAt).toBeLessThan(
        4_000
      );
    });

    it('can hold one workflow lock across multiple steps in the same scope', async () => {
      const harness = await createHarness();
      const result =
        await harness.runWorkflowSingleLockAcrossMultipleSteps(400);

      expect(result.firstStepCompletedAt).toBeGreaterThanOrEqual(
        result.lock.acquiredAt
      );
      expect(result.secondStepCompletedAt).toBeGreaterThanOrEqual(
        result.firstStepCompletedAt
      );
      expect(result.lock.releasedAt).toBeGreaterThanOrEqual(
        result.secondStepCompletedAt
      );
    });

    it('keeps workflow locks held across suspension until the workflow finishes', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = await harness.runWorkflowLockAcrossSuspension(
        'shared-user',
        1_500
      );

      expect(resultB.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultA.lock.releasedAt
      );
      expect(resultB.lock.acquiredAt - resultA.lock.releasedAt).toBeLessThan(
        4_000
      );
    });

    it('reclaims terminal workflow-held locks on workflow keys', async () => {
      const harness = await createHarness();
      const leaseTtlMs = 1_250;
      const [resultA, resultB] = await harness.runWorkflowExpiredLeaseRecovery(
        'expired-workflow-user',
        leaseTtlMs
      );

      expect(resultB.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowCompletedAt
      );
    });

    it('reclaims terminal workflow holder leases promptly before ttl expiry', async () => {
      const harness = await createHarness();
      const leaseTtlMs = 30_000;
      const [resultA, resultB] =
        await harness.runWorkflowTerminalHolderRecovery(
          'terminal-holder-user',
          leaseTtlMs
        );

      expect(resultB.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowCompletedAt
      );
      expect(resultB.lock.acquiredAt - resultA.lockAcquiredAt).toBeLessThan(
        leaseTtlMs - 5_000
      );
    });

    it('reclaims terminal workflow-held locks on arbitrary keys', async () => {
      const harness = await createHarness();
      const leaseTtlMs = 1_250;
      const [resultA, resultB] = await harness.runLeakedKeyExpiredLeaseRecovery(
        'expired-key-user',
        leaseTtlMs
      );

      expect(resultB.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowCompletedAt
      );
    });

    it('keeps mixed concurrency and rate waiters blocked until the rate window expires', async () => {
      const harness = await createHarness();
      const holdMs = 250;
      const periodMs = 1_500;
      const [resultA, resultB] = await harness.runWorkflowMixedLimitContention(
        'shared-user',
        holdMs,
        periodMs
      );

      expect(
        resultB.lock.acquiredAt - resultA.lock.acquiredAt
      ).toBeGreaterThanOrEqual(periodMs - 100);

      const remainingWindowAfterRelease =
        periodMs - (resultA.lock.releasedAt - resultA.lock.acquiredAt);
      expect(
        resultB.lock.acquiredAt - resultA.lock.releasedAt
      ).toBeGreaterThanOrEqual(Math.max(0, remainingWindowAfterRelease - 100));
    });

    it('does not reacquire a released rate-only lock on later replay', async () => {
      const harness = await createHarness();
      const result = await harness.runReleasedRateLimitReplay(
        'replay-user',
        6_000,
        100
      );

      expect(result.elapsedMs).toBeLessThan(4_000);
    });

    it('promotes 3 workflow waiters in FIFO order', async () => {
      const harness = await createHarness();
      const [resultA, resultB, resultC] =
        await harness.runWorkflowFifoThreeWaiters('shared-user', 750);

      expect(resultB.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultA.lock.releasedAt
      );
      expect(resultC.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultB.lock.releasedAt
      );
    });

    it('skips cancelled workflow waiters before promoting the next run', async () => {
      const harness = await createHarness();
      const { cancelledError, resultA, resultC } =
        await harness.runCancelledWorkflowWaiter('shared-user', 1_500);

      expect(cancelledError).toBeTruthy();
      expect(resultC.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultA.lock.releasedAt
      );
    });

    it('does not block unrelated workflow keys', async () => {
      const harness = await createHarness();
      const [resultA, resultB] =
        await harness.runIndependentWorkflowKeys(3_000);

      expect(resultB.lock.acquiredAt).toBeLessThan(resultA.lock.releasedAt);
    });

    it('does not block unrelated step-like keys', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = await harness.runIndependentStepKeys(3_000);

      expect(resultB.lock.acquiredAt).toBeLessThan(resultA.lock.releasedAt);
    });

    it.skipIf(process.env.WORKFLOW_LIMITS_LOW_CONCURRENCY !== '1')(
      'frees worker slots for unrelated workflows while a waiter is blocked',
      async () => {
        const harness = await createHarness();
        const { holder, waiter, unrelated } =
          await harness.runBlockedWaiterWithUnrelatedWorkflow(1_500);

        expect(waiter.lock.acquiredAt).toBeGreaterThanOrEqual(
          holder.lock.releasedAt
        );
        expect(unrelated.lock.releasedAt).toBeLessThan(waiter.lock.acquiredAt);
      }
    );
  });
}
