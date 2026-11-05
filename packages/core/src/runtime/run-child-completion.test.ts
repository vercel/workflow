import {
  WorkflowRunCancelledError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dehydrateWorkflowReturnValue } from '../serialization.js';
import { CHILD_RUN_COMPLETION_CONTEXT_KEY } from './child-run-completion.js';
import { notifyParentOfRunCompletion } from './child-run-completion-notify.js';
import { getWorldLazy } from './get-world-lazy.js';
import { Run } from './run.js';
import { cancelRun, cancelRuns } from './runs.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));
vi.mock('./child-run-completion-notify.js', () => ({
  notifyParentOfRunCompletion: vi.fn().mockResolvedValue(undefined),
}));

const RUN_ID = 'wrun_01JB0000000000000000000000';

afterEach(() => {
  vi.clearAllMocks();
});

function useWorld(world: Partial<Record<keyof World, unknown>>) {
  vi.mocked(getWorldLazy).mockResolvedValue(world as unknown as World);
}

describe('Run.readFinishedRunIds (the batched status read)', () => {
  it('reports which runs finished, in input order, reading metadata only', async () => {
    const statuses: Record<string, string> = {
      wrun_a: 'running',
      wrun_b: 'completed',
      wrun_c: 'failed',
      wrun_d: 'cancelled',
      wrun_e: 'pending',
    };
    const get = vi.fn(async (runId: string) => ({
      runId,
      status: statuses[runId],
    }));
    useWorld({ runs: { get } });

    await expect(
      Run.readFinishedRunIds(['wrun_d', 'wrun_a', 'wrun_b', 'wrun_e', 'wrun_c'])
    ).resolves.toEqual(['wrun_d', 'wrun_b', 'wrun_c']);
    for (const call of get.mock.calls) {
      expect(call[1]).toEqual({ resolveData: 'none' });
    }
  });

  it('reports a missing run as finished, so its returnValue surfaces the error', async () => {
    useWorld({
      runs: {
        get: vi.fn().mockRejectedValue(new WorkflowRunNotFoundError(RUN_ID)),
      },
    });
    await expect(Run.readFinishedRunIds([RUN_ID])).resolves.toEqual([RUN_ID]);
  });

  it('fails the step on other read errors, so it retries', async () => {
    useWorld({
      runs: { get: vi.fn().mockRejectedValue(new Error('transport')) },
    });
    await expect(Run.readFinishedRunIds([RUN_ID])).rejects.toThrow('transport');
  });
});

describe('Run.returnValue outside a workflow', () => {
  it('rejects for a cancelled run', async () => {
    useWorld({
      runs: {
        get: vi.fn().mockResolvedValue({ runId: RUN_ID, status: 'cancelled' }),
      },
    });
    await expect(new Run(RUN_ID).returnValue).rejects.toSatisfy(
      WorkflowRunCancelledError.is
    );
  });

  it('polls outside a workflow, even for a handle with a parent', async () => {
    const output = await dehydrateWorkflowReturnValue('v', RUN_ID, undefined);
    useWorld({
      runs: {
        get: vi.fn(async (_runId: string, { resolveData }) =>
          resolveData === 'none'
            ? { runId: RUN_ID, status: 'completed' }
            : { runId: RUN_ID, status: 'completed', output }
        ),
      },
    });

    await expect(
      new Run(RUN_ID, { parentRunId: 'wrun_parent' }).returnValue
    ).resolves.toBe('v');
  });
});

describe('cancellation resumes a waiting parent', () => {
  const stampedRun = {
    runId: RUN_ID,
    specVersion: 2,
    executionContext: { [CHILD_RUN_COMPLETION_CONTEXT_KEY]: 'wrun_parent' },
  };

  it('Run.cancel()', async () => {
    const create = vi.fn().mockResolvedValue({});
    const world = {
      runs: { get: vi.fn().mockResolvedValue(stampedRun) },
      events: { create },
    };
    useWorld(world);

    await new Run(RUN_ID).cancel();

    expect(notifyParentOfRunCompletion).toHaveBeenCalledExactlyOnceWith(
      world,
      stampedRun,
      'cancelled'
    );
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(notifyParentOfRunCompletion).mock.invocationCallOrder[0]
    );
  });

  it('cancelRun()', async () => {
    const world = {
      runs: { get: vi.fn().mockResolvedValue(stampedRun) },
      events: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as World;

    await cancelRun(world, RUN_ID);

    expect(notifyParentOfRunCompletion).toHaveBeenCalledExactlyOnceWith(
      world,
      stampedRun,
      'cancelled'
    );
  });

  it('cancelRuns() via the batch endpoint, for the runs it cancelled', async () => {
    const world = {
      runs: {
        cancelMany: vi.fn().mockResolvedValue({
          summary: {},
          results: [
            { runId: 'wrun_a', outcome: 'cancelled' },
            { runId: 'wrun_b', outcome: 'already_cancelled' },
            { runId: 'wrun_c', outcome: 'cancelled' },
          ],
        }),
      },
    } as unknown as World;

    await cancelRuns(world, ['wrun_a', 'wrun_b', 'wrun_c']);

    expect(
      vi.mocked(notifyParentOfRunCompletion).mock.calls.map((c) => c[1])
    ).toEqual(['wrun_a', 'wrun_c']);
  });
});
