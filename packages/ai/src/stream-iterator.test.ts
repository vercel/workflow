import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iteratorToStream, streamToIterator } from './stream-iterator.js';

describe('iteratorToStream', () => {
  it('should convert an async generator to a ReadableStream', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }

    const stream = iteratorToStream(gen());
    const reader = stream.getReader();

    expect(await reader.read()).toEqual({ value: 1, done: false });
    expect(await reader.read()).toEqual({ value: 2, done: false });
    expect(await reader.read()).toEqual({ value: 3, done: false });
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });

  it('should yield to the macrotask queue between chunks in browser environments', async () => {
    // Simulate browser environment and re-import the module so isBrowser
    // is evaluated as true
    vi.stubGlobal('window', {});
    vi.useFakeTimers();

    const { iteratorToStream: browserIteratorToStream } = await import(
      './stream-iterator.js?browser'
    );

    const values = [1, 2, 3, 4, 5];
    async function* gen() {
      for (const v of values) {
        yield v;
      }
    }

    const stream = browserIteratorToStream(gen());
    const reader = stream.getReader();

    // First read: the generator yields immediately, but after enqueue
    // the pull() awaits a setTimeout(0) before returning.
    const readPromise1 = reader.read();

    // Advance past the setTimeout(0) so pull() can resolve
    await vi.advanceTimersByTimeAsync(0);
    const result1 = await readPromise1;
    expect(result1).toEqual({ value: 1, done: false });

    // Second read also requires a timer tick
    const readPromise2 = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    const result2 = await readPromise2;
    expect(result2).toEqual({ value: 2, done: false });

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should skip macrotask yield in non-browser environments', async () => {
    // In Node.js (test env), window is undefined, so the yield is a no-op.
    // Reads should resolve without needing to advance timers.
    vi.useFakeTimers();

    const values = [1, 2, 3];
    async function* gen() {
      for (const v of values) {
        yield v;
      }
    }

    const stream = iteratorToStream(gen());
    const reader = stream.getReader();

    // Reads resolve without timer advancement since yield is a no-op
    expect(await reader.read()).toEqual({ value: 1, done: false });
    expect(await reader.read()).toEqual({ value: 2, done: false });
    expect(await reader.read()).toEqual({ value: 3, done: false });
    expect(await reader.read()).toEqual({ value: undefined, done: true });

    vi.useRealTimers();
  });

  it('should handle abort signal', async () => {
    const controller = new AbortController();

    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }

    const stream = iteratorToStream(gen(), { signal: controller.signal });
    const reader = stream.getReader();

    const result = await reader.read();
    expect(result).toEqual({ value: 1, done: false });

    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it('should handle already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    async function* gen() {
      yield 1;
    }

    const stream = iteratorToStream(gen(), { signal: controller.signal });
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow();
  });

  it('should propagate generator errors', async () => {
    async function* gen() {
      yield 1;
      throw new Error('generator error');
    }

    const stream = iteratorToStream(gen());
    const reader = stream.getReader();

    const result = await reader.read();
    expect(result).toEqual({ value: 1, done: false });

    await expect(reader.read()).rejects.toThrow('generator error');
  });
});

describe('streamToIterator', () => {
  it('should convert a ReadableStream to an async iterator', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });

    const values: number[] = [];
    for await (const value of streamToIterator(stream)) {
      values.push(value);
    }

    expect(values).toEqual([1, 2, 3]);
  });
});
