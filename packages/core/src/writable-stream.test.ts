import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlushableState, flushablePipe } from './flushable-stream.js';
import { setWorld } from './runtime/world.js';
import {
  dehydrateStepReturnValue,
  WorkflowServerWritableStream,
} from './serialization.js';
import { STREAM_DRAINED_SYMBOL } from './symbols.js';

/** Resolve/reject handle for a deferred World RPC. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function drainedOf(stream: WorkflowServerWritableStream): () => Promise<void> {
  const drained = (
    stream as unknown as Record<symbol, (() => Promise<void>) | undefined>
  )[STREAM_DRAINED_SYMBOL];
  if (!drained) throw new Error('STREAM_DRAINED_SYMBOL missing');
  return drained;
}

describe('WorkflowServerWritableStream', () => {
  let mockStreams: {
    write: ReturnType<typeof vi.fn>;
    writeMulti: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let mockWorld: {
    specVersion: typeof SPEC_VERSION_CURRENT;
    streams: typeof mockStreams;
    streamFlushIntervalMs?: number;
  };

  /** Chunks delivered to the server, across write() and writeMulti(). */
  function deliveredChunks(): Uint8Array[] {
    return [
      ...mockStreams.write.mock.calls.map(([, , chunk]) => chunk),
      ...mockStreams.writeMulti.mock.calls.flatMap(([, , chunks]) => chunks),
    ];
  }

  beforeEach(async () => {
    mockStreams = {
      write: vi.fn().mockResolvedValue(undefined),
      writeMulti: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockWorld = { specVersion: SPEC_VERSION_CURRENT, streams: mockStreams };

    setWorld(mockWorld as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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

  describe('buffering and batching behavior', () => {
    it('write() resolves on buffer-accept, before data reaches the server', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      // The write is accepted, not yet flushed (the group-commit window is
      // still open) — this is what lets batches form.
      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      // close() drains before closing: the chunk is on the server after.
      await writer.close();
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.write).toHaveBeenCalledWith(
        'run-123',
        'test-stream',
        new Uint8Array([1, 2, 3])
      );
    });

    it('batches chunks written within the group-commit window into one writeMulti', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // Sequential awaited writes: each resolves at accept, so all five land
      // in the buffer before the flush timer fires.
      for (let i = 0; i < 5; i++) {
        await writer.write(new Uint8Array([i]));
      }
      await writer.close();

      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).toHaveBeenCalledWith(
        'run-123',
        'test-stream',
        [0, 1, 2, 3, 4].map((i) => new Uint8Array([i]))
      );
      expect(mockStreams.write).not.toHaveBeenCalled();
    });

    it('pipelines: chunks written during an in-flight flush form the next batch', async () => {
      const firstRpc = deferred();
      mockStreams.write.mockImplementationOnce(() => firstRpc.promise);

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // First chunk flushes alone once the timer fires.
      await writer.write(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 20));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      // While that RPC is in flight, more chunks are accepted immediately.
      await writer.write(new Uint8Array([2]));
      await writer.write(new Uint8Array([3]));
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      // When the RPC settles, the flush loop sends the accumulated batch.
      firstRpc.resolve();
      await writer.close();
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).toHaveBeenCalledWith(
        'run-123',
        'test-stream',
        [new Uint8Array([2]), new Uint8Array([3])]
      );
    });

    it('should use write for a single chunk (no writeMulti)', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();
    });

    it('should fall back to sequential writes when writeMulti is unavailable', async () => {
      delete (mockStreams as any).writeMulti;

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await writer.write(new Uint8Array([2]));
      await writer.write(new Uint8Array([3]));
      await writer.close();

      expect(mockStreams.write).toHaveBeenCalledTimes(3);
      expect(mockStreams.write).toHaveBeenNthCalledWith(
        1,
        'run-123',
        'test-stream',
        new Uint8Array([1])
      );
      expect(mockStreams.write).toHaveBeenNthCalledWith(
        3,
        'run-123',
        'test-stream',
        new Uint8Array([3])
      );
    });

    it('flushes without close() once the group-commit window elapses', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 30));

      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      await writer.close();
    });
  });

  describe('drain barrier (STREAM_DRAINED_SYMBOL)', () => {
    it('resolves only after every accepted chunk is server-acked', async () => {
      const rpc = deferred();
      mockStreams.write.mockImplementationOnce(() => rpc.promise);

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();
      const drained = drainedOf(stream);

      await writer.write(new Uint8Array([1]));

      let drainSettled = false;
      const drainPromise = drained().then(() => {
        drainSettled = true;
      });

      // Buffered → in-flight: the barrier must hold through both.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(drainSettled).toBe(false);

      rpc.resolve();
      await drainPromise;
      expect(drainSettled).toBe(true);

      // Idle stream: the barrier resolves immediately.
      await drained();
      await writer.close();
    });

    it('rejects when a flush RPC fails', async () => {
      mockStreams.write.mockRejectedValueOnce(new Error('flush failed'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();
      const drained = drainedOf(stream);

      await writer.write(new Uint8Array([1]));
      await expect(drained()).rejects.toThrow('flush failed');
    });
  });

  describe('flushablePipe pendingOps (step-completion barrier, #1446)', () => {
    it('holds pendingOps until the chunk is server-acked, not just buffer-accepted', async () => {
      const rpc = deferred();
      mockStreams.write.mockImplementationOnce(() => rpc.promise);

      const sink = new WorkflowServerWritableStream('run-123', 'test-stream');
      const state = createFlushableState();

      let enqueue!: (chunk: Uint8Array) => void;
      let closeSource!: () => void;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          enqueue = (chunk) => controller.enqueue(chunk);
          closeSource = () => controller.close();
        },
      });

      const pipe = flushablePipe(source, sink, state);

      enqueue(new Uint8Array([1]));

      // The pipe accepts the chunk quickly (write resolves at accept), but
      // the op must stay pending until the server acks — otherwise a step
      // could complete while its data sits in the client buffer.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(state.pendingOps).toBe(1);

      rpc.resolve();
      await vi.waitFor(() => {
        expect(state.pendingOps).toBe(0);
      });

      closeSource();
      await pipe;
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
    });

    it('rejects the state when the flush fails after the producer went idle', async () => {
      const rpc = deferred();
      mockStreams.write.mockImplementationOnce(() => rpc.promise);

      const sink = new WorkflowServerWritableStream('run-123', 'test-stream');
      const state = createFlushableState();

      let enqueue!: (chunk: Uint8Array) => void;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          enqueue = (chunk) => controller.enqueue(chunk);
        },
      });

      flushablePipe(source, sink, state).catch(() => {});

      enqueue(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 30));
      expect(state.pendingOps).toBe(1);

      // The producer wrote nothing further; the only failure signal is the
      // drain barrier held by the pipe.
      rpc.reject(new Error('flush failed'));
      await expect(state.promise).rejects.toThrow('flush failed');
      await vi.waitFor(() => {
        expect(state.pendingOps).toBe(0);
      });
    });
  });

  describe('backpressure (buffered-bytes cap)', () => {
    it('parks write() at the cap and releases it when a flush drains the buffer', async () => {
      vi.stubEnv('WORKFLOW_STREAM_MAX_BUFFERED_BYTES', '4');
      const rpc = deferred();
      mockStreams.writeMulti.mockImplementationOnce(() => rpc.promise);

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // 3 + 3 bytes: the second write is accepted (the check runs before the
      // push), leaving the buffer over the 4-byte cap.
      await writer.write(new Uint8Array([1, 1, 1]));
      await writer.write(new Uint8Array([2, 2, 2]));

      // The third write parks on the cap.
      let thirdAccepted = false;
      const third = writer.write(new Uint8Array([3, 3, 3])).then(() => {
        thirdAccepted = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      // The flush took the first two chunks (freeing the buffer), so the
      // parked write was released even though the RPC is still in flight.
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(thirdAccepted).toBe(true);
      await third;

      rpc.resolve();
      await writer.close();
      expect(deliveredChunks()).toHaveLength(3);
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

    it('should flush remaining buffer before closing (skipping the commit window)', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
      // The write must land before the close RPC.
      expect(mockStreams.write.mock.invocationCallOrder[0]).toBeLessThan(
        mockStreams.close.mock.invocationCallOrder[0]
      );
    });

    it('should not call write methods when buffer is empty on close', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.close();

      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort behavior', () => {
    it('discards unflushed chunks and does not close on abort', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // Accepted but not yet flushed (commit window still open).
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.abort();

      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.write).not.toHaveBeenCalled();
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();
      expect(mockStreams.close).not.toHaveBeenCalled();
    });

    it('rejects the drain barrier on abort so no holder leaks', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();
      const drained = drainedOf(stream);

      await writer.write(new Uint8Array([1]));
      const drainPromise = drained();
      await writer.abort(new Error('aborted by test'));

      await expect(drainPromise).rejects.toThrow('aborted by test');
    });
  });

  describe('error handling', () => {
    it('surfaces flush errors on the stream (writer.closed) since write() acks on accept', async () => {
      mockStreams.write.mockRejectedValueOnce(new Error('write error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // The write itself resolves (accepted into the buffer)...
      await writer.write(new Uint8Array([1, 2, 3]));
      // ...and the asynchronous flush failure errors the stream.
      await expect(writer.closed).rejects.toThrow('write error');
    });

    it('rejects close() when the final flush fails', async () => {
      mockStreams.writeMulti.mockRejectedValueOnce(new Error('flush error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await writer.write(new Uint8Array([2]));

      await expect(writer.close()).rejects.toThrow('flush error');
      expect(mockStreams.close).not.toHaveBeenCalled();
    });

    it('should propagate close errors', async () => {
      mockStreams.close.mockRejectedValueOnce(new Error('close error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));

      await expect(writer.close()).rejects.toThrow('close error');
    });

    it('rejects writes after a flush failure', async () => {
      mockStreams.write.mockRejectedValueOnce(new Error('terminal error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      // Wait for the failed flush to error the stream.
      await expect(writer.closed).rejects.toThrow('terminal error');
      await expect(writer.write(new Uint8Array([2]))).rejects.toThrow(
        'terminal error'
      );
    });
  });

  describe('streamFlushIntervalMs', () => {
    it('should use world.streamFlushIntervalMs when set to 0 (immediate flush)', async () => {
      mockWorld.streamFlushIntervalMs = 0;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await vi.waitFor(() => {
        expect(mockStreams.write).toHaveBeenCalledTimes(1);
      });

      await writer.close();
    });

    it('should fall back to default interval when streamFlushIntervalMs is undefined', async () => {
      delete mockWorld.streamFlushIntervalMs;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await vi.waitFor(() => {
        expect(mockStreams.write).toHaveBeenCalledTimes(1);
      });

      await writer.close();
    });

    it('should respect a custom non-zero flush interval', async () => {
      mockWorld.streamFlushIntervalMs = 50;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      // Prime the cached interval (it is read from the world on first flush).
      await writer.write(new Uint8Array([0]));
      await vi.waitFor(() => {
        expect(mockStreams.write).toHaveBeenCalledTimes(1);
      });

      // The next write's commit window is 50ms: not flushed at 10ms.
      await writer.write(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 10));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => {
        expect(mockStreams.write).toHaveBeenCalledTimes(2);
      });

      await writer.close();
    });
  });

  describe('runReadyBarrier (turbo optimistic start)', () => {
    it('holds the first server write until the run-ready barrier resolves', async () => {
      const order: string[] = [];
      mockStreams.write.mockImplementation(async () => {
        order.push('write');
      });

      let releaseBarrier!: () => void;
      const runReadyBarrier = new Promise<void>((resolve) => {
        releaseBarrier = () => {
          order.push('barrier');
          resolve();
        };
      });

      const stream = new WorkflowServerWritableStream(
        'run-123',
        'test-stream',
        runReadyBarrier
      );
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));

      // The body wrote a chunk before run_started is durable: the flush timer
      // may fire, but the server write must not happen until the run exists.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.write).not.toHaveBeenCalled();

      releaseBarrier();
      await writer.close();

      // The chunk reaches the server strictly after the barrier resolves.
      expect(order).toEqual(['barrier', 'write']);
    });

    it('only awaits the barrier once — later flushes are not gated', async () => {
      const runReadyBarrier = Promise.resolve();
      const stream = new WorkflowServerWritableStream(
        'run-123',
        'test-stream',
        runReadyBarrier
      );
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await writer.write(new Uint8Array([2]));
      await writer.write(new Uint8Array([3]));
      await writer.close();

      expect(deliveredChunks()).toEqual([
        new Uint8Array([1]),
        new Uint8Array([2]),
        new Uint8Array([3]),
      ]);
    });

    it('still writes when the barrier rejects (write surfaces the real error)', async () => {
      const runReadyBarrier = Promise.reject(new Error('run_started failed'));
      runReadyBarrier.catch(() => {});

      const stream = new WorkflowServerWritableStream(
        'run-123',
        'test-stream',
        runReadyBarrier
      );
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close();

      // Barrier rejection is swallowed for ordering only — the write still
      // fires and would surface a genuine run-not-found error from the World.
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
    });

    it('gates the first write of a stream RETURNED from a turbo first step', async () => {
      // Regression: getWritable()/setAttributes are gated while the step
      // context is active, but a step that *returns* a fresh ReadableStream
      // is serialized after the body via dehydrateStepReturnValue(), whose
      // sink must also wait for run_started before the first chunk lands.
      const order: string[] = [];
      mockStreams.write.mockImplementation(async () => {
        order.push('write');
      });

      let releaseBarrier!: () => void;
      const runReadyBarrier = new Promise<void>((resolve) => {
        releaseBarrier = () => {
          order.push('barrier');
          resolve();
        };
      });

      const returned = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });

      const ops: Promise<unknown>[] = [];
      await dehydrateStepReturnValue(
        returned,
        'run-123',
        undefined, // encryption key
        ops,
        globalThis,
        false, // v1Compat
        false, // framedByteStreams
        false, // compression
        runReadyBarrier
      );

      // The pipe is queued but must not have written before the run exists.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.write).not.toHaveBeenCalled();

      releaseBarrier();
      await Promise.all(ops);

      // The returned stream's first chunk reaches the server only after the
      // run-ready barrier resolves.
      expect(order[0]).toBe('barrier');
      expect(mockStreams.write).toHaveBeenCalled();
    });

    it('gates a close that is itself the first write to a new stream', async () => {
      const order: string[] = [];
      mockStreams.close.mockImplementation(async () => {
        order.push('close');
      });

      let releaseBarrier!: () => void;
      const runReadyBarrier = new Promise<void>((resolve) => {
        releaseBarrier = () => {
          order.push('barrier');
          resolve();
        };
      });

      const stream = new WorkflowServerWritableStream(
        'run-123',
        'test-stream',
        runReadyBarrier
      );
      const writer = stream.getWriter();

      // Close with no chunks written: the flush loop short-circuits on the
      // empty buffer, so close() must apply the barrier itself.
      const closePromise = writer.close();
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.close).not.toHaveBeenCalled();

      releaseBarrier();
      await closePromise;

      expect(order).toEqual(['barrier', 'close']);
    });
  });
});
