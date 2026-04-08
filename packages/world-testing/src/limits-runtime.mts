import { describe, expect, it } from 'vitest';

type LockWindow = {
  acquiredAt: number;
  releasedAt: number;
};

type WorkflowLockResult = {
  label: string;
  lock: LockWindow;
};

type WorkflowLockContentionResult = {
  workflow: LockWindow;
  step: LockWindow;
};

type WorkflowRateResult = WorkflowLockResult & {
  periodMs: number;
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

function sortByLock<T extends { lock: LockWindow }>(results: [T, T]): [T, T] {
  return [...results].sort((a, b) => a.lock.acquiredAt - b.lock.acquiredAt) as [
    T,
    T,
  ];
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
  runWorkflowLockAcrossSuspension(
    userId: string,
    holdMs: number
  ): Promise<[WorkflowLockResult, WorkflowLockResult]>;
  runWorkflowMixedLimitContention(
    userId: string,
    holdMs: number,
    periodMs: number
  ): Promise<[WorkflowRateResult, WorkflowRateResult]>;
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
      const [resultA, resultB] = sortByLock(
        await harness.runWorkflowLockAcrossSuspension('shared-user', 1_500)
      );

      expect(resultB.lock.acquiredAt).toBeGreaterThanOrEqual(
        resultA.lock.releasedAt
      );
      expect(resultB.lock.acquiredAt - resultA.lock.releasedAt).toBeLessThan(
        4_000
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
  });
}
