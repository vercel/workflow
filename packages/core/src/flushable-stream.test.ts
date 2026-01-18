import { describe, expect, it } from 'vitest';
import {
  createFlushableState,
  flushablePipe,
  LOCK_POLL_INTERVAL_MS,
  pollReadableLock,
  pollWritableLock,
} from './flushable-stream.js';

describe('flushable stream behavior', () => {
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
});
