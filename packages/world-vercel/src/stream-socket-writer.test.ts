import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SOCKET_WRITER_CONFIG,
  resolveSocketWriterConfig,
  type SocketWriterConfig,
  StreamSocketWriter,
  type StreamWriteChannel,
  type StreamWriteChannelHandlers,
} from './stream-socket-writer.js';

const frame = (...bytes: number[]) => new Uint8Array(bytes);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One fake channel; the test drives acks and closes by hand. */
class FakeConnection {
  sent: Uint8Array[] = [];
  closedByWriter = false;
  readonly channel: StreamWriteChannel;
  private acked = 0;

  constructor(readonly handlers: StreamWriteChannelHandlers) {
    this.channel = {
      send: (chunk) => this.sent.push(chunk),
      close: () => {
        this.closedByWriter = true;
      },
    };
  }

  /** Ack the next unacked message on this connection (in order). */
  ackNext(chunkIndex?: number) {
    const index = this.acked++;
    this.handlers.onAck({ index, chunkIndex: chunkIndex ?? 100 + index });
  }

  /** Unclean end (server bound hit, network cut, deploy). */
  die(reason = 'connection cut') {
    this.handlers.onClose({ code: 1006, reason });
  }
}

/** Deterministic harness: manual timers, recorded connections. */
function makeHarness(config?: Partial<SocketWriterConfig>) {
  const connections: FakeConnection[] = [];
  let failNextConnects = 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const ensureReady = vi.fn(async () => {});

  const writer = new StreamSocketWriter(
    {
      connect: async (handlers) => {
        if (failNextConnects > 0) {
          failNextConnects--;
          throw new Error('connect refused');
        }
        const connection = new FakeConnection(handlers);
        connections.push(connection);
        return connection.channel;
      },
      ensureReady,
      setTimer: (fn, ms) => {
        const handle = { fn, ms };
        timers.push(handle);
        return handle;
      },
      clearTimer: (handle) => {
        const i = timers.indexOf(handle as { fn: () => void; ms: number });
        if (i >= 0) timers.splice(i, 1);
      },
    },
    config
  );

  return {
    writer,
    connections,
    ensureReady,
    timers,
    failConnects: (n: number) => {
      failNextConnects = n;
    },
    /** Fire and remove the oldest pending timer. */
    fireTimer: () => {
      const timer = timers.shift();
      if (!timer) throw new Error('no pending timer');
      timer.fn();
    },
  };
}

describe('resolveSocketWriterConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the compiled-in defaults when no env overrides are set', () => {
    expect(resolveSocketWriterConfig()).toEqual(DEFAULT_SOCKET_WRITER_CONFIG);
  });

  it('resolves WORKFLOW_STREAM_WRITE_* env overrides per knob', () => {
    vi.stubEnv('WORKFLOW_STREAM_WRITE_RECYCLE_MS', '3000');
    vi.stubEnv('WORKFLOW_STREAM_WRITE_MAX_IN_FLIGHT_FRAMES', '2');
    vi.stubEnv('WORKFLOW_STREAM_WRITE_MAX_IN_FLIGHT_BYTES', '1024');
    const config = resolveSocketWriterConfig();
    expect(config.recycleMs).toBe(3000);
    expect(config.maxInFlightFrames).toBe(2);
    expect(config.maxInFlightBytes).toBe(1024);
    // Untouched knobs keep their defaults.
    expect(config.maxConsecutiveReconnects).toBe(
      DEFAULT_SOCKET_WRITER_CONFIG.maxConsecutiveReconnects
    );
    expect(config.maxTotalReconnects).toBe(
      DEFAULT_SOCKET_WRITER_CONFIG.maxTotalReconnects
    );
  });

  it('clamps the recycle interval to its floor (connection-churn guard)', () => {
    vi.stubEnv('WORKFLOW_STREAM_WRITE_RECYCLE_MS', '1');
    expect(resolveSocketWriterConfig().recycleMs).toBe(250);
  });

  it('explicit constructor config wins over env overrides', () => {
    vi.stubEnv('WORKFLOW_STREAM_WRITE_MAX_IN_FLIGHT_FRAMES', '7');
    const h = makeHarness({ maxInFlightFrames: 3 });
    // Reach through the public backpressure behavior: the 4th write blocks.
    void h.writer.write(frame(1));
    void h.writer.write(frame(2));
    void h.writer.write(frame(3));
    let fourthAccepted = false;
    void h.writer.write(frame(4)).then(() => {
      fourthAccepted = true;
    });
    return tick().then(() => expect(fourthAccepted).toBe(false));
  });
});

