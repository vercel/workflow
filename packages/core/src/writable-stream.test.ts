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

  beforeEach(async () => {
    vi.useFakeTimers();

    mockStreams = {
      write: vi.fn().mockResolvedValue(undefined),
      writeMulti: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const { getWorld } = await import('./runtime/world.js');
    vi.mocked(getWorld).mockReturnValue({ streams: mockStreams } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  describe('buffering behavior', () => {
    it('should buffer chunks and flush after 10ms', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write first chunk
      await writer.write(new Uint8Array([1, 2, 3]));
      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      // Write second chunk
      await writer.write(new Uint8Array([4, 5, 6]));
      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      // Advance timer to trigger flush
      await vi.advanceTimersByTimeAsync(10);

      // Should use writeToStreamMulti for multiple chunks
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).toHaveBeenCalledWith(
        'test-stream',
        'run-123',
        [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
      );
      expect(mockStreams.write).not.toHaveBeenCalled();

      await writer.close();
    });

    it('should use writeToStream for single chunk', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write single chunk
      await writer.write(new Uint8Array([1, 2, 3]));

      // Advance timer to trigger flush
      await vi.advanceTimersByTimeAsync(10);

      // Should use writeToStream for single chunk (not writeToStreamMulti)
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.write).toHaveBeenCalledWith(
        'test-stream',
        'run-123',
        new Uint8Array([1, 2, 3])
      );
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      await writer.close();
    });

    it('should fall back to sequential writes when writeMulti is unavailable', async () => {
      // Remove writeMulti from mock world
      delete (mockStreams as any).writeMulti;

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write multiple chunks
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.write(new Uint8Array([4, 5, 6]));

      // Advance timer to trigger flush
      await vi.advanceTimersByTimeAsync(10);

      // Should fall back to sequential writeToStream calls
      expect(mockStreams.write).toHaveBeenCalledTimes(2);
      expect(mockStreams.write).toHaveBeenNthCalledWith(
        1,
        'test-stream',
        'run-123',
        new Uint8Array([1, 2, 3])
      );
      expect(mockStreams.write).toHaveBeenNthCalledWith(
        2,
        'test-stream',
        'run-123',
        new Uint8Array([4, 5, 6])
      );

      await writer.close();
    });

    it('should flush remaining buffer on close', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write chunks but don't wait for timer
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.write(new Uint8Array([4, 5, 6]));

      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      // Close should flush immediately without waiting for timer
      await writer.close();

      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
      expect(mockStreams.close).toHaveBeenCalledWith('test-stream', 'run-123');
    });

    it('should not schedule multiple flush timers', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write multiple chunks rapidly
      await writer.write(new Uint8Array([1]));
      await writer.write(new Uint8Array([2]));
      await writer.write(new Uint8Array([3]));

      // Advance timer once
      await vi.advanceTimersByTimeAsync(10);

      // Should only call writeToStreamMulti once with all chunks
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).toHaveBeenCalledWith(
        'test-stream',
        'run-123',
        [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]
      );

      await writer.close();
    });

    it('should handle multiple flush cycles', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // First batch
      await writer.write(new Uint8Array([1, 2]));
      await vi.advanceTimersByTimeAsync(10);

      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      // Second batch
      await writer.write(new Uint8Array([3, 4]));
      await writer.write(new Uint8Array([5, 6]));
      await vi.advanceTimersByTimeAsync(10);

      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).toHaveBeenCalledWith(
        'test-stream',
        'run-123',
        [new Uint8Array([3, 4]), new Uint8Array([5, 6])]
      );

      await writer.close();
    });

    it('should wait for in-progress flush before adding to buffer', async () => {
      // Create a slow writeToStreamMulti that we can control
      let resolveWrite: () => void;
      mockStreams.writeMulti.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          })
      );

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write and trigger flush
      await writer.write(new Uint8Array([1, 2]));
      await writer.write(new Uint8Array([3, 4]));
      await vi.advanceTimersByTimeAsync(10);

      // Flush started but not completed
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);

      // Write more while flush is in progress
      const writePromise = writer.write(new Uint8Array([5, 6]));

      // Resolve the first flush
      resolveWrite!();
      await writePromise;

      // Now advance timer to flush the new chunk
      await vi.advanceTimersByTimeAsync(10);

      // Second flush should have happened
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.write).toHaveBeenCalledWith(
        'test-stream',
        'run-123',
        new Uint8Array([5, 6])
      );

      await writer.close();
    });
  });

  describe('abort behavior', () => {
    it('should clean up timer and discard buffer on abort', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write chunks
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.write(new Uint8Array([4, 5, 6]));

      // Abort the stream
      await writer.abort(new Error('Test abort'));

      // Advance timer - should NOT trigger flush since stream was aborted
      await vi.advanceTimersByTimeAsync(10);

      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();
      expect(mockStreams.close).not.toHaveBeenCalled();
    });
  });

  describe('empty buffer handling', () => {
    it('should not call write methods when buffer is empty on close', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Close without writing anything
      await writer.close();

      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should propagate write errors from close', async () => {
      // Make writeToStreamMulti fail
      mockStreams.writeMulti.mockRejectedValue(new Error('Write failed'));

      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write chunks (buffered, no error yet)
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.write(new Uint8Array([4, 5, 6]));

      // Close should propagate the error from flush
      await expect(writer.close()).rejects.toThrow('Write failed');
    });
  });
});
