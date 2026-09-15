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
    const run = executeWithInputs(
      source([1]),
      async () => {},
      async () => {
        entered.resolve();
        await commit.promise;
      }
    ).then(() => {
      returned = true;
    });
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(returned).toBe(false);
    commit.resolve();
    await run;
    expect(returned).toBe(true);
  });
});
