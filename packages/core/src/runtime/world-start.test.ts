import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWorldStarted, setWorld } from './world.js';

function makeWorld(start?: () => Promise<void>): World {
  return { specVersion: SPEC_VERSION_CURRENT, start } as unknown as World;
}

describe('ensureWorldStarted', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it('starts the World once across concurrent and repeated calls', async () => {
    const start = vi.fn(async () => {});
    setWorld(makeWorld(start));

    await Promise.all([ensureWorldStarted(), ensureWorldStarted()]);
    await ensureWorldStarted();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits for start() to finish before resolving', async () => {
    let finish!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    setWorld(makeWorld(start));

    let resolved = false;
    const pending = ensureWorldStarted().then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(resolved).toBe(false);

    finish();
    await pending;
    expect(resolved).toBe(true);
  });

  it('starts a World injected later with setWorld()', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    setWorld(makeWorld(first));
    await ensureWorldStarted();
    setWorld(makeWorld(second));
    await ensureWorldStarted();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('logs a failed start instead of rejecting, and retries on the next call', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('database unreachable');
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    setWorld(makeWorld(start));

    await expect(ensureWorldStarted()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);

    await ensureWorldStarted();
    expect(start).toHaveBeenCalledTimes(2);

    await ensureWorldStarted();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('logs a synchronous throw from start() instead of rejecting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('bad config');
    setWorld(
      makeWorld(() => {
        throw failure;
      })
    );

    await expect(ensureWorldStarted()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it('does nothing for a World without start()', async () => {
    setWorld(makeWorld());
    await expect(ensureWorldStarted()).resolves.toBeUndefined();
  });
});
