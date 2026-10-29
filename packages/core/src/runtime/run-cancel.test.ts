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

describe('Run.cancel against world-local', () => {
  it('cancels an admitted start Hook candidate that never became a run', async () => {
    const { createWorld } = await import('@workflow/world-local');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ulid } = await import('ulid');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wf-cancel-'));
    const world = createWorld({ dataDir });
    try {
      const runId = `wrun_${ulid()}`;
      const creation = {
        deploymentId: 'dpl_local',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        startHook: { token: `cancel-${runId}` },
      };
      await world.events.create(runId, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: creation,
      } as never);
      // The writer died after the admission's claim, before its run record.
      await rm(path.join(dataDir, 'runs', `${runId}.json`));
      vi.mocked(getWorldLazy).mockResolvedValue(world as unknown as World);

      await new Run(runId).cancel();

      // Fenced: neither copy can create it any more.
      const started = await world.events
        .create(runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: creation,
        } as never)
        .catch((e: unknown) => e);
      expect(started).toBeInstanceOf(Error);
      expect(WorkflowRunNotFoundError.is(started)).toBe(false);
    } finally {
      await world.close?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
