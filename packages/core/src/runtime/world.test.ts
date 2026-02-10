import { describe, expect, it, vi } from 'vitest';
import { ensureWorldStarted } from './world.js';

describe('ensureWorldStarted', () => {
  it('should start worlds that expose start() only once per instance', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const world = { start } as any;

    await ensureWorldStarted(world);
    await ensureWorldStarted(world);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('should be a no-op for worlds without start()', async () => {
    const world = {} as any;

    await expect(ensureWorldStarted(world)).resolves.toBeUndefined();
  });

  it('should start different world instances independently', async () => {
    const startA = vi.fn().mockResolvedValue(undefined);
    const startB = vi.fn().mockResolvedValue(undefined);
    const worldA = { start: startA } as any;
    const worldB = { start: startB } as any;

    await ensureWorldStarted(worldA);
    await ensureWorldStarted(worldB);

    expect(startA).toHaveBeenCalledTimes(1);
    expect(startB).toHaveBeenCalledTimes(1);
  });
});
