import { afterEach, describe, expect, it } from 'vitest';
import {
  createFlushableState,
  flushablePipe,
  LOCK_POLL_INTERVAL_MS,
  pollReadableLock,
  pollWritableLock,
} from './flushable-stream.js';
import { STREAM_DRAIN_SYMBOL } from './symbols.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A group-commit-style mock sink: acks `write()` on buffer entry and exposes
 * a durability barrier under `STREAM_DRAIN_SYMBOL`, mirroring
 * `WorkflowServerWritableStream`'s early-ack contract.
 */
function makeDrainSink(drain: () => Promise<void>) {
  const written: Uint8Array[] = [];
  let closed = false;
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
      // ack on buffer entry — durability is the barrier's job
    },
    close() {
      closed = true;
    },
  });
  Object.defineProperty(sink, STREAM_DRAIN_SYMBOL, {
    value: drain,
    enumerable: false,
    writable: false,
  });
  return { sink, written, isClosed: () => closed };
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

describe('flushablePipe drain barrier (group-commit sinks)', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS;
    delete process.env.WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH;
    delete process.env.WORKFLOW_STREAM_MAX_BYTES_PER_BATCH;
  });

  it('adopts the sink drain barrier onto the flushable state', async () => {
    const { sink } = makeDrainSink(async () => {});
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});
    expect(typeof state.drainBarrier).toBe('function');

    controller().close();
    await pipe;
    await expect(state.promise).resolves.toBeUndefined();
  });

  it('lock-release completion waits for the drain barrier (early-ack durability)', async () => {
    // In production the poll watches the USER-side writable (the serialize
    // transform's writable) while the pipe drives the server sink. Model
    // that: an unlocked user writable, pendingOps at 0 (the sink early-acks),
    // and a drain barrier that is still pending — completion must wait.
    let releaseDrain!: () => void;
    const gate = new Promise<void>((r) => {
      releaseDrain = r;
    });
    const state = createFlushableState();
    state.drainBarrier = () => gate;
    const userWritable = new WritableStream<Uint8Array>();

    pollWritableLock(userWritable, state);
    await tick(LOCK_POLL_INTERVAL_MS + 20);

    // The poll claimed completion (stopped polling) but the promise must
    // still be pending — data is client-buffered until the barrier resolves.
    expect(state.doneResolved).toBe(true);
    let settled = false;
    void state.promise.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    releaseDrain();
    await expect(state.promise).resolves.toBeUndefined();
  });

  it('rejects the completion when the drain barrier reports a failed flush', async () => {
    const state = createFlushableState();
    state.drainBarrier = async () => {
      throw new Error('group flush failed');
    };
    const userWritable = new WritableStream<Uint8Array>();

    pollWritableLock(userWritable, state);
    await tick(LOCK_POLL_INTERVAL_MS + 20);

    await expect(state.promise).rejects.toThrow('group flush failed');
  });

  it('drains the accepted prefix before settling a failed pipe', async () => {
    // Source fails while accepted chunks are still behind the sink's
    // barrier: the failure must not settle (letting the step persist it and
    // the invocation finish) until the prefix is durable.
    let releaseDrain!: () => void;
    let drained = false;
    const gate = new Promise<void>((r) => {
      releaseDrain = () => {
        drained = true;
        r();
      };
    });
    const { sink, written } = makeDrainSink(() => gate);
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});
    controller().enqueue(new Uint8Array([1]));
    await tick();
    expect(written).toHaveLength(1); // acked into the sink

    controller().error(new Error('producer failed'));
    await tick();

    // The failure is known but must not settle while the barrier is held.
    let settled = false;
    void state.promise.catch(() => {
      settled = true;
    });
    await tick(5);
    expect(settled).toBe(false);

    releaseDrain();
    await pipe;
    expect(drained).toBe(true);
    await expect(state.promise).rejects.toThrow('producer failed');
  });

  it('does not attach a barrier for plain sinks (per-write durability)', async () => {
    const written: Uint8Array[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk);
      },
    });
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});
    expect(state.drainBarrier).toBeUndefined();

    controller().enqueue(new Uint8Array([1]));
    controller().close();
    await pipe;
    expect(written).toHaveLength(1);
    await expect(state.promise).resolves.toBeUndefined();
  });

  it('delivers every chunk in order and closes the sink on completion', async () => {
    const { sink, written, isClosed } = makeDrainSink(async () => {});
    const { source, controller } = makeControlledSource();
    const state = createFlushableState();

    const pipe = flushablePipe(source, sink, state).catch(() => {});
    for (let i = 0; i < 25; i++) controller().enqueue(new Uint8Array([i]));
    controller().close();
    await pipe;

    expect(written.map((c) => c[0])).toEqual(
      Array.from({ length: 25 }, (_, i) => i)
    );
    expect(isClosed()).toBe(true);
    await expect(state.promise).resolves.toBeUndefined();
    expect(state.pendingOps).toBe(0);
  });
});
