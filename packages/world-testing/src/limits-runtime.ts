import { describe, expect, it } from 'vitest';

type WorkflowLockContentionResult = {
  workflowLockAcquiredAt: number;
  workflowLockReleasedAt: number;
  stepLockAcquiredAt: number;
  stepLockReleasedAt: number;
};

type StepLockNoRetriesResult = {
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

type WorkflowLeakedLockResult = {
  label: string;
  key: string;
  leaseTtlMs: number;
  workflowLockAcquiredAt: number;
  workflowCompletedAt: number;
};

type StepLeakedLockResult = {
  label: string;
  key: string;
  leaseTtlMs: number;
  stepLockAcquiredAt: number;
  workflowCompletedAt: number;
};

type MidStepLockResult = {
  label: string;
  key: string;
  attempt: number;
  lockAcquiredAt: number;
  preLockEffects: number;
  postLockEffects: number;
  trace: string[];
};

export interface LimitsRuntimeHarness {
  runWorkflowWithWorkflowAndStepLocks(userId: string): Promise<{
    workflowKey: string;
    dbKey: string;
    aiKey: string;
    summary: string;
  }>;
  runWorkflowLockContention(
    userId: string,
    holdMs: number
  ): Promise<[WorkflowLockContentionResult, WorkflowLockContentionResult]>;
  runStepLockNoRetriesContention(
    userId: string,
    holdMs: number
  ): Promise<
    [StepLockNoRetriesResult, StepLockNoRetriesResult, StepLockNoRetriesResult]
  >;
  runWorkflowLockAcrossSuspension(
    userId: string,
    holdMs: number
  ): Promise<[WorkflowOnlyLockResult, WorkflowOnlyLockResult]>;
  runWorkflowExpiredLeaseRecovery(
    userId: string,
    leaseTtlMs: number
  ): Promise<[WorkflowLeakedLockResult, WorkflowOnlyLockResult]>;
  runStepExpiredLeaseRecovery(
    userId: string,
    leaseTtlMs: number
  ): Promise<[StepLeakedLockResult, StepLockNoRetriesResult]>;
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
  ): Promise<[StepLockNoRetriesResult, StepLockNoRetriesResult]>;
  runBlockedWaiterWithUnrelatedWorkflow(holdMs: number): Promise<{
    holder: WorkflowOnlyLockResult;
    waiter: WorkflowOnlyLockResult;
    unrelated: WorkflowOnlyLockResult;
  }>;
  runMidStepLockContract(holdMs: number): Promise<{
    holder: StepLockNoRetriesResult;
    waiter: MidStepLockResult;
  }>;
}

export function createLimitsRuntimeSuite(
  name: string,
  createHarness: () => Promise<LimitsRuntimeHarness>
) {
  describe(name, () => {
    it('runs workflow and step locks end-to-end', async () => {
      const harness = await createHarness();
      const userId = 'shared-user';
      const result = await harness.runWorkflowWithWorkflowAndStepLocks(userId);

      expect(result).toMatchObject({
        workflowKey: `workflow:user:${userId}`,
        dbKey: 'step:db:cheap',
        aiKey: 'step:provider:openai',
        summary: `summary:profile:${userId}`,
      });
    });

    it('serializes workflow and step admission under contention', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = await harness.runWorkflowLockContention(
        'shared-user',
        750
      );

      expect(resultB.workflowLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowLockReleasedAt
      );
      expect(resultB.stepLockAcquiredAt).toBeGreaterThanOrEqual(
        resultA.stepLockReleasedAt
      );
    });

    it('wakes promoted workflow and step waiters promptly', async () => {
      const harness = await createHarness();
      const [resultA, resultB] = await harness.runWorkflowLockContention(
        'shared-user',
        1_500
      );

      expect(
        resultB.workflowLockAcquiredAt - resultA.workflowLockReleasedAt
      ).toBeLessThan(4_000);
      expect(
        resultB.stepLockAcquiredAt - resultA.stepLockReleasedAt
      ).toBeLessThan(4_000);
    });

    it('does not consume retries while blocked on a top-of-step lock', async () => {
      const harness = await createHarness();
      const [resultA, resultB, resultC] =
        await harness.runStepLockNoRetriesContention('shared-user', 750);
      const [firstResult, secondResult, thirdResult] = [
        resultA,
        resultB,
        resultC,
      ].sort((left, right) => left.acquiredAt - right.acquiredAt);

      expect(resultA.attempt).toBe(1);
      expect(resultB.attempt).toBe(1);
      expect(resultC.attempt).toBe(1);
      expect(secondResult.acquiredAt).toBeGreaterThanOrEqual(
        firstResult.releasedAt
      );
      expect(thirdResult.acquiredAt).toBeGreaterThanOrEqual(
        secondResult.releasedAt
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

    it('reclaims expired leaked workflow leases without manual cleanup', async () => {
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
        resultB.workflowLockAcquiredAt - resultA.workflowLockAcquiredAt
      ).toBeGreaterThanOrEqual(leaseTtlMs - 100);
    });

    it('reclaims expired leaked step leases without manual cleanup', async () => {
      const harness = await createHarness();
      const leaseTtlMs = 1_250;
      const [resultA, resultB] = await harness.runStepExpiredLeaseRecovery(
        'expired-step-user',
        leaseTtlMs
      );

      expect(resultB.acquiredAt).toBeGreaterThanOrEqual(
        resultA.workflowCompletedAt
      );
      expect(
        resultB.acquiredAt - resultA.stepLockAcquiredAt
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

    it('does not block unrelated step keys', async () => {
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

    it('replays a mid-step lock at the acquire boundary without duplicating post-lock effects', async () => {
      const harness = await createHarness();
      const { holder, waiter } = await harness.runMidStepLockContract(1_500);

      expect(waiter.lockAcquiredAt).toBeGreaterThanOrEqual(holder.releasedAt);
      expect(waiter.preLockEffects).toBe(2);
      expect(waiter.postLockEffects).toBe(1);
      expect(waiter.trace.map((event) => event.split(':')[0])).toEqual([
        'pre',
        'pre',
        'lock',
        'post',
      ]);
    });
  });
}
