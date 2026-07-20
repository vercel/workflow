import { afterEach, describe, expect, it } from 'vitest';
import {
  createFlushableState,
  flushablePipe,
  LOCK_POLL_INTERVAL_MS,
  pollReadableLock,
  pollWritableLock,
} from './flushable-stream.js';
import { STREAM_WRITE_BATCH_SYMBOL } from './symbols.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A batch-capable mock sink, mirroring the durable batch entry point that
 * `WorkflowServerWritableStream` exposes under `STREAM_WRITE_BATCH_SYMBOL`.
 * `gate` (when provided) lets a test hold a batch write "in flight" so it can
 * enqueue more chunks and observe coalescing.
 */
function makeBatchSink(
  gate?: (call: number, chunks: Uint8Array[]) => Promise<void> | void
) {
  const batches: Uint8Array[][] = [];
  let closed = false;
  let call = 0;
  const sink = new WritableStream<Uint8Array>({
    close() {
      closed = true;
    },
  }) as WritableStream<Uint8Array> & {
    [STREAM_WRITE_BATCH_SYMBOL]: (chunks: Uint8Array[]) => Promise<void>;
  };
  sink[STREAM_WRITE_BATCH_SYMBOL] = async (chunks: Uint8Array[]) => {
    const n = call++;
    batches.push(chunks.slice());
    await gate?.(n, chunks);
  };
  return { sink, batches, isClosed: () => closed };
}

function makeControlledSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { source, controller: () => controller };
}