describe('StreamSocketWriter', () => {
  it('lazily connects once, sends in order, and close waits for all acks', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await h.writer.write(frame(2));
    await tick();

    expect(h.connections).toHaveLength(1);
    expect(h.ensureReady).toHaveBeenCalledTimes(1);
    expect(h.connections[0].sent.map((f) => f[0])).toEqual([1, 2]);

    let closed = false;
    const closePromise = h.writer.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false); // nothing acked yet

    h.connections[0].ackNext();
    await tick();
    expect(closed).toBe(false); // one of two acked

    h.connections[0].ackNext();
    await closePromise;
    expect(h.connections[0].closedByWriter).toBe(true);
    expect(h.writer.pendingCount).toBe(0);
  });

  it('applies window backpressure and releases it on acks', async () => {
    const h = makeHarness({ maxInFlightFrames: 2 });

    await h.writer.write(frame(1));
    await h.writer.write(frame(2));
    let thirdAccepted = false;
    const third = h.writer.write(frame(3)).then(() => {
      thirdAccepted = true;
    });
    await tick();
    expect(thirdAccepted).toBe(false); // window full

    h.connections[0].ackNext();
    await third;
    expect(thirdAccepted).toBe(true);
    await tick();
    expect(h.connections[0].sent.map((f) => f[0])).toEqual([1, 2, 3]);
  });

  it('resends every unacked frame on a fresh channel after an unclean close', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await h.writer.write(frame(2));
    await h.writer.write(frame(3));
    await tick();
    h.connections[0].ackNext(); // frame 1 durable

    h.connections[0].die();
    h.fireTimer(); // reconnect backoff
    await tick();

    expect(h.connections).toHaveLength(2);
    // Frames 2 and 3 were unacked — both resent, in order; frame 1 is not.
    expect(h.connections[1].sent.map((f) => f[0])).toEqual([2, 3]);

    // Acks on the new channel restart at index 0 and drain the writer.
    h.connections[1].ackNext();
    h.connections[1].ackNext();
    await h.writer.close();
    expect(h.writer.pendingCount).toBe(0);
  });

  it('tears down and resends when an ack arrives out of sequence', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await h.writer.write(frame(2));
    await tick();

    // Server claims to ack message 1 while message 0 is still unacked.
    h.connections[0].handlers.onAck({ index: 1, chunkIndex: 101 });
    h.fireTimer(); // reconnect backoff
    await tick();

    expect(h.connections[0].closedByWriter).toBe(true);
    expect(h.connections).toHaveLength(2);
    expect(h.connections[1].sent.map((f) => f[0])).toEqual([1, 2]);
  });

  it('fails the writer after the consecutive-reconnect budget', async () => {
    const h = makeHarness({
      maxConsecutiveReconnects: 2,
      reconnectBackoffMs: [1],
    });

    await h.writer.write(frame(1));
    await tick();

    h.connections[0].die();
    h.fireTimer();
    await tick();
    h.connections[1].die();
    h.fireTimer();
    await tick();
    h.connections[2].die(); // third consecutive failure > budget of 2
    await tick();

    await expect(h.writer.write(frame(2))).rejects.toThrow(
      /failed 3 times in a row/
    );
    await expect(h.writer.close()).rejects.toThrow(/failed 3 times in a row/);
  });

  it('an ack resets the consecutive-failure budget', async () => {
    const h = makeHarness({
      maxConsecutiveReconnects: 2,
      reconnectBackoffMs: [1],
    });

    await h.writer.write(frame(1));
    await tick();
    h.connections[0].die();
    h.fireTimer();
    await tick();
    h.connections[1].die();
    h.fireTimer();
    await tick();

    // Two consecutive failures so far; an ack on the third connection resets.
    h.connections[2].ackNext();
    await tick();

    await h.writer.write(frame(2));
    await tick();
    h.connections[2].die();
    h.fireTimer();
    await tick();

    // Still under budget thanks to the reset; the writer reconnected.
    expect(h.connections).toHaveLength(4);
    expect(h.connections[3].sent.map((f) => f[0])).toEqual([2]);
  });

  it('survives a connect() rejection and retries with backoff', async () => {
    const h = makeHarness({ reconnectBackoffMs: [5, 10] });
    h.failConnects(1);

    await h.writer.write(frame(7));
    await tick();
    expect(h.connections).toHaveLength(0);

    h.fireTimer(); // backoff after the failed connect
    await tick();
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0].sent.map((f) => f[0])).toEqual([7]);
  });

  it('recycles the channel proactively once in-flight frames drain', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await tick();

    // The recycle timer fires while frame 1 is still unacked: rotation waits.
    expect(h.timers[0]?.ms).toBe(DEFAULT_SOCKET_WRITER_CONFIG.recycleMs);
    h.fireTimer();
    await tick();
    expect(h.connections[0].closedByWriter).toBe(false);

    // Once acked, the old channel closes cleanly; the next write opens a new
    // one and starts its ordinals from 0.
    h.connections[0].ackNext();
    await tick();
    expect(h.connections[0].closedByWriter).toBe(true);

    await h.writer.write(frame(2));
    await tick();
    expect(h.connections).toHaveLength(2);
    expect(h.connections[1].sent.map((f) => f[0])).toEqual([2]);
    h.connections[1].ackNext();
    await h.writer.close();
  });

  it('close() drain completes when the recycle rotation races the final ack', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await tick();

    let closed = false;
    const closePromise = h.writer.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);

    // The recycle timer fires while the drain is pending, so the rotation
    // completes on the same ack that empties the buffer. The drain must
    // still resolve — rotation tearing down the channel used to strand it.
    h.fireTimer();
    await tick();
    h.connections[0].ackNext();
    await closePromise;
    expect(h.connections[0].closedByWriter).toBe(true);
  });

  it('fails immediately with a chunk-size error on a 1009 close (no resend loop)', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await h.writer.write(new Uint8Array(2048));
    await tick();

    // Server (`ws` maxPayload) rejects the oversized message and closes with
    // 1009. Resending would fail deterministically, so the writer must not
    // burn its reconnect budget on it.
    h.connections[0].handlers.onClose({ code: 1009, reason: '' });

    await expect(h.writer.write(frame(2))).rejects.toThrow(
      /too large.*2048 bytes/
    );
    expect(h.connections).toHaveLength(1); // no reconnect attempted
    expect(h.timers).toHaveLength(0); // no backoff timer armed
  });

  it('ackBarrier resolves once frames admitted before the call are acked', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await h.writer.write(frame(2));
    const barrier = h.writer.ackBarrier();
    let settled = false;
    void barrier.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    h.connections[0].ackNext();
    await tick();
    expect(settled).toBe(false); // one of two acked

    h.connections[0].ackNext();
    await barrier;

    // Later writes don't re-arm an already-satisfied barrier, and a barrier
    // taken while fully drained resolves immediately.
    await expect(h.writer.ackBarrier()).resolves.toBeUndefined();
  });

  it('ackBarrier resolves (not rejects) when the writer fails', async () => {
    const h = makeHarness({
      maxConsecutiveReconnects: 0,
      reconnectBackoffMs: [1],
    });

    await h.writer.write(frame(1));
    await tick();
    const barrier = h.writer.ackBarrier();

    h.connections[0].die();
    await tick();

    // The barrier only extends the function's lifetime; the failure itself
    // surfaces through write()/close().
    await expect(barrier).resolves.toBeUndefined();
    await expect(h.writer.close()).rejects.toThrow(/failed/);
  });

  it('abort drops the buffer, closes the channel, and poisons the writer', async () => {
    const h = makeHarness();

    await h.writer.write(frame(1));
    await tick();
    h.writer.abort('step failed');

    expect(h.connections[0].closedByWriter).toBe(true);
    expect(h.writer.pendingCount).toBe(0);
    await expect(h.writer.write(frame(2))).rejects.toThrow(/aborted/);
  });

  it('close() on a never-written writer resolves without connecting', async () => {
    const h = makeHarness();
    await h.writer.close();
    expect(h.connections).toHaveLength(0);
    await expect(h.writer.write(frame(1))).rejects.toThrow(/already closed/);
  });
});
