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
});
