import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from './interfaces.js';
import type { Queue } from './queue.js';
import { reenqueueActiveRuns } from './recovery.js';

function createRuns(): Storage['runs'] {
  return {
    list: vi.fn(async ({ status }) => ({
      data:
        status === 'pending'
          ? [
              {
                runId: 'wrun_AAA',
                workflowName: 'myWorkflow',
                status,
              },
            ]
          : [],
      hasMore: false,
      cursor: null,
    })),
  } as unknown as Storage['runs'];
}

describe('reenqueueActiveRuns', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses WORKFLOW_QUEUE_NAMESPACE for recovered runs', async () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'custom');
    const enqueue = vi.fn<Queue['queue']>();

    await reenqueueActiveRuns(createRuns(), enqueue, 'test');

    expect(enqueue).toHaveBeenCalledWith('__custom_wkf_workflow_myWorkflow', {
      runId: 'wrun_AAA',
    });
  });

  it('prefers an explicit namespace over WORKFLOW_QUEUE_NAMESPACE', async () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'environment');
    const enqueue = vi.fn<Queue['queue']>();

    await reenqueueActiveRuns(createRuns(), enqueue, 'test', 'explicit');

    expect(enqueue).toHaveBeenCalledWith('__explicit_wkf_workflow_myWorkflow', {
      runId: 'wrun_AAA',
    });
  });
});
