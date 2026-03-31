import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lock,
  LIMITS_NOT_IMPLEMENTED_MESSAGE,
  LOCK_WORKFLOW_ONLY_MESSAGE,
} from './lock.js';
import { contextStorage } from './step/context-storage.js';
import { WORKFLOW_HAS_STEP_CONTEXT, WORKFLOW_LOCK } from './symbols.js';

afterEach(() => {
  delete (globalThis as any)[WORKFLOW_LOCK];
  (globalThis as any)[WORKFLOW_HAS_STEP_CONTEXT] = () =>
    contextStorage.getStore() !== undefined;
});

describe('lock', () => {
  it('throws when called outside workflow or step execution context', async () => {
    await expect(
      lock({
        key: 'workflow:user:test',
        concurrency: { max: 1 },
      })
    ).rejects.toThrow(LIMITS_NOT_IMPLEMENTED_MESSAGE);
  });

  it('prefers the workflow runtime lock when both runtimes are present', async () => {
    const workflowHandle = { leaseId: 'lease_workflow' };
    const workflowLock = vi.fn().mockResolvedValue(workflowHandle);
    (globalThis as any)[WORKFLOW_LOCK] = workflowLock;
    const options = {
      key: 'workflow:user:test',
      concurrency: { max: 1 },
    };

    await expect(lock(options)).resolves.toBe(workflowHandle);
    expect(workflowLock).toHaveBeenCalledWith(options);
  });

  it('throws a workflow-only error when called inside a step context', async () => {
    const options = {
      key: 'step:db:cheap',
      concurrency: { max: 2 },
    };

    await expect(
      contextStorage.run(
        {
          stepMetadata: {
            stepId: 'step_test',
            stepName: 'testStep',
            stepStartedAt: new Date(),
            attempt: 1,
          },
          workflowMetadata: {
            workflowName: 'testWorkflow',
            workflowRunId: 'wrun_test',
            workflowStartedAt: new Date(),
            url: 'http://localhost:3000',
          },
          ops: [],
        },
        () => lock(options)
      )
    ).rejects.toThrow(LOCK_WORKFLOW_ONLY_MESSAGE);
  });
});
