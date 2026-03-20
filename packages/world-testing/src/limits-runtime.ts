import { describe, expect, it } from 'vitest';

type WorkflowLockContentionResult = {
  workflowLockAcquiredAt: number;
  workflowLockReleasedAt: number;
  stepCallLockAcquiredAt: number;
  stepCallLockReleasedAt: number;
};

type LockedStepCallResult = {
  label: string;
  key?: string;
  attempt: number;
  acquiredAt: number;
  releasedAt: number;
};

type WorkflowOnlyLockResult = {
  label: string;
  workflowLockAcquiredAt: number;
  workflowLockReleasedAt: number;
};

type WorkflowRateLimitResult = {
  label: string;
  workflowRateAcquiredAt: number;
  workflowRateReleasedAt: number;
  periodMs: number;
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
  workflowLockAcquiredAt: number;
  firstStepCompletedAt: number;
  secondStepCompletedAt: number;
  workflowLockReleasedAt: number;
};

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
    holdMs: number,
    labelA?: string,
    labelB?: string
  ): Promise<[LockedStepCallResult, LockedStepCallResult]>;
  runWorkflowLockAcrossSuspension(
    userId: string,
    holdMs: number
  ): Promise<[WorkflowOnlyLockResult, WorkflowOnlyLockResult]>;
  runWorkflowExpiredLeaseRecovery(
    userId: string,
    leaseTtlMs: number
  ): Promise<[LeakedLockResult, WorkflowOnlyLockResult]>;
  runLeakedKeyExpiredLeaseRecovery(
    userId: string,
    leaseTtlMs: number
  ): Promise<[LeakedLockResult, LockedStepCallResult]>;
  runWorkflowMixedLimitContention(
    userId: string,
    holdMs: number,
    periodMs: number
  ): Promise<[WorkflowRateLimitResult, WorkflowRateLimitResult]>;
  runWorkflowFifoThreeWaiters(
    userId: string,
    holdMs: number
  ): Promise<
    [WorkflowOnlyLockResult, WorkflowOnlyLockResult, WorkflowOnlyLockResult]
  >;
  runCancelledWorkflowWaiter(
    userId: string,
    holdMs: number
  ): Promise<{
    cancelledError: unknown;
    resultA: WorkflowOnlyLockResult;
    resultC: WorkflowOnlyLockResult;
  }>;
  runIndependentWorkflowKeys(
    holdMs: number
  ): Promise<[WorkflowOnlyLockResult, WorkflowOnlyLockResult]>;
  runIndependentStepKeys(
    holdMs: number
  ): Promise<[LockedStepCallResult, LockedStepCallResult]>;
  runBlockedWaiterWithUnrelatedWorkflow(holdMs: number): Promise<{
    holder: WorkflowOnlyLockResult;
    waiter: WorkflowOnlyLockResult;
    unrelated: WorkflowOnlyLockResult;
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
      const [resultA, resultB] = await harness.runWorkflowLockContention(
        'shared-user',
        750
      );

      expect(resultB.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowLockReleasedAt
      );
      expect(resultB.stepCallLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.stepCallLockReleasedAt
      );
    });

    it('wakes promoted workflow and step-call lock waiters promptly', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = await harness.runWorkflowLockContention(
        'shared-user',
        1_500
      );

      expect(
        resultB.workflowLockAcquiredAt - resultA.workflowLockReleasedAt
      ).toBeLessThan(4_000);
      expect(
        resultB.stepCallLockAcquiredAt - resultA.stepCallLockReleasedAt
      ).toBeLessThan(4_000);
    });

    it('can hold one workflow lock across multiple steps in the same scope', async () => {
      const harness = await createHarness();
      const result =
        await harness.runWorkflowSingleLockAcrossMultipleSteps(400);

      expect(result.firstStepCompletedAt).toBeGreaterThanOrEqual(
        result.workflowLockAcquiredAt
      );
      expect(result.secondStepCompletedAt).toBeGreaterThanOrEqual(
        result.firstStepCompletedAt
      );
      expect(result.workflowLockReleasedAt).toBeGreaterThanOrEqual(
        result.secondStepCompletedAt
      );
    });

    it('keeps workflow locks held across suspension until the workflow finishes', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = await harness.runWorkflowLockAcrossSuspension(
        'shared-user',
        1_500
      );

      expect(resultB.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowLockReleasedAt
      );
      expect(
        resultB.workflowLockAcquiredAt - resultA.workflowLockReleasedAt
      ).toBeLessThan(4_000);
    });

    it('reclaims expired leaked workflow locks without manual cleanup', async () => {
      const harness = await createHarness();
      const leaseTtlMs = 1_250;
      const [resultA, resultB] = await harness.runWorkflowExpiredLeaseRecovery(
        'expired-workflow-user',
        leaseTtlMs
      );

      expect(resultB.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowCompletedAt
      );
      expect(
        resultB.workflowLockAcquiredAt - resultA.lockAcquiredAt
      ).toBeGreaterThanOrEqual(leaseTtlMs - 100);
    });

    it('reclaims expired leaked locks on arbitrary keys without manual cleanup', async () => {
      const harness = await createHarness();
      const leaseTtlMs = 1_250;
      const [resultA, resultB] = await harness.runLeakedKeyExpiredLeaseRecovery(
        'expired-key-user',
        leaseTtlMs
      );

      expect(resultB.acquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowCompletedAt
      );
      expect(
        resultB.acquiredAt - resultA.lockAcquiredAt
      ).toBeGreaterThanOrEqual(leaseTtlMs - 100);
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
        resultB.workflowRateAcquiredAt - resultA.workflowRateAcquiredAt
      ).toBeGreaterThanOrEqual(periodMs - 100);

      const remainingWindowAfterRelease =
        periodMs -
        (resultA.workflowRateReleasedAt - resultA.workflowRateAcquiredAt);
      expect(
        resultB.workflowRateAcquiredAt - resultA.workflowRateReleasedAt
      ).toBeGreaterThanOrEqual(Math.max(0, remainingWindowAfterRelease - 100));
    });

    it('promotes 3 workflow waiters in FIFO order', async () => {
      const harness = await createHarness();
      const [resultA, resultB, resultC] =
        await harness.runWorkflowFifoThreeWaiters('shared-user', 750);

      expect(resultB.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowLockReleasedAt
      );
      expect(resultC.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
        resultB.workflowLockReleasedAt
      );
    });

    it('skips cancelled workflow waiters before promoting the next run', async () => {
      const harness = await createHarness();
      const { cancelledError, resultA, resultC } =
        await harness.runCancelledWorkflowWaiter('shared-user', 1_500);

      expect(cancelledError).toBeTruthy();
      expect(resultC.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowLockReleasedAt
      );
      expect(
        resultC.workflowLockAcquiredAt - resultA.workflowLockReleasedAt
      ).toBeLessThan(4_000);
    });

    it('does not block unrelated workflow keys', async () => {
      const harness = await createHarness();
      const [resultA, resultB] =
        await harness.runIndependentWorkflowKeys(1_000);

      expect(resultB.workflowLockAcquiredAt).toBeLessThan(
        resultA.workflowLockReleasedAt
      );
    });

    it('does not block unrelated step-like keys', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = await harness.runIndependentStepKeys(1_000);

      expect(resultB.acquiredAt).toBeLessThan(resultA.releasedAt);
    });

    it.skipIf(process.env.WORKFLOW_LIMITS_LOW_CONCURRENCY !== '1')(
      'frees worker slots for unrelated workflows while a waiter is blocked',
      async () => {
        const harness = await createHarness();
        const { holder, waiter, unrelated } =
          await harness.runBlockedWaiterWithUnrelatedWorkflow(1_500);

        expect(waiter.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
          holder.workflowLockReleasedAt
        );
        expect(unrelated.workflowLockReleasedAt).toBeLessThan(
          waiter.workflowLockAcquiredAt
        );
      }
    );
  });
}