describe('flushable stream behavior', () => {
  it('does not emit an unhandled rejection before the runtime awaits a failed operation', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const state = createFlushableState();
      state.reject(new Error('Stream write failed'));

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandledRejections).toEqual([]);
      await expect(state.promise).rejects.toThrow('Stream write failed');
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('promise should resolve when writable stream lock is released (polling)', async () => {
    // Test the pattern: user writes, releases lock, polling detects it, promise resolves
    const chunks: string[] = [];
    let streamClosed = false;

    // Create a simple mock for the sink
    const mockSink = new WritableStream<string>({
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        streamClosed = true;
      },
    });

    // Create a TransformStream like we do in getStepRevivers
    const { readable, writable } = new TransformStream<string, string>();
    const state = createFlushableState();

    // Start piping in background
    flushablePipe(readable, mockSink, state).catch(() => {
      // Errors handled via state.reject
    });

    // Start polling for lock release
    pollWritableLock(writable, state);

    // Simulate user interaction - write and release lock
    const userWriter = writable.getWriter();
    await userWriter.write('chunk1');
    await userWriter.write('chunk2');

    // Release lock without closing stream
    userWriter.releaseLock();

    // Wait for pipe to process + polling interval
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS + 50));

    // The promise should resolve
    await expect(
      Promise.race([
        state.promise,
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 400)),
      ])
    ).resolves.toBeUndefined();

    // Chunks should have been written
    expect(chunks).toContain('chunk1');
    expect(chunks).toContain('chunk2');

    // Stream should NOT be closed (user only released lock)
    expect(streamClosed).toBe(false);
  });

  it('promise should resolve when writable stream closes naturally', async () => {
    const chunks: string[] = [];
    let streamClosed = false;

    const mockSink = new WritableStream<string>({
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        streamClosed = true;
      },
    });

    const { readable, writable } = new TransformStream<string, string>();
    const state = createFlushableState();

    // Start piping in background
    flushablePipe(readable, mockSink, state).catch(() => {
      // Errors handled via state.reject
    });

    // Start polling (won't trigger since stream will close first)
    pollWritableLock(writable, state);

    // User writes and then closes the stream
    const userWriter = writable.getWriter();
    await userWriter.write('data');
    await userWriter.close();

    // Wait a tick for the pipe to process
    await new Promise((r) => setTimeout(r, 50));

    // The promise should resolve
    await expect(
      Promise.race([
        state.promise,
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 200)),
      ])
    ).resolves.toBeUndefined();

    // Chunks should have been written
    expect(chunks).toContain('data');

    // Stream should be closed (user closed it)
    expect(streamClosed).toBe(true);
  });

  it('should handle write errors during pipe operations', async () => {
    const chunks: string[] = [];

    // Create a sink that throws on write
    const mockSink = new WritableStream<string>({
      write(chunk) {
        chunks.push(chunk);
        if (chunk === 'error') {
          throw new Error('Write failed');
        }
      },
    });

    const { readable, writable } = new TransformStream<string, string>();
    const state = createFlushableState();

    // Store the flushablePipe promise so we can await it to ensure
    // all internal rejections are handled before the test ends
    const pipePromise = flushablePipe(readable, mockSink, state).catch(() => {
      // Errors handled via state.reject
    });

    pollWritableLock(writable, state);

    // Write data that will cause an error
    const userWriter = writable.getWriter();
    await userWriter.write('chunk1');
    // The write that triggers the error may reject on the userWriter side too
    // since the error propagates back through the transform stream
    await userWriter.write('error').catch(() => {
      // Expected - error propagates back through the transform stream
    });

    // Wait for the pipe promise to settle to ensure all internal
    // promise rejections are handled before the test ends
    await pipePromise;

    // The promise should be rejected
    await expect(state.promise).rejects.toThrow('Write failed');

    // First chunk should have been written before error
    expect(chunks).toContain('chunk1');
  });

  it('should test with pollReadableLock', async () => {
    // Create a readable stream that we can control
    let controller: ReadableStreamDefaultController<string>;
    const source = new ReadableStream<string>({
      start(c) {
        controller = c;
      },
    });

    const chunks: string[] = [];
    const mockSink = new WritableStream<string>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const state = createFlushableState();

    // Start piping in background
    flushablePipe(source, mockSink, state).catch(() => {
      // Errors handled via state.reject
    });

    // Start polling for readable lock release
    pollReadableLock(source, state);

    // Enqueue some data and then close
    controller?.enqueue('data1');
    controller?.enqueue('data2');
    controller?.close();

    // Wait for the pipe to complete
    await new Promise((r) => setTimeout(r, 100));

    // The promise should resolve
    await expect(state.promise).resolves.toBeUndefined();

    // Chunks should have been written
    expect(chunks).toContain('data1');
    expect(chunks).toContain('data2');
  });

  it('should handle concurrent writes correctly', async () => {
    const chunks: string[] = [];

    const mockSink = new WritableStream<string>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const { readable, writable } = new TransformStream<string, string>();
    const state = createFlushableState();

    // Start piping in background
    flushablePipe(readable, mockSink, state).catch(() => {
      // Errors handled via state.reject
    });

    pollWritableLock(writable, state);

    // Perform multiple concurrent writes
    const userWriter = writable.getWriter();
    await Promise.all([
      userWriter.write('chunk1'),
      userWriter.write('chunk2'),
      userWriter.write('chunk3'),
    ]);

    userWriter.releaseLock();

    // Wait for polling to detect lock release
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS + 50));

    // Promise should resolve
    await expect(state.promise).resolves.toBeUndefined();

    // All chunks should be written
    expect(chunks).toHaveLength(3);
    expect(chunks).toContain('chunk1');
    expect(chunks).toContain('chunk2');
    expect(chunks).toContain('chunk3');
  });

  it('should prevent multiple simultaneous polling operations on writable', async () => {
    const { readable, writable } = new TransformStream<string, string>();
    const mockSink = new WritableStream<string>();
    const state = createFlushableState();

    // Start piping in background
    flushablePipe(readable, mockSink, state).catch(() => {});

    // Start polling multiple times
    pollWritableLock(writable, state);
    pollWritableLock(writable, state);
    pollWritableLock(writable, state);

    // Should only have one interval active
    expect(state.writablePollingInterval).toBeDefined();

    // Write and release to clean up
    const userWriter = writable.getWriter();
    await userWriter.write('data');
    userWriter.releaseLock();

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS + 50));
  });

  it('should prevent multiple simultaneous polling operations on readable', async () => {
    let controller: ReadableStreamDefaultController<string>;
    const source = new ReadableStream<string>({
      start(c) {
        controller = c;
      },
    });

    const mockSink = new WritableStream<string>();
    const state = createFlushableState();

    // Start piping in background
    flushablePipe(source, mockSink, state).catch(() => {});

    // Start polling multiple times
    pollReadableLock(source, state);
    pollReadableLock(source, state);
    pollReadableLock(source, state);

    // Should only have one interval active
    expect(state.readablePollingInterval).toBeDefined();

    // Close to clean up
    controller?.close();

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 100));
  });

  it('should handle stream ending while pending operations are in flight', async () => {
    const chunks: string[] = [];
    let writeDelay = 0;

    const mockSink = new WritableStream<string>({
      async write(chunk) {
        // Simulate slow write
        await new Promise((r) => setTimeout(r, writeDelay));
        chunks.push(chunk);
      },
    });

    const { readable, writable } = new TransformStream<string, string>();
    const state = createFlushableState();

    // Start piping in background
    flushablePipe(readable, mockSink, state).catch(() => {});

    pollWritableLock(writable, state);

    const userWriter = writable.getWriter();

    // Write first chunk normally
    await userWriter.write('fast');

    // Set delay for next write
    writeDelay = 100;

    // Start slow write and immediately close
    const slowWrite = userWriter.write('slow');
    await userWriter.close();

    // Wait for everything to complete
    await slowWrite;
    await new Promise((r) => setTimeout(r, 150));

    // Promise should resolve
    await expect(state.promise).resolves.toBeUndefined();

    // Both chunks should have been written
    expect(chunks).toContain('fast');
    expect(chunks).toContain('slow');
  });

  it('should propagate cancellation when source stream errors', async () => {
    const chunks: string[] = [];
    // Create a sink that tracks writes (representing the response stream)
    const mockSink = new WritableStream<string>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    // Use a custom ReadableStream with a controller so we can error it
    // externally. This simulates the source stream breaking (e.g., a client
    // disconnect that causes the readable side of the pipe to error).
    // Note: We cannot call readable.cancel() on a locked ReadableStream
    // (flushablePipe locks it via getReader()), so we use controller.error()
    // which propagates through the internal reader.
    let sourceController!: ReadableStreamDefaultController<string>;
    const source = new ReadableStream<string>({
      start(controller) {
        sourceController = controller;
      },
    });
    const state = createFlushableState();
    // Start piping in background
    const pipePromise = flushablePipe(source, mockSink, state).catch(() => {
      // Errors handled via state.reject
    });
    // Enqueue a valid chunk through the source
    sourceController.enqueue('valid chunk');
    // Allow the pipe to process the chunk
    await new Promise((r) => setTimeout(r, 50));
    // Simulate a stream error / client disconnect on the source side.
    // controller.error() propagates to the internal reader held by flushablePipe,
    // causing reader.read() to reject, which triggers the catch block.
    sourceController.error(new Error('Client disconnected'));

    // Wait for the pipe to process the error
    await pipePromise;
    // State promise should reject with the disconnection error
    await expect(state.promise).rejects.toThrow('Client disconnected');

    // The first chunk should have been written before the error
    expect(chunks).toContain('valid chunk');
    // Ensure the stream ended
    expect(state.streamEnded).toBe(true);
  });
});

