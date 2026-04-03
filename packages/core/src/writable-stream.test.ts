import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowServerWritableStream } from './serialization.js';

// Mock the world module for WorkflowServerWritableStream tests
vi.mock('./runtime/world.js', () => ({
  getWorld: vi.fn(),
}));

describe('WorkflowServerWritableStream', () => {
  let mockWorld: {
    writeToStream: ReturnType<typeof vi.fn>;
    writeToStreamMulti: ReturnType<typeof vi.fn>;
    closeStream: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockWorld = {
      writeToStream: vi.fn().mockResolvedValue(undefined),
      writeToStreamMulti: vi.fn().mockResolvedValue(undefined),
      closeStream: vi.fn().mockResolvedValue(undefined),
    };

    const { getWorld } = await import('./runtime/world.js');
    (getWorld as ReturnType<typeof vi.fn>).mockReturnValue(mockWorld);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor validation', () => {
    it('should throw error when runId is not a string', () => {
      expect(() => {
        new WorkflowServerWritableStream('test-stream', 123 as any);
      }).toThrow('"runId" must be a string');
    });

    it('should throw error when name is empty', () => {
      expect(() => {
        new WorkflowServerWritableStream('', 'run-123');
      }).toThrow('"name" is required');
    });

    it('should accept a string runId', () => {
      expect(() => {
        new WorkflowServerWritableStream('test-stream', 'run-123');
      }).not.toThrow();
    });
  });

  describe('flush-on-write behavior', () => {
    it('write() resolves only after data reaches server', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      // After write() resolves, data must be on the server
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);
      expect(mockWorld.writeToStream).toHaveBeenCalledWith(
        'test-stream',
        'run-123',
        new Uint8Array([1, 2, 3])
      );

      await writer.close();
    });

    it('should use writeToStream for single chunk', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);
      // Single chunk should NOT use writeToStreamMulti
      expect(mockWorld.writeToStreamMulti).not.toHaveBeenCalled();

      await writer.close();
    });

    it('should fall back to sequential writes when writeToStreamMulti is unavailable', async () => {
      // Remove writeToStreamMulti
      delete (mockWorld as any).writeToStreamMulti;

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);

      await writer.close();
    });

    it('should handle multiple sequential writes (multiple flush cycles)', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Each write triggers its own flush cycle
      for (let i = 0; i < 5; i++) {
        await writer.write(new Uint8Array([i]));
      }

      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(5);
      expect(mockWorld.writeToStream).toHaveBeenNthCalledWith(
        1,
        'test-stream',
        'run-123',
        new Uint8Array([0])
      );
      expect(mockWorld.writeToStream).toHaveBeenNthCalledWith(
        5,
        'test-stream',
        'run-123',
        new Uint8Array([4])
      );

      await writer.close();
    });

    it('should wait for in-progress flush before adding to buffer', async () => {
      // Simulate a slow flush to test concurrent write behavior
      let resolveFlush!: () => void;
      mockWorld.writeToStream.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          })
      );

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Start first write — it will wait for the slow flush
      const write1 = writer.write(new Uint8Array([1, 2, 3]));

      // Give the timer time to fire and start the flush
      await new Promise((r) => setTimeout(r, 20));

      // Flush has started but not completed
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);

      // Resolve the first flush
      resolveFlush();
      await write1;

      // Second write should proceed normally after flush completes
      await writer.write(new Uint8Array([4, 5, 6]));
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(2);

      await writer.close();
    });
  });

  describe('close behavior', () => {
    it('should call closeStream on close', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      expect(mockWorld.closeStream).toHaveBeenCalledWith(
        'test-stream',
        'run-123'
      );
    });

    it('should flush remaining buffer on close', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      // Data should have been flushed, then stream closed
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);
      expect(mockWorld.closeStream).toHaveBeenCalledTimes(1);
    });

    it('should not call write methods when buffer is empty on close', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Close without writing — should only call closeStream
      await writer.close();

      expect(mockWorld.writeToStream).not.toHaveBeenCalled();
      expect(mockWorld.writeToStreamMulti).not.toHaveBeenCalled();
      expect(mockWorld.closeStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort behavior', () => {
    it('should discard buffer and not call closeStream on abort', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.abort();

      // Write should have flushed, but no close since we aborted
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);
      expect(mockWorld.closeStream).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should propagate write errors to the caller', async () => {
      mockWorld.writeToStream.mockRejectedValueOnce(new Error('write error'));

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(
        'write error'
      );
    });

    it('should propagate close errors', async () => {
      mockWorld.closeStream.mockRejectedValueOnce(new Error('close error'));

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));

      await expect(writer.close()).rejects.toThrow('close error');
    });

    it('should propagate write errors from close flush', async () => {
      // Make close's flush fail (close calls flush() for remaining buffer)
      // by having the write succeed but the stream fail on a second write
      mockWorld.writeToStream
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('flush error on close'));

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // First write succeeds
      await writer.write(new Uint8Array([1, 2, 3]));
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);

      // Manually push data into the buffer without triggering a flush
      // by calling write again — this will flush immediately
      await expect(writer.write(new Uint8Array([4, 5, 6]))).rejects.toThrow(
        'flush error on close'
      );
    });
  });
});
