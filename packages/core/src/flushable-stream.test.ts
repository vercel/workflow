import { test, expect, describe } from 'vitest';
import { createFlushableState, flushablePipe } from './flushable-stream';

describe('flushablePipe', () => {
  test('handles stream chunks correctly', async () => {
    const chunks: string[] = [];
    const mockSink = new WritableStream<string>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('chunk 1');
        controller.enqueue('chunk 2');
        controller.close();
      },
    });

    const state = createFlushableState();
    await flushablePipe(source, mockSink, state);

    expect(chunks).toEqual(['chunk 1', 'chunk 2']);
    expect(state.streamEnded).toBe(true);
  });

  test('propagates cancellation correctly', async () => {
    const chunks: string[] = [];
    let sinkAborted = false;
    // Create a sink that tracks writes and aborts (representing the response stream)
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
