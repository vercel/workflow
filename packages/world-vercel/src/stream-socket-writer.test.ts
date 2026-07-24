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

/** One fake channel; the test drives acks, fin-acks, and closes by hand. */
class FakeConnection {
  sent: Uint8Array[] = [];
  closedByWriter = false;
  finSent = false;
  readonly channel: StreamWriteChannel;
  private acked = 0;

  constructor(
    readonly handlers: StreamWriteChannelHandlers,
    withFin = false
  ) {
    this.channel = {
      send: (chunk) => this.sent.push(chunk),
      close: () => {
        this.closedByWriter = true;
      },
      ...(withFin
        ? {
            fin: () => {
              this.finSent = true;
            },
          }
        : {}),
    };
  }

  /** Ack the next unacked message on this connection (in order). */
  ackNext(chunkIndex?: number) {
    const index = this.acked++;
    this.handlers.onAck({ index, chunkIndex: chunkIndex ?? 100 + index });
  }

  /** Confirm finalization (server flushed its final accounting). */
  finAck() {
    this.handlers.onFinAck?.();
  }

  /** Unclean end (server bound hit, network cut, deploy). */
  die(reason = 'connection cut') {
    this.handlers.onClose({ code: 1006, reason });
  }
}

/** Deterministic harness: manual timers, recorded connections. */
function makeHarness(
  config?: Partial<SocketWriterConfig>,
  opts?: { fin?: boolean; random?: () => number }
) {
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
        const connection = new FakeConnection(handlers, opts?.fin);
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
      ...(opts?.random ? { random: opts.random } : {}),
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
    /**
     * Fire and remove the oldest pending timer — or, given `ms`, the oldest
     * timer armed with that exact duration (to pick one timer apart from
     * others pending concurrently).
     */
    fireTimer: (ms?: number) => {
      const index =
        ms === undefined ? 0 : timers.findIndex((timer) => timer.ms === ms);
      if (index < 0 || index >= timers.length) {
        throw new Error('no pending timer');
      }
      const [timer] = timers.splice(index, 1);
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

  it('jitters the reconnect backoff so shed writers do not march back in lockstep', async () => {
    // Writers are shed in correlated groups (instance pressure, or a shared
    // per-tenant server rate window), so an unjittered fixed backoff would
    // reconnect them all at the same instant and rebuild the same burst.
    const delaysFor = async (random: () => number) => {
      const h = makeHarness({ reconnectBackoffMs: [1000] }, { random });
      await h.writer.write(frame(1));
      await tick();
      h.connections[0].die();
      await tick();
      return h.timers.map((t) => t.ms);
    };

    // Full jitter over [base/2, base): the spread is what breaks lockstep.
    expect(await delaysFor(() => 0)).toContain(500);
    expect(await delaysFor(() => 0.999)).toContain(1000);
    // Never zero, so a pathological random can't turn into a hot loop.
    expect((await delaysFor(() => 0)).every((ms) => ms >= 1)).toBe(true);
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

  it('close() completes the FIN/FIN_ACK exchange before closing the channel', async () => {
    const h = makeHarness({}, { fin: true });

    await h.writer.write(frame(1));
    await tick();
    h.connections[0].ackNext();

    let closed = false;
    const closePromise = h.writer.close().then(() => {
      closed = true;
    });
    await tick();

    // Drained and FIN sent — but the channel stays open and close() pends
    // until the server confirms its final accounting with FIN_ACK.
    expect(h.connections[0].finSent).toBe(true);
    expect(closed).toBe(false);
    expect(h.connections[0].closedByWriter).toBe(false);

    h.connections[0].finAck();
    await closePromise;
    expect(h.connections[0].closedByWriter).toBe(true);
  });

  it('close() proceeds after the FIN_ACK deadline when the server never confirms', async () => {
    const h = makeHarness({ finAckTimeoutMs: 77 }, { fin: true });

    await h.writer.write(frame(1));
    await tick();
    h.connections[0].ackNext();

    let closed = false;
    const closePromise = h.writer.close().then(() => {
      closed = true;
    });
    await tick();
    expect(h.connections[0].finSent).toBe(true);
    expect(closed).toBe(false);

    // Every frame is acked (durable); a lost FIN_ACK only affects the
    // ordering of the server's final accounting, so close() must not hang
    // on it forever.
    h.fireTimer(77);
    await closePromise;
    expect(h.connections[0].closedByWriter).toBe(true);
  });

  it('tears down and resends when no ack arrives within the liveness deadline', async () => {
    const h = makeHarness({ ackDeadlineMs: 5_000 });

    await h.writer.write(frame(1));
    await tick();
    expect(h.connections).toHaveLength(1);

    // A half-open connection delivers neither acks nor a close event; the
    // deadline is the only thing that can unstick the writer.
    h.fireTimer(5_000); // ack liveness deadline
    h.fireTimer(); // reconnect backoff
    await tick();

    expect(h.connections).toHaveLength(2);
    expect(h.connections[1].sent.map((f) => f[0])).toEqual([1]);
    h.connections[1].ackNext();
    await h.writer.close();
  });

  it('releases a drained channel after the idle timeout; the next write reconnects', async () => {
    const h = makeHarness({ idleCloseMs: 42 });

    await h.writer.write(frame(1));
    await tick();
    h.connections[0].ackNext();
    await tick();

    // Fully drained: the idle timeout releases the socket instead of
    // pinning it (and its server-side invocation) until the recycle.
    h.fireTimer(42);
    expect(h.connections[0].closedByWriter).toBe(true);

    await h.writer.write(frame(2));
    await tick();
    expect(h.connections).toHaveLength(2);
    expect(h.connections[1].sent.map((f) => f[0])).toEqual([2]);
    h.connections[1].ackNext();
    await h.writer.close();
  });

  it('stashes unconfirmed frames for fallback redelivery on failure, but not on abort', async () => {
    const h = makeHarness({ maxConsecutiveReconnects: 0 });

    await h.writer.write(frame(1));
    await h.writer.write(frame(2));
    await tick();
    h.connections[0].ackNext(); // frame 1 durable
    h.connections[0].die();
    await tick();
    await expect(h.writer.write(frame(3))).rejects.toThrow(/failed/);

    // Only the unconfirmed frame is handed over; the acked frame is not.
    // Taking transfers ownership — a second take is empty.
    expect(h.writer.takeAbandonedFrames().map((f) => f[0])).toEqual([2]);
    expect(h.writer.takeAbandonedFrames()).toEqual([]);

    // A deliberate abort really abandons frames: nothing to redeliver.
    const h2 = makeHarness();
    await h2.writer.write(frame(9));
    await tick();
    h2.writer.abort('step failed');
    expect(h2.writer.takeAbandonedFrames()).toEqual([]);
  });
});
