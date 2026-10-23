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

describe('Run.readReturnValue (the step behind returnValue)', () => {
  it('reports a running run as not done without waiting', async () => {
    const get = vi.fn().mockResolvedValue({ runId: RUN_ID, status: 'running' });
    useWorld({ runs: { get } });

    await expect(new Run(RUN_ID).readReturnValue(false)).resolves.toEqual({
      done: false,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith(RUN_ID, {
      resolveData: 'none',
    });
  });

  it('returns the value of a completed run', async () => {
    const output = await dehydrateWorkflowReturnValue(
      { answer: 42 },
      RUN_ID,
      undefined
    );
    const get = vi.fn(async (_runId: string, { resolveData }) =>
      resolveData === 'none'
        ? { runId: RUN_ID, status: 'completed' }
        : { runId: RUN_ID, status: 'completed', output }
    );
    useWorld({ runs: { get } });

    await expect(new Run(RUN_ID).readReturnValue(false)).resolves.toEqual({
      done: true,
      value: { answer: 42 },
    });
  });

  it('rejects for a cancelled run, as returnValue does', async () => {
    useWorld({
      runs: {
        get: vi.fn().mockResolvedValue({ runId: RUN_ID, status: 'cancelled' }),
      },
    });

    await expect(new Run(RUN_ID).readReturnValue(false)).rejects.toSatisfy(
      WorkflowRunCancelledError.is
    );
  });

  it('treats a not-yet-created resilient start as not done', async () => {
    useWorld({
      runs: {
        get: vi.fn().mockRejectedValue(new WorkflowRunNotFoundError(RUN_ID)),
      },
    });

    await expect(
      new Run(RUN_ID, { resilientStart: true }).readReturnValue(false)
    ).resolves.toEqual({ done: false });
    await expect(new Run(RUN_ID).readReturnValue(false)).rejects.toSatisfy(
      WorkflowRunNotFoundError.is
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
    executionContext: { [CHILD_RUN_COMPLETION_CONTEXT_KEY]: true },
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
