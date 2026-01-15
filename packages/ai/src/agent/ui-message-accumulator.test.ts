import type { UIMessageChunk } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { UIMessageAccumulator } from './ui-message-accumulator.js';

describe('UIMessageAccumulator', () => {
  it('should forward chunks to the original writable stream', async () => {
    const writtenChunks: UIMessageChunk[] = [];
    const originalWritable = new WritableStream<UIMessageChunk>({
      write: (chunk) => {
        writtenChunks.push(chunk);
      },
    });

    const accumulator = new UIMessageAccumulator(originalWritable);
    const writer = accumulator.writable.getWriter();

    const chunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Hello' },
      { type: 'text-delta', id: 'text-1', delta: ' world' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish-step' },
      { type: 'finish' },
    ];

    for (const chunk of chunks) {
      await writer.write(chunk);
    }
    await writer.close();

    // Wait for pipe to flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writtenChunks).toEqual(chunks);
  });

  it('should collect chunks and return them via getChunks()', async () => {
    const originalWritable = new WritableStream<UIMessageChunk>({
      write: vi.fn(),
    });

    const accumulator = new UIMessageAccumulator(originalWritable);
    const writer = accumulator.writable.getWriter();

    const chunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Hello' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish' },
    ];

    for (const chunk of chunks) {
      await writer.write(chunk);
    }
    await writer.close();

    expect(accumulator.getChunks()).toEqual(chunks);
  });

  it('should return a copy of chunks array (not the original)', async () => {
    const originalWritable = new WritableStream<UIMessageChunk>({
      write: vi.fn(),
    });

    const accumulator = new UIMessageAccumulator(originalWritable);
    const writer = accumulator.writable.getWriter();

    await writer.write({ type: 'start' });
    await writer.close();

    const chunks1 = accumulator.getChunks();
    const chunks2 = accumulator.getChunks();

    // Should return different array instances
    expect(chunks1).not.toBe(chunks2);
    // But with same content
    expect(chunks1).toEqual(chunks2);
  });

  it('should return empty array when no chunks collected', async () => {
    const originalWritable = new WritableStream<UIMessageChunk>({
      write: vi.fn(),
    });

    const accumulator = new UIMessageAccumulator(originalWritable);
    const chunks = accumulator.getChunks();

    expect(chunks).toEqual([]);
  });

  it('should forward abort to the original writable', async () => {
    const abortFn = vi.fn();
    const originalWritable = new WritableStream<UIMessageChunk>({
      write: vi.fn(),
      abort: abortFn,
    });

    const accumulator = new UIMessageAccumulator(originalWritable);
    const reason = new Error('test abort');

    await accumulator.writable.abort(reason);

    expect(abortFn).toHaveBeenCalledWith(reason);
  });

  it('should not close original writable when accumulator writable is closed', async () => {
    const closeFn = vi.fn();
    const originalWritable = new WritableStream<UIMessageChunk>({
      write: vi.fn(),
      close: closeFn,
    });

    const accumulator = new UIMessageAccumulator(originalWritable);
    const writer = accumulator.writable.getWriter();

    await writer.write({ type: 'start' });
    await writer.close();

    // Original writable should NOT be closed - that's handled by the caller
    expect(closeFn).not.toHaveBeenCalled();
  });
});
