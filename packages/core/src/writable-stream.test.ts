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
    // Use real timers — write() now waits for the scheduled flush
    // timer to fire, which doesn't work with fake timers.
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

  describe('buffered flush behavior', () => {
    it('write() resolves only after data reaches server', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // Write returns a promise that resolves after the flush
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

    it('should batch multiple concurrent writes', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      // First write triggers a flush timer. The write() promise
      // won't resolve until the flush completes.
      await writer.write(new Uint8Array([1, 2, 3]));
      // Second write after flush — starts a new batch
      await writer.write(new Uint8Array([4, 5, 6]));

      // Both writes should have flushed (each in its own batch
      // since we await sequentially)
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(2);

      await writer.close();
    });

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

    it('should handle multiple sequential writes', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      for (let i = 0; i < 5; i++) {
        await writer.write(new Uint8Array([i]));
      }

      // Each write awaits its flush, so all data reaches the server
      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(5);

      await writer.close();
    });
  });

  describe('abort behavior', () => {
    it('should handle abort gracefully', async () => {
      const stream = new WorkflowServerWritableStream('test-stream', 'run-123');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.abort();

      expect(mockWorld.writeToStream).toHaveBeenCalledTimes(1);
      expect(mockWorld.closeStream).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should propagate write errors', async () => {
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
  });
});
