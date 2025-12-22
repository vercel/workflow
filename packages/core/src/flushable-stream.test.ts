import { describe, expect, it } from 'vitest';
import {
  createFlushableState,
  flushablePipe,
  LOCK_POLL_INTERVAL_MS,
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
});
