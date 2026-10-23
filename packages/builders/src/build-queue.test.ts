import { describe, expect, it, vi } from 'vitest';
import { createBuildQueue } from './build-queue.js';

describe('createBuildQueue', () => {
  it('logs failures and keeps the queue alive by default', async () => {
    const error = new Error('build failed');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const enqueue = createBuildQueue();

      await expect(
        enqueue(async () => {
          throw error;
        })
      ).resolves.toBeUndefined();
      await expect(enqueue(async () => undefined)).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('propagates failures when error swallowing is disabled', async () => {
    const error = new Error('build failed');
    const enqueue = createBuildQueue({ swallowErrors: false });

    await expect(
      enqueue(async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });
});
