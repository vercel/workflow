import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_POLL_INTERVAL_MS } from '../flushable-stream.js';

vi.mock('../runtime/world.js', () => ({
  getWorld: vi.fn(),
}));

describe('step-level getWritable', () => {
  beforeEach(async () => {
    const mockWorld = {
      writeToStream: vi.fn().mockResolvedValue(undefined),
      writeToStreamMulti: vi.fn().mockResolvedValue(undefined),
      closeStream: vi.fn().mockResolvedValue(undefined),
    };

    const { getWorld } = await import('../runtime/world.js');
    (getWorld as ReturnType<typeof vi.fn>).mockReturnValue(mockWorld);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ops promise should resolve when writer lock is released (without closing stream)', async () => {
    const { contextStorage } = await import('./context-storage.js');

    const ops: Promise<void>[] = [];
    const ctx = {
      stepMetadata: {
        stepName: 'test-step',
        stepId: 'step_001',
        stepStartedAt: new Date(),
        attempt: 1,
      },
      workflowMetadata: {
        workflowName: 'test-workflow',
        workflowRunId: 'wrun_test123',
        workflowStartedAt: new Date(),
        url: 'http://localhost:3000',
        features: { encryption: false },
      },
      ops,
      encryptionKey: undefined,
    };

    const writable = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return getWritable<string>();
    });

    // Simulate user pattern: write data, then release lock
    const writer = writable.getWriter();
    await writer.write('hello');
    await writer.write('world');
    writer.releaseLock();

    // Without the fix (.pipeTo()), this hangs because pipeTo only resolves on stream close.
    // With flushablePipe + pollWritableLock, it resolves once the lock is released.
    await expect(
      Promise.race([
        Promise.all(ops),
        new Promise((_, r) =>
          setTimeout(
            () => r(new Error('ops did not resolve after releaseLock')),
            LOCK_POLL_INTERVAL_MS * 5 + 200
          )
        ),
      ])
    ).resolves.not.toThrow();
  });

  it('ops promise should resolve when stream is explicitly closed', async () => {
    const { contextStorage } = await import('./context-storage.js');

    const ops: Promise<void>[] = [];
    const ctx = {
      stepMetadata: {
        stepName: 'test-step',
        stepId: 'step_001',
        stepStartedAt: new Date(),
        attempt: 1,
      },
      workflowMetadata: {
        workflowName: 'test-workflow',
        workflowRunId: 'wrun_test123',
        workflowStartedAt: new Date(),
        url: 'http://localhost:3000',
        features: { encryption: false },
      },
      ops,
      encryptionKey: undefined,
    };

    const writable = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return getWritable<string>();
    });

    const writer = writable.getWriter();
    await writer.write('data');
    await writer.close();

    await expect(
      Promise.race([
        Promise.all(ops),
        new Promise((_, r) =>
          setTimeout(
            () => r(new Error('ops did not resolve after close')),
            LOCK_POLL_INTERVAL_MS * 5 + 200
          )
        ),
      ])
    ).resolves.not.toThrow();
  });
});
