import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowServerWritableStream } from './serialization.js';

// Mock the world module for WorkflowServerWritableStream tests
vi.mock('./runtime/world.js', () => ({
  getWorld: vi.fn(),
}));

describe('WorkflowServerWritableStream', () => {
  let mockStreams: {
    write: ReturnType<typeof vi.fn>;
    writeMulti: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let mockWorld: {
    streams: typeof mockStreams;
    streamFlushIntervalMs?: number;
  };

  beforeEach(async () => {
    mockStreams = {
      write: vi.fn().mockResolvedValue(undefined),
      writeMulti: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockWorld = { streams: mockStreams };

    const { getWorld } = await import('./runtime/world.js');
    vi.mocked(getWorld).mockReturnValue(mockWorld as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor validation', () => {
    it('should throw error when runId is not a string', () => {
      expect(() => {
        new WorkflowServerWritableStream(123 as any, 'test-stream');
      }).toThrow('"runId" must be a string');
    });

    it('should throw error when name is empty', () => {
      expect(() => {
        new WorkflowServerWritableStream('run-123', '');
      }).toThrow('"name" is required');
    });

    it('should accept a string runId', () => {
      expect(() => {
        new WorkflowServerWritableStream('run-123', 'test-stream');
      }).not.toThrow();
    });
  });

  describe('flush-on-write behavior', () => {
    it('write() resolves only after data reaches server', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      // After write() resolves, data must be on the server
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.write).toHaveBeenCalledWith(
        'run-123',
        'test-stream',
        new Uint8Array([1, 2, 3])
      );

      await writer.close();
    });

    it('should use write for single chunk', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      // Single chunk should NOT use writeMulti
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      await writer.close();
    });

    it('should fall back to sequential writes when writeMulti is unavailable', async () => {
      // Remove writeMulti from mock world
      delete (mockStreams as any).writeMulti;

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      await writer.close();
    });

    it('should handle multiple sequential writes (multiple flush cycles)', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // Each write triggers its own flush cycle
      for (let i = 0; i < 5; i++) {
        await writer.write(new Uint8Array([i]));
      }

      expect(mockStreams.write).toHaveBeenCalledTimes(5);
      expect(mockStreams.write).toHaveBeenNthCalledWith(
        1,
        'run-123',
        'test-stream',
        new Uint8Array([0])
      );
      expect(mockStreams.write).toHaveBeenNthCalledWith(
        5,
        'run-123',
        'test-stream',
        new Uint8Array([4])
      );

      await writer.close();
    });

    it('should wait for in-progress flush before adding to buffer', async () => {
      // Simulate a slow flush to test concurrent write behavior
      let resolveFlush!: () => void;
      mockStreams.write.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          })
      );

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // Start first write — it will wait for the slow flush
      const write1 = writer.write(new Uint8Array([1, 2, 3]));

      // Give the timer time to fire and start the flush
      await new Promise((r) => setTimeout(r, 20));

      // Flush has started but not completed
      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      // Resolve the first flush
      resolveFlush();
      await write1;

      // Second write should proceed normally after flush completes
      await writer.write(new Uint8Array([4, 5, 6]));
      expect(mockStreams.write).toHaveBeenCalledTimes(2);

      await writer.close();
    });
  });

  describe('close behavior', () => {
    it('should call close on close', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      expect(mockStreams.close).toHaveBeenCalledWith('run-123', 'test-stream');
    });

    it('should flush remaining buffer on close', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      // Data should have been flushed, then stream closed
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
    });

    it('should not call write methods when buffer is empty on close', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // Close without writing — should only call close
      await writer.close();

      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort behavior', () => {
    it('should discard buffer and not call close on abort', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.abort();

      // Write should have flushed, but no close since we aborted
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.close).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should propagate write errors to the caller', async () => {
      mockStreams.write.mockRejectedValueOnce(new Error('write error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(
        'write error'
      );
    });

    it('should propagate close errors', async () => {
      mockStreams.close.mockRejectedValueOnce(new Error('close error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));

      await expect(writer.close()).rejects.toThrow('close error');
    });

    it('should propagate write errors from close flush', async () => {
      // Make close's flush fail (close calls flush() for remaining buffer)
      // by having the write succeed but the stream fail on a second write
      mockStreams.write
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('flush error on close'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // First write succeeds
      await writer.write(new Uint8Array([1, 2, 3]));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      // Second write fails
      await expect(writer.write(new Uint8Array([4, 5, 6]))).rejects.toThrow(
        'flush error on close'
      );
    });
  });

  describe('streamFlushIntervalMs', () => {
    it('should use world.streamFlushIntervalMs when set to 0 (immediate flush)', async () => {
      mockWorld.streamFlushIntervalMs = 0;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      // With interval=0, the flush fires on the next microtask tick via setTimeout(fn, 0)
      await writer.write(new Uint8Array([1]));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      await writer.close();
    });

    it('should fall back to default interval when streamFlushIntervalMs is undefined', async () => {
      // mockWorld has no streamFlushIntervalMs set — uses default 10ms
      delete mockWorld.streamFlushIntervalMs;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      await writer.close();
    });

    it('should respect a custom non-zero flush interval', async () => {
      mockWorld.streamFlushIntervalMs = 50;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      // Start a write — the flush is scheduled 50ms from now
      const writePromise = writer.write(new Uint8Array([1]));

      // After 10ms (the old default), data should NOT have flushed yet
      await new Promise((r) => setTimeout(r, 10));
      expect(mockStreams.write).not.toHaveBeenCalled();

      // Wait for the write to complete (will resolve after the 50ms timer fires)
      await writePromise;
      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      await writer.close();
    });
  });
});
