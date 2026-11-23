import { afterEach, describe, expect, it } from 'vitest';
import { createFlushableState, flushablePipe } from './flushable-stream.js';
import { setWorld } from './runtime/world.js';
import { getExternalRevivers } from './serialization.js';

/**
 * Settles with the outcome of `promise`, or with `'pending'` when it is still
 * unsettled after `ms`. A consumer left waiting on a stream nobody will ever
 * end shows up as `'pending'` instead of as a test that runs to its deadline.
 */
function outcome(promise: Promise<unknown>, ms = 1_000): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (err) => `rejected: ${(err as Error)?.message ?? err}`
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

describe('flushablePipe source errors', () => {
  it('errors the consumer of a transform sink when the source fails', async () => {
    const source = new ReadableStream<string>({
      pull(controller) {
        controller.error(new Error('source failed'));
      },
    });
    const transform = new TransformStream<string, string>();
    const state = createFlushableState();

    const pipe = flushablePipe(source, transform.writable, state);
    pipe.catch(() => {});

    const reader = transform.readable.getReader();
    expect(await outcome(reader.read())).toBe('rejected: source failed');
    await expect(state.promise).rejects.toThrow('source failed');
    await expect(pipe).rejects.toThrow('source failed');
  });

  it('errors the consumer when the source fails after delivering chunks', async () => {
    let pulls = 0;
    const source = new ReadableStream<string>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue('a');
        else controller.error(new Error('source failed'));
      },
    });
    const transform = new TransformStream<string, string>();
    const state = createFlushableState();
    flushablePipe(source, transform.writable, state).catch(() => {});

    const reader = transform.readable.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: 'a' });
    expect(await outcome(reader.read())).toBe('rejected: source failed');
  });

  it('aborts a plain sink with the source error', async () => {
    let aborted: unknown;
    const sink = new WritableStream<string>({
      abort(reason) {
        aborted = reason;
      },
    });
    const error = new Error('source failed');
    const source = new ReadableStream<string>({
      pull(controller) {
        controller.error(error);
      },
    });
    const state = createFlushableState();

    await expect(flushablePipe(source, sink, state)).rejects.toThrow(
      'source failed'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(error);
  });

  it('still rejects with the sink error when the sink is what failed', async () => {
    const { readable, writable } = new TransformStream<string, string>();
    const sink = new WritableStream<string>({
      write: () => Promise.reject(new Error('sink failed')),
    });
    const state = createFlushableState();
    const pipe = flushablePipe(readable, sink, state);
    pipe.catch(() => {});

    const writer = writable.getWriter();
    writer.write('a').catch(() => {});

    await expect(state.promise).rejects.toThrow('sink failed');
    await expect(pipe).rejects.toThrow('sink failed');
  });
});

describe('reading a run stream whose world read fails', () => {
  afterEach(() => {
    setWorld(undefined);
  });

  const readFromFailingWorld = (
    value: Parameters<
      ReturnType<typeof getExternalRevivers>['ReadableStream']
    >[0]
  ) => {
    setWorld({
      readFromStream: async () => {
        throw new TypeError('world read failed');
      },
    } as any);
    const ops: Promise<unknown>[] = [];
    const stream = getExternalRevivers(
      globalThis,
      ops,
      'wrun_test',
      undefined
    ).ReadableStream(value) as ReadableStream<unknown>;
    for (const op of ops) op.catch(() => {});
    return stream.getReader();
  };

  // A negative `startIndex` takes the single-shot path, which has no
  // reconnect loop between the world and the pipe.
  it('rejects the read of an object stream instead of leaving it pending', async () => {
    const reader = readFromFailingWorld({ name: 's1', startIndex: -1 });
    expect(await outcome(reader.read())).toBe('rejected: world read failed');
  });

  it('rejects the read of a byte stream instead of leaving it pending', async () => {
    const reader = readFromFailingWorld({
      name: 's1',
      type: 'bytes',
      startIndex: -1,
    });
    expect(await outcome(reader.read())).toBe('rejected: world read failed');
  });
});
