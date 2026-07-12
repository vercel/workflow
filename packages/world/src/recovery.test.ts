import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from './interfaces.js';
import type { Queue } from './queue.js';
import { reenqueueActiveRuns } from './recovery.js';

function createRunsStub(workflowNames: string[]): Storage['runs'] {
  return {
    list: vi.fn(async (params: { status?: string }) => ({
      data:
        params.status === 'pending'
          ? workflowNames.map((workflowName, i) => ({
              runId: `wrun_${i}`,
              workflowName,
            }))
          : [],
      hasMore: false,
      cursor: null,
    })),
  } as unknown as Storage['runs'];
}

function createEnqueueSpy() {
  const calls: Array<{ queueName: string; runId: string }> = [];
  const enqueue = vi.fn(async (queueName: string, payload: unknown) => {
    calls.push({
      queueName,
      runId: (payload as { runId: string }).runId,
    });
    return { messageId: `msg_${calls.length}` };
  }) as unknown as Queue['queue'];
  return { enqueue, calls };
}

describe('reenqueueActiveRuns', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('enqueues to the default un-namespaced queue when no namespace is set', async () => {
    const { enqueue, calls } = createEnqueueSpy();
    await reenqueueActiveRuns(
      createRunsStub(['workflow//eve//workflowEntry']),
      enqueue,
      'world-test'
    );
    expect(calls).toEqual([
      {
        queueName: '__wkf_workflow_workflow//eve//workflowEntry',
        runId: 'wrun_0',
      },
    ]);
  });

  it('honors WORKFLOW_QUEUE_NAMESPACE so recovered runs target the same queues as live enqueues', async () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'eve657665');
    const { enqueue, calls } = createEnqueueSpy();
    await reenqueueActiveRuns(
      createRunsStub(['workflow//eve//workflowEntry']),
      enqueue,
      'world-test'
    );
    expect(calls).toEqual([
      {
        queueName: '__eve657665_wkf_workflow_workflow//eve//workflowEntry',
        runId: 'wrun_0',
      },
    ]);
  });

  it('prefers an explicit namespace argument over the environment', async () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'fromenv');
    const { enqueue, calls } = createEnqueueSpy();
    await reenqueueActiveRuns(
      createRunsStub(['my-workflow']),
      enqueue,
      'world-test',
      'explicit'
    );
    expect(calls).toEqual([
      { queueName: '__explicit_wkf_workflow_my-workflow', runId: 'wrun_0' },
    ]);
  });
});
