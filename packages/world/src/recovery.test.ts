import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from './interfaces.js';
import type { Queue } from './queue.js';
import { reenqueueActiveRuns } from './recovery.js';

function createRuns(): Storage['runs'] {
  return {
    list: vi.fn(async ({ status }) => {
      const statuses = Array.isArray(status)
        ? status
        : status
          ? [status]
          : [];
      return {
        data: statuses.includes('pending')
          ? [
              {
                runId: 'wrun_AAA',
                workflowName: 'myWorkflow',
                status: 'pending',
              },
            ]
          : [],
        hasMore: false,
        cursor: null,
      };
    }),
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

  it("issues a single list call over ['pending', 'running'] (not one per status)", async () => {
    const runs = createRuns();
    const enqueue = vi.fn<Queue['queue']>();

    await reenqueueActiveRuns(runs, enqueue, 'test');

    // Prior implementation looped over ['pending', 'running'] and called
    // list() once per status. The array-status refactor collapses that
    // to a single call — the world does the fan-out server-side.
    expect(runs.list).toHaveBeenCalledTimes(1);
    expect(runs.list).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ['pending', 'running'],
      })
    );
  });
});