describe('flushablePipe batching (STREAM_WRITE_BATCH_SYMBOL sinks)', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS;
    delete process.env.WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH;
    delete process.env.WORKFLOW_STREAM_MAX_BYTES_PER_BATCH;
  });

  it('coalesces chunks that arrive during an in-flight batch into one write', async () => {
    // Hold the first batch write "in flight" so the chunks that arrive while
    // it is pending accumulate and go out together as the next batch.
    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { sink, batches } = makeBatchSink((call) =>
      call === 0 ? firstInFlight : undefined
    );
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});

    // First chunk: consumer picks it up alone and blocks on the gate.
    controller().enqueue(new Uint8Array([1]));
    await tick();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);

    // While the first write is in flight, three more chunks arrive.
    controller().enqueue(new Uint8Array([2]));
    controller().enqueue(new Uint8Array([3]));
    controller().enqueue(new Uint8Array([4]));
    await tick();
    // Still only the first batch has been dispatched — the rest are queued.
    expect(batches).toHaveLength(1);
    // They are counted as pending (read but not yet durable): 1 in-flight + 3.
    expect(state.pendingOps).toBe(4);

    // Release the first write; the queued chunks flush as a single batch.
    releaseFirst();
    await tick();
    expect(batches).toHaveLength(2);
    expect(Array.from(batches[1].map((c) => c[0]))).toEqual([2, 3, 4]);

    controller().close();
    await pipe;
    await expect(state.promise).resolves.toBeUndefined();
    expect(state.pendingOps).toBe(0);
  });

  it('delivers every chunk in order and closes the sink on completion', async () => {
    const { sink, batches, isClosed } = makeBatchSink();
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});

    for (let i = 0; i < 25; i++) controller().enqueue(new Uint8Array([i]));
    controller().close();
    await pipe;

    const delivered = batches.flat().map((c) => c[0]);
    expect(delivered).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(isClosed()).toBe(true);
    await expect(state.promise).resolves.toBeUndefined();
    expect(state.pendingOps).toBe(0);
  });

  it('keeps pendingOps > 0 until batches are durable (lock-release durability)', async () => {
    let releaseWrite!: () => void;
    const inFlight = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const { sink } = makeBatchSink(() => inFlight);
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});

    controller().enqueue(new Uint8Array([1]));
    controller().close();
    await tick();

    // Source is done, but the write has not landed yet: a lock-release poll
    // must NOT resolve while the chunk is still un-durable.
    pollReadableLock(source, state);
    await tick(LOCK_POLL_INTERVAL_MS + 20);
    expect(state.doneResolved).toBe(false);
    expect(state.pendingOps).toBe(1);

    releaseWrite();
    await pipe;
    expect(state.pendingOps).toBe(0);
    await expect(state.promise).resolves.toBeUndefined();
  });

  it('propagates a batch-write failure through state.promise', async () => {
    const { sink } = makeBatchSink((call) => {
      if (call === 0) throw new Error('batch write failed');
    });
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});

    controller().enqueue(new Uint8Array([1]));
    await tick();

    await pipe;
    await expect(state.promise).rejects.toThrow('batch write failed');
    expect(state.streamEnded).toBe(true);
  });

  it('does NOT decrement pendingOps for a failed (retained, un-durable) batch', async () => {
    // On failure the sink retains the batch in its buffer, so those chunks are
    // still "read but not durable" — pendingOps must keep counting them.
    const { sink } = makeBatchSink((call) => {
      if (call === 0) throw new Error('batch write failed');
    });
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});

    controller().enqueue(new Uint8Array([1]));
    controller().enqueue(new Uint8Array([2]));
    await tick();

    await pipe;
    await expect(state.promise).rejects.toThrow('batch write failed');
    // Both chunks were read; the batch write failed and retained them, so the
    // count stays at 2 rather than being silently zeroed in a `finally`.
    expect(state.pendingOps).toBe(2);
  });

  it('splits a coalesced batch at the chunk-count wire limit', async () => {
    process.env.WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH = '2';

    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { sink, batches } = makeBatchSink((call) =>
      call === 0 ? firstInFlight : undefined
    );
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();
    const pipe = flushablePipe(source, sink, state).catch(() => {});

    // First chunk goes out alone and blocks; five more queue behind it.
    controller().enqueue(new Uint8Array([1]));
    await tick();
    for (const n of [2, 3, 4, 5, 6]) controller().enqueue(new Uint8Array([n]));
    await tick();

    releaseFirst();
    controller().close();
    await pipe;

    // No batch exceeds the 2-chunk cap, and every chunk is delivered in order.
    expect(batches.every((b) => b.length <= 2)).toBe(true);
    expect(batches.flat().map((c) => c[0])).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(state.promise).resolves.toBeUndefined();
  });

  it('splits a coalesced batch at the byte wire limit', async () => {
    // Cap at 10 bytes; each chunk is 4 bytes, so at most 2 fit per batch.
    process.env.WORKFLOW_STREAM_MAX_BYTES_PER_BATCH = '10';

    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { sink, batches } = makeBatchSink((call) =>
      call === 0 ? firstInFlight : undefined
    );
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();
    const pipe = flushablePipe(source, sink, state).catch(() => {});

    controller().enqueue(new Uint8Array([0, 0, 0, 1]));
    await tick();
    for (let i = 2; i <= 5; i++) {
      controller().enqueue(new Uint8Array([0, 0, 0, i]));
    }
    await tick();

    releaseFirst();
    controller().close();
    await pipe;

    for (const b of batches) {
      const bytes = b.reduce((sum, c) => sum + c.byteLength, 0);
      expect(bytes).toBeLessThanOrEqual(10);
    }
    expect(batches.flat().map((c) => c[3])).toEqual([1, 2, 3, 4, 5]);
    await expect(state.promise).resolves.toBeUndefined();
  });

  it('sends an oversized single chunk alone rather than stalling', async () => {
    process.env.WORKFLOW_STREAM_MAX_BYTES_PER_BATCH = '4';

    const { sink, batches } = makeBatchSink();
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();
    const pipe = flushablePipe(source, sink, state).catch(() => {});

    // A single chunk larger than the byte cap must still be delivered (alone).
    controller().enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    controller().close();
    await pipe;

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].byteLength).toBe(8);
    await expect(state.promise).resolves.toBeUndefined();
  });

  it('applies backpressure once too many chunks are outstanding', async () => {
    process.env.WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS = '2';

    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { sink, batches } = makeBatchSink((call) =>
      call === 0 ? firstInFlight : undefined
    );

    // A source that records how many chunks the pipe has pulled, so we can
    // assert the producer stops reading under backpressure.
    let pulled = 0;
    const total = 6;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled < total) {
          controller.enqueue(new Uint8Array([pulled]));
          pulled++;
        } else {
          controller.close();
        }
      },
    });
    const state = createFlushableState();
    const pipe = flushablePipe(source, sink, state).catch(() => {});

    // First chunk is in flight; the producer may read ahead only up to the cap
    // (2 outstanding) and then must wait, so it cannot drain all 6.
    await tick(20);
    expect(batches).toHaveLength(1);
    expect(pulled).toBeLessThan(total);
    expect(state.pendingOps).toBeLessThanOrEqual(2);

    // Releasing the in-flight write lets the pipe drain the rest.
    releaseFirst();
    await pipe;
    expect(batches.flat()).toHaveLength(total);
    expect(state.pendingOps).toBe(0);
  });
});
