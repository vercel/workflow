import { afterEach, describe, expect, it, vi } from 'vitest';
import { lock, LIMITS_NOT_IMPLEMENTED_MESSAGE } from './lock.js';
import { STEP_LOCK, WORKFLOW_LOCK } from './symbols.js';

afterEach(() => {
  delete (globalThis as any)[WORKFLOW_LOCK];
  delete (globalThis as any)[STEP_LOCK];
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
    const stepLock = vi.fn().mockResolvedValue({ leaseId: 'lease_step' });
    (globalThis as any)[WORKFLOW_LOCK] = workflowLock;
    (globalThis as any)[STEP_LOCK] = stepLock;
    const options = {
      key: 'workflow:user:test',
      concurrency: { max: 1 },
    };

    await expect(lock(options)).resolves.toBe(workflowHandle);
    expect(workflowLock).toHaveBeenCalledWith(options);
    expect(stepLock).not.toHaveBeenCalled();
  });

  it('falls back to the step runtime lock when no workflow runtime is present', async () => {
    const handle = { leaseId: 'lease_step' };
    const stepLock = vi.fn().mockResolvedValue(handle);
    (globalThis as any)[STEP_LOCK] = stepLock;
    const options = {
      key: 'step:db:cheap',
      concurrency: { max: 2 },
    };

    await expect(lock(options)).resolves.toBe(handle);
    expect(stepLock).toHaveBeenCalledWith(options);
  });
});
