import {
  START_HOOK_CANDIDATE_CANCELLED,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorldLazy } from './get-world-lazy.js';
import { Run } from './run.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));

const RUN_ID = 'wrun_01JB0000000000000000000000';

afterEach(() => {
  vi.clearAllMocks();
});

describe('Run.cancel', () => {
  it("stamps run_cancelled with the run's spec version", async () => {
    // The caller is often not the run's executor; a runtime built against a
    // lower spec version rejects an event stamped above what it supports.
    const get = vi.fn().mockResolvedValue({ runId: RUN_ID, specVersion: 2 });
    const create = vi.fn().mockResolvedValue({});
    vi.mocked(getWorldLazy).mockResolvedValue({
      runs: { get },
      events: { create },
    } as unknown as World);

    await new Run(RUN_ID).cancel({ cancelReason: 'test' });

    expect(get).toHaveBeenCalledWith(RUN_ID, { resolveData: 'none' });
    expect(create).toHaveBeenCalledExactlyOnceWith(RUN_ID, {
      eventType: 'run_cancelled',
      specVersion: 2,
      eventData: { cancelReason: 'test' },
    });
  });

  it('posts run_cancelled for a run that does not exist, and succeeds once the World fenced the candidate', async () => {
    const get = vi.fn().mockRejectedValue(new WorkflowRunNotFoundError(RUN_ID));
    const create = vi.fn().mockRejectedValue(
      new WorkflowWorldError('cancelled before it was created', {
        status: 409,
        code: START_HOOK_CANDIDATE_CANCELLED,
      })
    );
    vi.mocked(getWorldLazy).mockResolvedValue({
      capabilities: { atomicStartHook: { active: true } },
      runs: { get },
      events: { create },
    } as unknown as World);

    await new Run(RUN_ID).cancel();

    expect(create).toHaveBeenCalledExactlyOnceWith(RUN_ID, {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    });
  });

  it('throws WorkflowRunNotFoundError when the World has no such run either', async () => {
    const get = vi.fn().mockRejectedValue(new WorkflowRunNotFoundError(RUN_ID));
    const create = vi
      .fn()
      .mockRejectedValue(new WorkflowRunNotFoundError(RUN_ID));
    vi.mocked(getWorldLazy).mockResolvedValue({
      capabilities: { atomicStartHook: { active: true } },
      runs: { get },
      events: { create },
    } as unknown as World);

    const error = await new Run(RUN_ID).cancel().catch((e: unknown) => e);
    expect(WorkflowRunNotFoundError.is(error)).toBe(true);
  });

  it('posts nothing for a missing run on a World without start Hooks', async () => {
    const get = vi.fn().mockRejectedValue(new WorkflowRunNotFoundError(RUN_ID));
    const create = vi.fn();
    vi.mocked(getWorldLazy).mockResolvedValue({
      runs: { get },
      events: { create },
    } as unknown as World);

    const error = await new Run(RUN_ID).cancel().catch((e: unknown) => e);
    expect(WorkflowRunNotFoundError.is(error)).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});
