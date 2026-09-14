import { HookNotFoundError } from '@workflow/errors';
import type { Invocation, World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { handleInvocation, InvocationPump } from './invocations.js';

function fixture() {
  const create = vi.fn().mockResolvedValue({});
  const getHook = vi
    .fn()
    .mockResolvedValue({ hookId: 'h', token: 't', runId: 'r', specVersion: 7 });
  const world = {
    hooks: { get: getHook },
    runs: { get: vi.fn().mockResolvedValue({ status: 'running' }) },
    events: { create },
  } as unknown as World;
  const input: Invocation = {
    id: 'request',
    payload: {
      type: 'hook_resume',
      version: 1,
      hookId: 'h',
      token: 't',
      payload: new Uint8Array([1, 2]),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
  return { world, input, create, getHook };
}

describe('runner invocation decisions', () => {
  it('does not accept until persistence finishes', async () => {
    const { world, input, create } = fixture();
    let commit!: () => void;
    create.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        })
    );
    const decision = handleInvocation(world, 'r', input);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(input.respond).not.toHaveBeenCalled();
    commit();
    await expect(decision).resolves.toBe(true);
    expect(input.respond).toHaveBeenCalledWith({ status: 'accepted' });
  });

  it('rejects mismatched hook/run identity before writing', async () => {
    const { world, input, create, getHook } = fixture();
    getHook.mockResolvedValue({ runId: 'another-run', token: 't' });
    await expect(handleInvocation(world, 'r', input)).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(input.respond).toHaveBeenCalledWith({
      status: 'rejected',
      code: 'HOOK_NOT_FOUND',
    });
  });

  it('distinguishes a storage lifecycle rejection from infrastructure failure', async () => {
    const { world, input, create } = fixture();
    create.mockRejectedValueOnce(new HookNotFoundError('h'));
    await handleInvocation(world, 'r', input);
    expect(input.respond).toHaveBeenCalledWith({
      status: 'rejected',
      code: 'HOOK_NOT_FOUND',
    });
    vi.mocked(input.respond).mockClear();
    const error = new Error('database unavailable');
    create.mockRejectedValueOnce(error);
    await expect(handleInvocation(world, 'r', input)).rejects.toBe(error);
    expect(input.respond).not.toHaveBeenCalled();
  });

  it('does not turn a failed response write into a rejection after the event committed', async () => {
    const { world, input, create } = fixture();
    const error = new Error('response storage failed');
    vi.mocked(input.respond).mockRejectedValue(error);
    await expect(handleInvocation(world, 'r', input)).rejects.toBe(error);
    expect(create).toHaveBeenCalledOnce();
    expect(input.respond).toHaveBeenCalledExactlyOnceWith({
      status: 'accepted',
    });
  });

  it('rejects unknown input protocols without journaling', async () => {
    const { world, input, create } = fixture();
    input.payload = { type: 'unknown' };
    await handleInvocation(world, 'r', input);
    expect(create).not.toHaveBeenCalled();
    expect(input.respond).toHaveBeenCalledWith({
      status: 'rejected',
      code: 'INVALID_INPUT',
    });
  });

  it('services two inputs sequentially and waits for in-flight persistence on close', async () => {
    const { world, input, create } = fixture();
    const second = { ...input, id: 'second', respond: vi.fn() };
    const inputs = [input, second];
    let stopped = false;
    const source: AsyncIterableIterator<Invocation> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () =>
        inputs.length && !stopped
          ? { done: false, value: inputs.shift()! }
          : { done: true, value: undefined },
      return: async () => {
        stopped = true;
        return { done: true, value: undefined };
      },
    };
    let finishSecond!: () => void;
    create.mockResolvedValueOnce({}).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        })
    );
    const pump = new InvocationPump(source, (item) =>
      handleInvocation(world, 'r', item)
    );
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(pump.revision).toBe(1);
    let closed = false;
    const closing = pump.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finishSecond();
    await closing;
    expect(second.respond).toHaveBeenCalledWith({ status: 'accepted' });
  });
});
