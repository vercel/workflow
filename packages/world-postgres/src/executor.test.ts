import { describe, expect, it, vi } from 'vitest';
import { executeWithInputs } from './executor.js';

function source<T>(items: T[]): AsyncIterableIterator<T> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      const value = items.shift();
      return value === undefined
        ? { done: true, value: undefined }
        : { done: false, value };
    },
    async return() {
      return { done: true, value: undefined };
    },
  };
}

describe('World-owned input delivery', () => {
  it('stores a handler-returned value while normal execution is still pending', async () => {
    const active = Promise.withResolvers<void>();
    const result = { timeoutSeconds: 123, value: 'invocation data' };
    const handler = vi.fn(async () => result);
    const store = vi.fn(async () => {
      active.resolve();
    });
    const run = executeWithInputs(
      source([{ id: 'one', payload: {} }]),
      () => active.promise,
      async (row) => {
        await store(await handler(row));
      }
    );
    await run;
    expect(store).toHaveBeenCalledExactlyOnceWith(result);
  });

  it('propagates response storage failure instead of reporting delivery success', async () => {
    const error = new Error('response write failed');
    const eventWrite = vi.fn().mockResolvedValue(undefined);
    await expect(
      executeWithInputs(
        source([1]),
        async () => {},
        async () => {
          await eventWrite();
          throw error;
        }
      )
    ).rejects.toBe(error);
    expect(eventWrite).toHaveBeenCalledOnce();
  });

  it('finishes an in-flight input before returning the executor result', async () => {
    const commit = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let returned = false;
    let committed = false;
    const execute = vi.fn(async () => committed);
    const run = executeWithInputs(source([1]), execute, async () => {
      entered.resolve();
      await commit.promise;
      committed = true;
    }).then((result) => {
      expect(result).toBe(true);
      returned = true;
    });
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(returned).toBe(false);
    commit.resolve();
    await run;
    expect(returned).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('replays after an in-flight delivery settles beyond the execution deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    let committed = false;
    const execute = vi.fn(async () => {
      await entered.promise;
      now.mockReturnValue(120_001);
      return committed;
    });
    try {
      const run = executeWithInputs(source([1]), execute, async () => {
        entered.resolve();
        await commit.promise;
        committed = true;
      });
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(execute).toHaveBeenCalledOnce();
      commit.resolve();
      await expect(run).resolves.toBe(true);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('does not acknowledge when the final replay fails', async () => {
    const commit = Promise.withResolvers<void>();
    const error = new Error('final replay failed');
    const execute = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(error);
    const run = executeWithInputs(source([1]), execute, () => commit.promise);
    const failed = expect(run).rejects.toBe(error);
    await new Promise((resolve) => setTimeout(resolve, 150));
    commit.resolve();
    await failed;
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
