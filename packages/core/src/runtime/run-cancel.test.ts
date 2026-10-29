import {
  START_HOOK_CANDIDATE_CANCELLED,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorldLazy } from './get-world-lazy.js';
import { Run } from './run.js';
import { cancelRun } from './runs.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));

const RUN_ID = 'wrun_01JB0000000000000000000000';

afterEach(() => {
  vi.clearAllMocks();
});

function mockWorld(specVersion: number | undefined) {
  const get = vi.fn().mockResolvedValue({
    runId: RUN_ID,
    specVersion,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
  });
  const create = vi.fn().mockResolvedValue({});
  const queue = vi.fn().mockResolvedValue({ messageId: null });
  const world = {
    runs: { get },
    events: { create },
    queue,
  } as unknown as World;
  vi.mocked(getWorldLazy).mockResolvedValue(world);
  return { world, get, create, queue };
}

const SPEC_8 = SPEC_VERSION_SINGLE_ORCHESTRATOR - 1;

describe('Run.cancel', () => {
  // The caller is often not the run's executor; a runtime built against a
  // lower spec version rejects an event stamped above what it supports.
  it("writes run_cancelled at the run's spec version, as before, on a spec 8 run", async () => {
    const { get, create, queue } = mockWorld(SPEC_8);

    await new Run(RUN_ID).cancel({ cancelReason: 'test' });

    expect(get).toHaveBeenCalledWith(RUN_ID, { resolveData: 'none' });
    // No write classification and no wake: the run's next delivery reads it.
    expect(create).toHaveBeenCalledExactlyOnceWith(RUN_ID, {
      eventType: 'run_cancelled',
      specVersion: SPEC_8,
      eventData: { cancelReason: 'test' },
    });
    expect(queue).not.toHaveBeenCalled();
  });

  it('writes run_cancelled out-of-band and wakes a single-orchestrator run', async () => {
    const { create, queue } = mockWorld(SPEC_VERSION_SINGLE_ORCHESTRATOR);

    await new Run(RUN_ID).cancel();

    expect(create).toHaveBeenCalledExactlyOnceWith(
      RUN_ID,
      {
        eventType: 'run_cancelled',
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      },
      { inBand: false }
    );
    // The orchestrator is woken without an idempotency key.
    expect(queue).toHaveBeenCalledOnce();
    expect(queue.mock.calls[0]?.[1]).toMatchObject({ runId: RUN_ID });
    expect(queue.mock.calls[0]?.[2]).not.toHaveProperty('idempotencyKey');
  });
});

describe('cancelRun', () => {
  it.each([
    ['spec 8', SPEC_8],
    ['unversioned', undefined],
  ])('writes run_cancelled as before and sends nothing on a %s run', async (_label, specVersion) => {
    const { world, create, queue } = mockWorld(specVersion);

    await cancelRun(world, RUN_ID, { cancelReason: 'test' });

    const expectedVersion = specVersion ?? SPEC_VERSION_LEGACY;
    expect(create).toHaveBeenCalledExactlyOnceWith(
      RUN_ID,
      {
        eventType: 'run_cancelled',
        specVersion: expectedVersion,
        eventData: { cancelReason: 'test' },
      },
      { v1Compat: expect.any(Boolean) }
    );
    expect(queue).not.toHaveBeenCalled();
  });

  it('writes run_cancelled out-of-band and wakes a single-orchestrator run', async () => {
    const { world, create, queue } = mockWorld(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );

    await cancelRun(world, RUN_ID);

    expect(create.mock.calls[0]?.[2]).toEqual({
      v1Compat: false,
      inBand: false,
    });
    expect(queue).toHaveBeenCalledOnce();
    expect(queue.mock.calls[0]?.[1]).toMatchObject({
      runId: RUN_ID,
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
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
