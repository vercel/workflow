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

  it('goes on to the inputs waiting behind one whose delivery outlasts the idle window', async () => {
    // Two inputs are in the mailbox when the job starts, and delivering the
    // first takes longer than the idle window after an execution. This job
    // can be the only wake the second input has, so it must not end with
    // the second undelivered.
    const firstEntered = Promise.withResolvers<void>();
    const firstCommit = Promise.withResolvers<void>();
    const delivered: number[] = [];
    const execute = vi.fn(async () => delivered.length);
    const run = executeWithInputs(source([1, 2]), execute, async (input) => {
      if (input === 1) {
        firstEntered.resolve();
        await firstCommit.promise;
      }
      delivered.push(input);
    });
    await firstEntered.promise;
    // Longer than the idle window, with the first delivery still in flight.
    await new Promise((resolve) => setTimeout(resolve, 150));
    firstCommit.resolve();
    // The last execution ran after both inputs were delivered.
    await expect(run).resolves.toBe(2);
    expect(delivered).toEqual([1, 2]);
  });

  it('runs afterIntake once intake has stopped, before it returns', async () => {
    let intakeStopped = false;
    const inputs = source([1]);
    const stop = inputs.return?.bind(inputs);
    inputs.return = async () => {
      intakeStopped = true;
      return stop ? stop() : { done: true, value: undefined };
    };
    const order: string[] = [];
    const afterIntake = vi.fn(async () => {
      order.push(`afterIntake:${intakeStopped}`);
    });
    await executeWithInputs(
      inputs,
      async () => {
        order.push('execute');
      },
      async () => {
        order.push('deliver');
      },
      afterIntake
    );
    expect(afterIntake).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe('afterIntake:true');
    expect(order).toContain('deliver');
  });

  it('runs afterIntake when the source hands over an input as intake stops', async () => {
    // The input is taken from the source and not delivered: the caller's
    // afterIntake is where it is found again and given a wake.
    const handedOver = Promise.withResolvers<IteratorResult<number>>();
    const late: AsyncIterableIterator<number> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => handedOver.promise,
      async return() {
        handedOver.resolve({ done: false, value: 1 });
        return { done: true, value: undefined };
      },
    };
    const deliver = vi.fn(async () => {});
    const afterIntake = vi.fn(async () => {});
    await executeWithInputs(late, async () => {}, deliver, afterIntake);
    expect(deliver).not.toHaveBeenCalled();
    expect(afterIntake).toHaveBeenCalledOnce();
  });

  it('does not run afterIntake when the job fails', async () => {
    const error = new Error('execution failed');
    const afterIntake = vi.fn(async () => {});
    await expect(
      executeWithInputs(
        source<number>([]),
        async () => {
          throw error;
        },
        async () => {},
        afterIntake
      )
    ).rejects.toBe(error);
    // The job is retried, and its next delivery reads the mailbox again.
    expect(afterIntake).not.toHaveBeenCalled();
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
