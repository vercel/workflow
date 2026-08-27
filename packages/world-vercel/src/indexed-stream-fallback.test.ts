import { describe, expect, it, vi } from 'vitest';
import { createIndexedStreamFallback } from './indexed-stream-fallback.js';

async function readAll(stream: ReadableStream<Uint8Array>) {
  const values: Uint8Array[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe('indexed HTTP stream fallback', () => {
  it('starts at an absolute index then follows opaque cursors', async () => {
    const getChunks = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ index: 4, data: new Uint8Array([4]) }],
        cursor: 'opaque',
        hasMore: true,
        done: false,
      })
      .mockResolvedValueOnce({
        data: [{ index: 5, data: new Uint8Array([5]) }],
        cursor: null,
        hasMore: false,
        done: true,
      })
      .mockResolvedValueOnce({
        data: [],
        cursor: null,
        hasMore: false,
        done: true,
      });
    const getInfo = vi.fn().mockResolvedValue({ tailIndex: 5, done: true });

    await expect(
      readAll(createIndexedStreamFallback(4, { getChunks, getInfo }))
    ).resolves.toEqual([new Uint8Array([4]), new Uint8Array([5])]);
    expect(getChunks).toHaveBeenNthCalledWith(1, {
      limit: 100,
      startIndex: 4,
    });
    expect(getChunks).toHaveBeenNthCalledWith(2, {
      limit: 100,
      cursor: 'opaque',
    });
  });

  it('rejects a gap instead of skipping durable data', async () => {
    const stream = createIndexedStreamFallback(4, {
      getChunks: vi.fn().mockResolvedValue({
        data: [{ index: 5, data: new Uint8Array([5]) }],
        cursor: null,
        hasMore: false,
        done: false,
      }),
      getInfo: vi.fn(),
    });
    await expect(stream.getReader().read()).rejects.toThrow(
      'expected 4, received 5'
    );
  });

  it('polls while caught up and completes only past the terminal tail', async () => {
    const getChunks = vi
      .fn()
      .mockResolvedValueOnce({
        data: [],
        cursor: null,
        hasMore: false,
        done: false,
      })
      .mockResolvedValueOnce({
        data: [],
        cursor: null,
        hasMore: false,
        done: true,
      });
    const getInfo = vi
      .fn()
      .mockResolvedValueOnce({ tailIndex: 3, done: false })
      .mockResolvedValueOnce({ tailIndex: 3, done: true });

    const result = await createIndexedStreamFallback(4, {
      getChunks,
      getInfo,
    })
      .getReader()
      .read();
    expect(result).toEqual({ done: true, value: undefined });
    expect(getChunks).toHaveBeenCalledTimes(2);
  });

  it('cancellation interrupts caught-up polling', async () => {
    const stream = createIndexedStreamFallback(4, {
      getChunks: vi.fn().mockResolvedValue({
        data: [],
        cursor: null,
        hasMore: false,
        done: false,
      }),
      getInfo: vi.fn().mockResolvedValue({ tailIndex: 3, done: false }),
    });
    const reader = stream.getReader();
    const reading = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reader.cancel();
    await expect(reading).resolves.toEqual({ done: true, value: undefined });
  });
});
