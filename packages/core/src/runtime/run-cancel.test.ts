import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorldLazy } from './get-world-lazy.js';
import { wakeLockGrantees } from './lock-wakes.js';
import { Run } from './run.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));
vi.mock('./lock-wakes.js', () => ({ wakeLockGrantees: vi.fn() }));

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

  it("wakes the runs the cancelled run's lock reclaim handed slots to", async () => {
    const lockHandoffs = [
      {
        key: 'k',
        runId: 'wrun_next',
        correlationId: 'lock_1',
        grantedAt: new Date(),
      },
    ];
    const world = {
      runs: { get: vi.fn().mockResolvedValue({ specVersion: 2 }) },
      events: { create: vi.fn().mockResolvedValue({ lockHandoffs }) },
    } as unknown as World;
    vi.mocked(getWorldLazy).mockResolvedValue(world);

    await new Run(RUN_ID).cancel();

    expect(wakeLockGrantees).toHaveBeenCalledExactlyOnceWith(
      world,
      lockHandoffs,
      { runId: RUN_ID }
    );
  });
});
