import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from './interfaces.js';
import type { Queue } from './queue.js';
import { reenqueueActiveRuns } from './recovery.js';

function createRuns(): Storage['runs'] {
  return {
    list: vi.fn(async ({ status }) => {
      const statuses = Array.isArray(status) ? status : status ? [status] : [];
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

  it("re-enqueues a run to the queue namespace it recorded, not this process's", async () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
    const runs = {
      list: vi.fn(async () => ({
        data: [
          // Started by a queue consumer of its own (namespace `agent`).
          {
            runId: 'wrun_OWN',
            workflowName: 'workflow//agent//session',
            status: 'running',
            executionContext: { queueNamespace: 'agent' },
          },
          // Started by the Workflow SDK under another namespace.
          {
            runId: 'wrun_EVE',
            workflowName: 'myWorkflow',
            status: 'running',
            executionContext: { queueNamespace: 'eve' },
          },
          // Recorded nothing (or nothing usable): the default namespace.
          {
            runId: 'wrun_DEF',
            workflowName: 'myWorkflow',
            status: 'pending',
            executionContext: { workflowCoreVersion: '5.0.0' },
          },
          {
            runId: 'wrun_BAD',
            workflowName: 'myWorkflow',
            status: 'pending',
            executionContext: { queueNamespace: 'Not-Valid' },
          },
        ],
        hasMore: false,
        cursor: null,
      })),
    } as unknown as Storage['runs'];
    const enqueue = vi.fn<Queue['queue']>();

    await reenqueueActiveRuns(runs, enqueue, 'test');

    expect(enqueue.mock.calls).toEqual([
      ['__agent_wkf_workflow_workflow//agent//session', { runId: 'wrun_OWN' }],
      ['__eve_wkf_workflow_myWorkflow', { runId: 'wrun_EVE' }],
      ['__wkf_workflow_myWorkflow', { runId: 'wrun_DEF' }],
      ['__wkf_workflow_myWorkflow', { runId: 'wrun_BAD' }],
    ]);
  });

  it('recovers only the runs pinned to the given deployment', async () => {
    const runs = {
      list: vi.fn(async () => ({
        data: [
          {
            runId: 'wrun_OWN',
            workflowName: 'myWorkflow',
            status: 'running',
            deploymentId: 'build_a',
          },
          {
            runId: 'wrun_OTHER',
            workflowName: 'myWorkflow',
            status: 'running',
            deploymentId: 'build_b',
          },
        ],
        hasMore: false,
        cursor: null,
      })),
    } as unknown as Storage['runs'];
    const enqueue = vi.fn<Queue['queue']>();

    await reenqueueActiveRuns(runs, enqueue, 'test', undefined, {
      deploymentId: 'build_a',
    });

    expect(enqueue.mock.calls).toEqual([
      [
        '__wkf_workflow_myWorkflow',
        { runId: 'wrun_OWN' },
        { deploymentId: 'build_a' },
      ],
    ]);
  });

  it('rejects an invalid default namespace before enqueueing anything', async () => {
    const enqueue = vi.fn<Queue['queue']>();

    await expect(
      reenqueueActiveRuns(createRuns(), enqueue, 'test', 'Not-Valid')
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('recovers runs without logging', async () => {
    // Resuming active runs is what a restart is for, so a successful recovery
    // is not news: this printed on every dev-server restart with work in
    // flight.
    vi.stubEnv('DEBUG', '');
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {})
    );

    await reenqueueActiveRuns(createRuns(), vi.fn<Queue['queue']>(), 'test');

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('reports the recovery under DEBUG', async () => {
    vi.stubEnv('DEBUG', 'workflow:*');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await reenqueueActiveRuns(createRuns(), vi.fn<Queue['queue']>(), 'test');

    expect(debugSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toBe(
      '[test] Re-enqueued 1 active run(s) on startup'
    );
    debugSpy.mockRestore();
  });

  it('always reports a run it could not re-enqueue', async () => {
    // The other side of the gate: this one leaves a run unresumed, so it must
    // not need DEBUG to be seen.
    vi.stubEnv('DEBUG', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enqueue = vi
      .fn<Queue['queue']>()
      .mockRejectedValue(new Error('nope'));

    await reenqueueActiveRuns(createRuns(), enqueue, 'test');

    expect(
      warnSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    ).toContain('Failed to re-enqueue run wrun_AAA');
    warnSpy.mockRestore();
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
