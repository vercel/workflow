import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlushableState, flushablePipe } from './flushable-stream.js';
import { setWorld } from './runtime/world.js';
import {
  dehydrateStepReturnValue,
  WorkflowServerWritableStream,
} from './serialization.js';

/**
 * Poll until the expectation passes — replaces fixed sleeps for
 * "dispatch has happened" assertions, which flake on slow CI runners
 * where the 10ms commit window and scheduler jitter exceed a fixed wait.
 */
async function waitFor(
  assertion: () => void,
  timeoutMs = 3000,
  intervalMs = 5
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
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

  describe('group-commit write behavior', () => {
    it('write() resolves on buffer entry; the leading chunk dispatches immediately (no window tax)', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));

      // Default window is 0: the leading chunk of an idle sink goes out
      // right away — no fixed delay for sparse producers.
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));
      expect(mockStreams.write).toHaveBeenCalledWith(
        'run-123',
        'test-stream',
        new Uint8Array([1, 2, 3])
      );

      await writer.close();
    });

    it('uses a single write (not writeMulti) for a lone chunk', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.close(); // close drains immediately, no timer wait needed

      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();
    });

    it('coalesces rapid awaited writes: leading chunk immediate, rest ride the in-flight window', async () => {
      // Leading-edge dispatch sends chunk 0 at once; the awaited per-chunk
      // loop keeps producing while that request is in flight, so the rest
      // accumulate into one writeMulti group — batching without any fixed
      // leading delay.
      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      for (let i = 0; i < 5; i++) {
        await writer.write(new Uint8Array([i]));
      }
      releaseFirst();
      await writer.close();

      expect(mockStreams.write).toHaveBeenCalledTimes(1); // leading [0]
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      const [, , group] = mockStreams.writeMulti.mock.calls[0];
      expect(group.map((c: Uint8Array) => c[0])).toEqual([1, 2, 3, 4]);
    });

    it('should fall back to sequential writes when writeMulti is unavailable', async () => {
      // Remove writeMulti from mock world
      delete (mockStreams as any).writeMulti;

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await writer.write(new Uint8Array([2]));
      await writer.close();

      expect(mockStreams.write).toHaveBeenCalledTimes(2);
      const delivered = mockStreams.write.mock.calls.map(
        (call: unknown[]) => (call[2] as Uint8Array)[0]
      );
      expect(delivered).toEqual([1, 2]);
    });

    it('chunks accepted during an in-flight request form the next group', async () => {
      // Hold the first request in flight; chunks written meanwhile must
      // accumulate and go out as ONE writeMulti when it settles — with a
      // plain writer, no special pipe.
      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      // Let the commit window fire and the first request go in flight.
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

      await writer.write(new Uint8Array([2]));
      await writer.write(new Uint8Array([3]));
      await writer.write(new Uint8Array([4]));
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      releaseFirst();
      await writer.close();

      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      const [, , group] = mockStreams.writeMulti.mock.calls[0];
      expect(group.map((c: Uint8Array) => c[0])).toEqual([2, 3, 4]);
    });

    it('batches through a NATIVE pipeTo — no flushablePipe required', async () => {
      // The regression this rework exists for: a raw ReadableStream piped
      // with the platform pipeTo() (the cross-boundary serialization path)
      // must batch exactly like the flushablePipe path.
      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const piped = source.pipeTo(stream);

      controller.enqueue(new Uint8Array([1]));
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

      // pipeTo pulls the next chunk as soon as write() acks (buffer entry),
      // so these accumulate during the in-flight request.
      controller.enqueue(new Uint8Array([2]));
      controller.enqueue(new Uint8Array([3]));
      controller.enqueue(new Uint8Array([4]));
      await new Promise((r) => setTimeout(r, 5));
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      releaseFirst();
      controller.close();
      await piped;

      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      const [, , group] = mockStreams.writeMulti.mock.calls[0];
      expect(group.map((c: Uint8Array) => c[0])).toEqual([2, 3, 4]);
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('wire limits and backpressure', () => {
    afterEach(() => {
      delete process.env.WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS;
      delete process.env.WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH;
      delete process.env.WORKFLOW_STREAM_MAX_BYTES_PER_BATCH;
      delete process.env.WORKFLOW_STREAM_MAX_BUFFERED_BYTES;
    });

    it('splits groups at the chunk-count wire limit', async () => {
      process.env.WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH = '2';
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      for (let i = 0; i < 5; i++) await writer.write(new Uint8Array([i]));
      await writer.close();

      // 5 chunks in one commit window → requests of 2, 2, 1 in order.
      const groups = [
        ...mockStreams.writeMulti.mock.calls.map((call: unknown[]) =>
          (call[2] as Uint8Array[]).map((c) => c[0])
        ),
        ...mockStreams.write.mock.calls.map((call: unknown[]) => [
          (call[2] as Uint8Array)[0],
        ]),
      ];
      expect(groups.flat().sort()).toEqual([0, 1, 2, 3, 4]);
      for (const group of groups) expect(group.length).toBeLessThanOrEqual(2);
    });

    it('splits groups at the byte wire limit', async () => {
      process.env.WORKFLOW_STREAM_MAX_BYTES_PER_BATCH = '10';
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // 5 × 4-byte chunks: at most two fit under the 10-byte request cap.
      for (let i = 0; i < 5; i++) {
        await writer.write(new Uint8Array([i, i, i, i]));
      }
      await writer.close();

      const groups = [
        ...mockStreams.writeMulti.mock.calls.map(
          (call: unknown[]) => call[2] as Uint8Array[]
        ),
        ...mockStreams.write.mock.calls.map((call: unknown[]) => [
          call[2] as Uint8Array,
        ]),
      ];
      let delivered = 0;
      for (const group of groups) {
        const bytes = group.reduce((sum, c) => sum + c.byteLength, 0);
        expect(bytes).toBeLessThanOrEqual(10);
        delivered += group.length;
      }
      expect(delivered).toBe(5);
    });

    it('sends an oversized single chunk alone rather than stalling', async () => {
      process.env.WORKFLOW_STREAM_MAX_BYTES_PER_BATCH = '4';
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      await writer.close();

      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      const [, , chunk] = mockStreams.write.mock.calls[0];
      expect((chunk as Uint8Array).byteLength).toBe(8);
    });

    it('backpressure counts the in-flight request against the chunk bound', async () => {
      // Cap of 2 across the WHOLE read-but-not-durable population: one
      // chunk in the active request plus one buffered must block the next
      // write() until the request lands.
      process.env.WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS = '2';
      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      // request in flight
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

      // buffered(1) + inFlight(1) == bound → this write must block.
      let secondResolved = false;
      const second = writer.write(new Uint8Array([2])).then(() => {
        secondResolved = true;
      });
      await new Promise((r) => setTimeout(r, 25));
      expect(secondResolved).toBe(false);

      releaseFirst();
      await second;
      expect(secondResolved).toBe(true);

      await writer.close();
      const delivered = [
        ...mockStreams.write.mock.calls.map(
          (call: unknown[]) => (call[2] as Uint8Array)[0]
        ),
        ...mockStreams.writeMulti.mock.calls.flatMap((call: unknown[]) =>
          (call[2] as Uint8Array[]).map((c) => c[0])
        ),
      ];
      expect(delivered.sort()).toEqual([1, 2]);
    });

    it('WORKFLOW_STREAM_MAX_BUFFERED_BYTES applies byte-denominated backpressure', async () => {
      process.env.WORKFLOW_STREAM_MAX_BUFFERED_BYTES = '8';
      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array(6)); // in the active request: 6 bytes
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

      // inFlight(6B) + buffered(6B) ≥ 8B bound → blocks until the request lands.
      let secondResolved = false;
      const second = writer.write(new Uint8Array(6)).then(() => {
        secondResolved = true;
      });
      await new Promise((r) => setTimeout(r, 25));
      expect(secondResolved).toBe(false);

      releaseFirst();
      await second;
      await writer.close();
      expect(secondResolved).toBe(true);
    });
  });

  describe('dispatch settle race', () => {
    it('does not strand a chunk written in the settle gap of the previous request', async () => {
      // A write can land in the microtask window between the dispatch
      // loop's empty-buffer exit and the reaction that clears the in-flight
      // marker. In that window no group-commit timer is armed (the marker
      // is still set), so without the settle-gap re-dispatch the chunk
      // would never flush on an open stream. The mock lands the second
      // write a few microtasks after the first request resolves to aim at
      // exactly that gap; the assertion holds wherever it lands.
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      let landed = false;
      mockStreams.write.mockImplementationOnce(async () => {
        void Promise.resolve()
          .then(() => undefined)
          .then(() => {
            void writer.write(new Uint8Array([2])).then(() => {
              landed = true;
            });
          });
      });

      await writer.write(new Uint8Array([1]));

      // Both chunks must dispatch without any close/drain nudge. A
      // stranded chunk has no timer and would never arrive, so the poll
      // (bounded well above the 10ms commit window) discriminates cleanly.
      await waitFor(() => expect(landed).toBe(true));
      await waitFor(() =>
        expect(
          mockStreams.write.mock.calls.length +
            mockStreams.writeMulti.mock.calls.length
        ).toBeGreaterThanOrEqual(2)
      );
      const delivered = [
        ...mockStreams.write.mock.calls.map(
          (call: unknown[]) => (call[2] as Uint8Array)[0]
        ),
        ...mockStreams.writeMulti.mock.calls.flatMap((call: unknown[]) =>
          (call[2] as Uint8Array[]).map((c) => c[0])
        ),
      ];
      expect(delivered.sort()).toEqual([1, 2]);

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
    it('delivers the accepted prefix on abort without closing the server stream', async () => {
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // The chunk was ACKED into the buffer — abort must deliver it (the
      // early-ack durability contract) but never close the server stream.
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.abort();
      await new Promise((r) => setTimeout(r, 25));

      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.write).toHaveBeenCalledWith(
        'run-123',
        'test-stream',
        new Uint8Array([1, 2, 3])
      );
      expect(mockStreams.close).not.toHaveBeenCalled();
    });

    it('source error during native pipeTo still delivers the accepted prefix', async () => {
      // The review scenario: an AI stream emits a prefix of deltas whose
      // write()s all acked (inside the commit window), then throws. pipeTo
      // aborts the sink — the accepted prefix must still reach the World.
      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const piped = source.pipeTo(stream);

      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2]));
      controller.enqueue(new Uint8Array([3]));
      // Give pipeTo a beat to hand the chunks to the sink (all acked into
      // the buffer, commit window still open), then fail the producer.
      await new Promise((r) => setTimeout(r, 2));
      controller.error(new Error('producer failed'));

      await expect(piped).rejects.toThrow('producer failed');
      await new Promise((r) => setTimeout(r, 25));

      // Every accepted chunk was delivered; the stream was not closed.
      const delivered = [
        ...mockStreams.write.mock.calls.map(
          (call: unknown[]) => (call[2] as Uint8Array)[0]
        ),
        ...mockStreams.writeMulti.mock.calls.flatMap((call: unknown[]) =>
          (call[2] as Uint8Array[]).map((c) => c[0])
        ),
      ];
      expect(delivered).toEqual([1, 2, 3]);
      expect(mockStreams.close).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('surfaces a dispatch failure at the durability barrier (close) and poisons later writes', async () => {
      mockStreams.write.mockRejectedValueOnce(new Error('write error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      // The failing chunk's own write() already acked (buffer entry) —
      // that is the early-ack contract. The failure surfaces at the next
      // interaction with the sink.
      await writer.write(new Uint8Array([1, 2, 3]));
      await expect(writer.close()).rejects.toThrow('write error');
      expect(mockStreams.close).not.toHaveBeenCalled();
    });

    it('rejects a write that is issued after a dispatch failed (sticky error)', async () => {
      mockStreams.write.mockRejectedValueOnce(new Error('write error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      // Let the commit window dispatch and fail.
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 5));

      await expect(writer.write(new Uint8Array([2]))).rejects.toThrow(
        'write error'
      );
      // The retained chunk was not re-sent by a leaked timer.
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
    });

    it('should propagate close errors', async () => {
      mockStreams.close.mockRejectedValueOnce(new Error('close error'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));

      await expect(writer.close()).rejects.toThrow('close error');
    });

    it('should propagate write errors from the drain performed by close', async () => {
      mockStreams.write
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('flush error on close'));

      const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1, 2, 3]));
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

      await writer.write(new Uint8Array([4, 5, 6]));
      await expect(writer.close()).rejects.toThrow('flush error on close');
      expect(mockStreams.close).not.toHaveBeenCalled();
    });
  });

  describe('streamFlushIntervalMs', () => {
    it('should use world.streamFlushIntervalMs when set to 0 (immediate flush)', async () => {
      mockWorld.streamFlushIntervalMs = 0;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      // With interval=0, the commit window fires on the next timer tick.
      await writer.write(new Uint8Array([1]));
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

      await writer.close();
    });

    it('dispatches immediately by default (no world interval, default window 0)', async () => {
      delete mockWorld.streamFlushIntervalMs;

      const stream = new WorkflowServerWritableStream('s', 'run-1');
      const writer = stream.getWriter();

      await writer.write(new Uint8Array([1]));
      await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

      await writer.close();
    });

    it('a positive env window delays the LEADING chunk (opt-in batching)', async () => {
      process.env.WORKFLOW_STREAM_FLUSH_INTERVAL_MS = '60';
      vi.useFakeTimers();
      try {
        const stream = new WorkflowServerWritableStream('s', 'run-1');
        const writer = stream.getWriter();

        await writer.write(new Uint8Array([1]));
        // Inside the 60ms window: nothing dispatched yet.
        await vi.advanceTimersByTimeAsync(20);
        expect(mockStreams.write).not.toHaveBeenCalled();
        // The window elapses and the leading group goes out.
        await vi.advanceTimersByTimeAsync(45);
        expect(mockStreams.write).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
        await writer.close();
      } finally {
        vi.useRealTimers();
        delete process.env.WORKFLOW_STREAM_FLUSH_INTERVAL_MS;
      }
    });

    it('a positive world streamFlushIntervalMs delays the LEADING chunk', async () => {
      mockWorld.streamFlushIntervalMs = 50;
      vi.useFakeTimers();
      try {
        const stream = new WorkflowServerWritableStream('s', 'run-1');
        const writer = stream.getWriter();

        // The World option governs from the very first chunk.
        await writer.write(new Uint8Array([1]));
        await vi.advanceTimersByTimeAsync(25);
        expect(mockStreams.write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30);
        expect(mockStreams.write).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
        await writer.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('env WORKFLOW_STREAM_FLUSH_INTERVAL_MS overrides world.streamFlushIntervalMs', async () => {
      process.env.WORKFLOW_STREAM_FLUSH_INTERVAL_MS = '0';
      mockWorld.streamFlushIntervalMs = 50;
      try {
        const stream = new WorkflowServerWritableStream('s', 'run-1');
        const writer = stream.getWriter();

        // env 0 beats the world's 50ms window: immediate dispatch.
        await writer.write(new Uint8Array([1]));
        await waitFor(() => expect(mockStreams.write).toHaveBeenCalledTimes(1));

        await writer.close();
      } finally {
        delete process.env.WORKFLOW_STREAM_FLUSH_INTERVAL_MS;
      }
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

      // The body wrote a chunk before run_started is durable: the commit
      // window may fire, but the server write must not happen until the
      // run exists.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.write).not.toHaveBeenCalled();

      releaseBarrier();
      // close() drains: it completes only after the gated dispatch lands.
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

      // All three chunks are delivered (grouping may vary); the resolved
      // barrier gated nothing after the first dispatch.
      const delivered = [
        ...mockStreams.write.mock.calls.map(
          (call: unknown[]) => (call[2] as Uint8Array)[0]
        ),
        ...mockStreams.writeMulti.mock.calls.flatMap((call: unknown[]) =>
          (call[2] as Uint8Array[]).map((c) => c[0])
        ),
      ];
      expect(delivered.sort()).toEqual([1, 2, 3]);
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

      // Close with no chunks written: flush() short-circuits on the empty
      // buffer, so close() must apply the barrier itself.
      const closePromise = writer.close();
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.close).not.toHaveBeenCalled();

      releaseBarrier();
      await closePromise;

      expect(order).toEqual(['barrier', 'close']);
    });
  });

  describe('writeMulti batching via flushablePipe (equivalent to the native path)', () => {
    it('coalesces chunks that arrive during an in-flight write into one writeMulti', async () => {
      // Hold the first server write in flight so the chunks produced while it
      // is pending accumulate and flush together via writeMulti. Without the
      // coalescing pipe, each chunk would be its own single write() and
      // writeMulti would never be called with more than one chunk.
      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });

      const serverWritable = new WorkflowServerWritableStream(
        'run-123',
        'test-stream'
      );
      const state = createFlushableState();

      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });

      const pipe = flushablePipe(source, serverWritable, state).catch(() => {});

      // First chunk goes out alone (a single write) and blocks in flight.
      controller.enqueue(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 25));
      expect(mockStreams.write).toHaveBeenCalledTimes(1);
      expect(mockStreams.writeMulti).not.toHaveBeenCalled();

      // Three more chunks arrive while the first write is in flight.
      controller.enqueue(new Uint8Array([2]));
      controller.enqueue(new Uint8Array([3]));
      controller.enqueue(new Uint8Array([4]));
      await new Promise((r) => setTimeout(r, 10));

      // Release the first write; the queued chunks flush as ONE writeMulti.
      releaseFirst();
      controller.close();
      await pipe;

      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      const [, , batched] = mockStreams.writeMulti.mock.calls[0];
      expect(batched.map((c: Uint8Array) => c[0])).toEqual([2, 3, 4]);
      expect(mockStreams.close).toHaveBeenCalledTimes(1);
      await expect(state.promise).resolves.toBeUndefined();
    });

    it('falls back to sequential writes when the world lacks writeMulti', async () => {
      delete (mockStreams as { writeMulti?: unknown }).writeMulti;

      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });

      const serverWritable = new WorkflowServerWritableStream(
        'run-123',
        'test-stream'
      );
      const state = createFlushableState();

      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const pipe = flushablePipe(source, serverWritable, state).catch(() => {});

      controller.enqueue(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 25));
      controller.enqueue(new Uint8Array([2]));
      controller.enqueue(new Uint8Array([3]));
      await new Promise((r) => setTimeout(r, 10));
      releaseFirst();
      controller.close();
      await pipe;

      // All three chunks are delivered via sequential write() calls.
      expect(mockStreams.write).toHaveBeenCalledTimes(3);
      const delivered = mockStreams.write.mock.calls.map(
        (call: unknown[]) => (call[2] as Uint8Array)[0]
      );
      expect(delivered).toEqual([1, 2, 3]);
      await expect(state.promise).resolves.toBeUndefined();
    });

    it('errors the stream on a failed batch without re-sending or closing', async () => {
      // Let the first (single) write land, then make the coalesced writeMulti
      // fail. flush() retains the batch in the buffer and rethrows; the pipe
      // errors. Nothing should re-send the buffered chunks or close the stream.
      let releaseFirst!: () => void;
      const firstInFlight = new Promise<void>((r) => {
        releaseFirst = r;
      });
      mockStreams.write.mockImplementationOnce(async () => {
        await firstInFlight;
      });
      mockStreams.writeMulti.mockRejectedValueOnce(new Error('batch failed'));

      const serverWritable = new WorkflowServerWritableStream(
        'run-123',
        'test-stream'
      );
      const state = createFlushableState();

      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const pipe = flushablePipe(source, serverWritable, state).catch(() => {});

      controller.enqueue(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 25));
      controller.enqueue(new Uint8Array([2]));
      controller.enqueue(new Uint8Array([3]));
      await new Promise((r) => setTimeout(r, 10));
      releaseFirst();
      // Let the failed batch settle; the sink is now poisoned. The writes
      // already acked (buffer entry), so the failure surfaces when the pipe
      // closes the sink — its drain rethrows the sticky error.
      await new Promise((r) => setTimeout(r, 10));
      controller.close();
      await pipe;

      await expect(state.promise).rejects.toThrow('batch failed');
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.close).not.toHaveBeenCalled();

      // Wait past any flush interval: the retained chunks are not re-sent by a
      // leaked timer or later path, and the stream stays closed-off.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockStreams.writeMulti).toHaveBeenCalledTimes(1);
      expect(mockStreams.close).not.toHaveBeenCalled();
    });
  });
});
