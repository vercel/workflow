import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
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
  it('retains metadata through real world-local transitions with payload resolution disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'run-metadata-'));
    try {
      const world = createWorld({ dataDir: dir });
      vi.mocked(getWorldLazy).mockResolvedValue(world);
      const created = await world.events.create(null, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          workflowName: metadata.workflowName,
          deploymentId: 'dpl_test',
          // Deliberately not a valid serialized value: metadata must not hydrate it.
          input: new Uint8Array([1]),
        },
      });
      if (!created.run) throw new Error('expected a created run');
      const runId = created.run.runId;
      const run = new Run(runId);
      await expect(run.workflowName).resolves.toBe(metadata.workflowName);
      await expect(run.createdAt).resolves.toEqual(created.run.createdAt);
      await expect(run.startedAt).resolves.toBeUndefined();
      await expect(run.completedAt).resolves.toBeUndefined();

      const started = await world.events.create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
      expect(started.run?.startedAt).toBeInstanceOf(Date);
      await expect(run.startedAt).resolves.toEqual(started.run?.startedAt);
      await expect(run.completedAt).resolves.toBeUndefined();

      const completed = await world.events.create(runId, {
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { output: new Uint8Array([2]) },
      });
      expect(completed.run?.completedAt).toBeInstanceOf(Date);
      await expect(run.workflowName).resolves.toBe(metadata.workflowName);
      await expect(run.createdAt).resolves.toEqual(created.run.createdAt);
      await expect(run.startedAt).resolves.toEqual(started.run?.startedAt);
      await expect(run.completedAt).resolves.toEqual(
        completed.run?.completedAt
      );
      const filtered = await world.runs.get(runId, { resolveData: 'none' });
      expect(filtered.input).toBeUndefined();
      expect(filtered.output).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
