import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorldLazy } from './get-world-lazy.js';
import { Run } from './run.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));

const RUN_ID = 'wrun_01JB0000000000000000000000';
const metadata = {
  workflowName: 'test-workflow',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  startedAt: new Date('2026-01-01T00:00:01Z'),
  completedAt: new Date('2026-01-01T00:00:02Z'),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('Run metadata getters', () => {
  it.each([
    'workflowName',
    'createdAt',
    'startedAt',
    'completedAt',
  ] as const)('returns %s without resolving payloads', async (property) => {
    const get = vi.fn().mockResolvedValue(metadata);
    vi.mocked(getWorldLazy).mockResolvedValue({
      runs: { get },
    } as unknown as World);

    await expect(new Run(RUN_ID)[property]).resolves.toBe(metadata[property]);

    expect(get).toHaveBeenCalledExactlyOnceWith(RUN_ID, {
      resolveData: 'none',
    });
  });

  it.each([
    'startedAt',
    'completedAt',
  ] as const)('returns undefined when %s is missing without resolving payloads', async (property) => {
    const get = vi.fn().mockResolvedValue({});
    vi.mocked(getWorldLazy).mockResolvedValue({
      runs: { get },
    } as unknown as World);

    await expect(new Run(RUN_ID)[property]).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledExactlyOnceWith(RUN_ID, {
      resolveData: 'none',
    });
  });
});
