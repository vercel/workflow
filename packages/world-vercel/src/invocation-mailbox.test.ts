import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { createInvocationMailbox } from './invocation-mailbox.js';

function fixture() {
  const retained: Promise<unknown>[] = [];
  const errors = vi.fn();
  const mailbox = createInvocationMailbox(
    (work) => retained.push(work),
    errors
  );
  return { mailbox, retained, errors };
}

describe('private invocation mailbox', () => {
  it('preserves each caller context while a shared drain processes queued inputs', async () => {
    const context = new AsyncLocalStorage<string>();
    const { mailbox, retained } = fixture();
    const release = Promise.withResolvers<void>();
    const observed: (string | undefined)[] = [];
    const first = context.run('first', () =>
      mailbox.submit(
        'run',
        'one',
        'one',
        async () => {
          await release.promise;
          observed.push(context.getStore());
        },
        async () => {}
      )
    );
    const second = context.run('second', () =>
      mailbox.submit(
        'run',
        'two',
        'two',
        async () => {
          observed.push(context.getStore());
        },
        async () => {}
      )
    );
    release.resolve();
    await Promise.all([first, second]);
    await Promise.all(retained);
    expect(observed).toEqual(['first', 'second']);
  });
  it('waits for processing, coalesces concurrent identical inputs, and rejects changed contents', async () => {
    const { mailbox, retained } = fixture();
    const commit = Promise.withResolvers<unknown>();
    const process = vi.fn(() => commit.promise);
    const drive = vi.fn(async () => {});
    const result = mailbox.submit(
      'run',
      'request',
      'fingerprint',
      process,
      drive
    );
    expect(
      mailbox.submit('run', 'request', 'fingerprint', process, drive)
    ).toBe(result);
    expect(() =>
      mailbox.submit('run', 'request', 'changed', process, drive)
    ).toThrow('different contents');
    let done = false;
    void result.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(drive).not.toHaveBeenCalled();
    commit.resolve({ accepted: true });
    await expect(result).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    });
    await Promise.all(retained);
    expect(process).toHaveBeenCalledOnce();
    expect(drive).toHaveBeenCalledOnce();
  });

  it('processes a self-hook while execution is blocked, then replays its committed input', async () => {
    const { mailbox, retained } = fixture();
    const step = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let committed = false;
    const drive = vi.fn(async () => {
      const snapshot = committed;
      entered.resolve();
      await step.promise;
      return snapshot;
    });
    const running = mailbox.execute('run', drive);
    await entered.promise;
    const input = mailbox.submit(
      'run',
      'hook',
      'bytes',
      async () => {
        committed = true;
        return 'accepted';
      },
      drive
    );
    await expect(input).resolves.toEqual({ ok: true, value: 'accepted' });
    expect(drive).toHaveBeenCalledOnce();
    step.resolve();
    await expect(running).resolves.toBe(true);
    await Promise.all(retained);
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it('starts a new execution for an input arriving as the previous driver exits', async () => {
    const { mailbox, retained } = fixture();
    const finish = Promise.withResolvers<void>();
    const drive = vi.fn(async () => finish.promise);
    const first = mailbox.execute('run', drive);
    await Promise.resolve();
    finish.resolve();
    await first;
    await mailbox.submit('run', 'input', 'bytes', async () => 'done', drive);
    await Promise.all(retained);
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it('serializes input handling, recovers from a handler error, and releases idle run state', async () => {
    const { mailbox, retained } = fixture();
    const first = Promise.withResolvers<void>();
    const order: number[] = [];
    const drive = async () => {};
    const a = mailbox.submit(
      'run',
      'a',
      'a',
      async () => {
        order.push(1);
        await first.promise;
        throw new Error('input error');
      },
      drive
    );
    const b = mailbox.submit(
      'run',
      'b',
      'b',
      async () => {
        order.push(2);
        return 2;
      },
      drive
    );
    expect(order).toEqual([1]);
    first.resolve();
    await expect(a).resolves.toMatchObject({
      ok: false,
      error: { message: 'input error' },
    });
    await expect(b).resolves.toEqual({ ok: true, value: 2 });
    await Promise.all(retained);
    expect(order).toEqual([1, 2]);
    for (let index = 0; index < 70; index++) {
      await mailbox.submit(
        `run-${index}`,
        'input',
        'bytes',
        async () => {},
        drive
      );
      await Promise.all(retained);
    }
  });

  it('bounds pending input admission and reports continuation failures', async () => {
    const { mailbox, retained, errors } = fixture();
    const commit = Promise.withResolvers<void>();
    const drive = async () => {
      throw new Error('replay failed');
    };
    const inputs = Array.from({ length: 32 }, (_, id) =>
      mailbox.submit('run', String(id), String(id), () => commit.promise, drive)
    );
    expect(() =>
      mailbox.submit('run', 'overflow', 'bytes', async () => {}, drive)
    ).toThrow('capacity');
    commit.resolve();
    await Promise.all(inputs);
    await Promise.all(retained);
    expect(errors).toHaveBeenCalled();
  });
});
