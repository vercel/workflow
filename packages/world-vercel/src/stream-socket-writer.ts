// ============================================================================
// Ack-driven stream writer over a WebSocket write channel
// ============================================================================
//
// One writer owns one logical stream and carries it over a sequence of write
// channels (WebSocket connections opened by the streamer). Frames are sent as they are produced;
// the backend persists + publishes each frame on arrival and acks it back on
// the channel, in order. An acked frame is durable and is dropped from the
// local replay buffer immediately — memory is bounded by the in-flight window
// (`maxInFlightFrames` / `maxInFlightBytes`), not by connection lifetime.
//
// Channels are not durable: the platform bounds a connection to the route's
// max duration, deploys and network cuts kill it uncleanly, and the writer
// itself recycles it proactively (`recycleMs`, kept well under the server
// bound so the common path is a clean local close). Whenever a channel ends
// with frames still unacked, those frames may or may not have persisted — the
// writer reconnects and resends all of them, and the framing layer's
// read-side dedupe (framed-v2 writerId+seq markers) makes the overlap safe.
//
// Ordering: frames are sent in write order, resent in the same order, and the
// server acks in arrival order. Each ack's `index` must match the oldest
// unacked frame's per-connection ordinal; a mismatch means the two sides
// disagree about the connection state, and the writer tears the channel down
// and resends rather than guessing.

import { WorkflowRuntimeError } from '@workflow/errors';
import { envNumber } from '@workflow/world';

/**
 * One acknowledgement on a write channel. `index` is the 0-based ordinal of
 * the chunk within the channel (send order); `chunkIndex` is the backend
 * index it persisted under. Acks arrive in send order, so an ack also
 * confirms every earlier chunk on the same channel.
 */
export interface StreamWriteAck {
  index: number;
  chunkIndex: number;
}

/** Callbacks for one write channel. */
export interface StreamWriteChannelHandlers {
  /** A chunk (and, by ordering, all chunks before it) is durable. */
  onAck(ack: StreamWriteAck): void;
  /**
   * The channel closed — fires exactly once, whether the close was clean
   * (caller-initiated or backend connection bound) or a failure. After it,
   * nothing more will be acked on this channel.
   */
  onClose(event: { code?: number; reason?: string }): void;
}

/** A live write channel (one WebSocket connection). */
export interface StreamWriteChannel {
  /** Queue one chunk for delivery. Fire-and-forget; durability is signaled via onAck. */
  send(chunk: Uint8Array): void;
  /** Close the channel. Chunks already sent may still be acked before onClose. */
  close(): void;
}

/** Injected transport + scheduling dependencies (all test-fakeable). */
export interface SocketWriterDeps {
  /** Open a fresh write channel for this stream. */
  connect(handlers: StreamWriteChannelHandlers): Promise<StreamWriteChannel>;
  /**
   * Awaited once before the first channel is opened (e.g. the turbo-mode
   * run-ready barrier — the run row must exist before the first chunk).
   */
  ensureReady?(): Promise<void>;
  /** Injectable timer hooks so tests control recycle/backoff deterministically. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface SocketWriterConfig {
  /**
   * Proactively rotate the channel after this long, so the server's own
   * connection bound is (almost) never hit and rotation stays a clean,
   * fully-acked local close. Keep comfortably under the server route's
   * max duration.
   */
  recycleMs: number;
  /** Frame-count cap on the unacked + unsent window (producer backpressure). */
  maxInFlightFrames: number;
  /** Byte cap on the unacked + unsent window (producer backpressure). */
  maxInFlightBytes: number;
  /** Consecutive failed connections (no ack in between) before giving up. */
  maxConsecutiveReconnects: number;
  /** Lifetime unclean-reconnect budget for one writer. */
  maxTotalReconnects: number;
  /** Backoff between unclean reconnects (last entry repeats). */
  reconnectBackoffMs: number[];
}

export const DEFAULT_SOCKET_WRITER_CONFIG: SocketWriterConfig = {
  // Two-minute connections, rotated with ~10s of headroom under the server
  // route's 150s maxDuration.
  recycleMs: 110_000,
  // Must stay comfortably below the server's per-connection backlog cap
  // (100 received-but-unprocessed chunks): the server sheds a connection
  // whose backlog exceeds it, and a client window at or above the cap could
  // shed → resend → shed in a loop until the reconnect budget dies.
  maxInFlightFrames: 64,
  maxInFlightBytes: 4 * 1024 * 1024,
  maxConsecutiveReconnects: 5,
  maxTotalReconnects: 64,
  reconnectBackoffMs: [100, 500, 2000],
};

/**
 * Effective writer config: each numeric knob reads a `WORKFLOW_STREAM_WRITE_*`
 * env override (for dedicated e2e deployments that dial limits down so the
 * suite exercises rotation, backpressure, and reconnect paths quickly),
 * falling back to {@link DEFAULT_SOCKET_WRITER_CONFIG}. Explicit constructor
 * config takes precedence over both. The recycle floor keeps a misconfigured
 * override from thrashing the backend with connection churn — every rotation
 * costs a full authenticated upgrade.
 */
export function resolveSocketWriterConfig(): SocketWriterConfig {
  const defaults = DEFAULT_SOCKET_WRITER_CONFIG;
  return {
    recycleMs: envNumber(
      'WORKFLOW_STREAM_WRITE_RECYCLE_MS',
      defaults.recycleMs,
      {
        integer: true,
        min: 250,
      }
    ),
    maxInFlightFrames: envNumber(
      'WORKFLOW_STREAM_WRITE_MAX_IN_FLIGHT_FRAMES',
      defaults.maxInFlightFrames,
      { integer: true, min: 1 }
    ),
    maxInFlightBytes: envNumber(
      'WORKFLOW_STREAM_WRITE_MAX_IN_FLIGHT_BYTES',
      defaults.maxInFlightBytes,
      { integer: true, min: 1 }
    ),
    maxConsecutiveReconnects: envNumber(
      'WORKFLOW_STREAM_WRITE_MAX_CONSECUTIVE_RECONNECTS',
      defaults.maxConsecutiveReconnects,
      { integer: true }
    ),
    maxTotalReconnects: envNumber(
      'WORKFLOW_STREAM_WRITE_MAX_TOTAL_RECONNECTS',
      defaults.maxTotalReconnects,
      { integer: true }
    ),
    reconnectBackoffMs: defaults.reconnectBackoffMs,
  };
}

interface BufferedFrame {
  frame: Uint8Array;
  /** Ordinal this frame was sent under on the current channel, if sent. */
  sentIndex: number | null;
}

/**
 * Ack-driven writer over WebSocket write channels. `write` resolves once the
 * frame is accepted into the in-flight window (backpressure), not when it is
 * durable; `close` resolves only after every written frame has been acked.
 */
export class StreamSocketWriter {
  private readonly deps: SocketWriterDeps;
  private readonly config: SocketWriterConfig;

  private channel: StreamWriteChannel | null = null;
  private connecting = false;
  /** Guards stale channel callbacks after a rotation/reconnect. */
  private epoch = 0;
  private sentInEpoch = 0;

  /** Written frames not yet acked, oldest first (sent prefix, then unsent). */
  private buffer: BufferedFrame[] = [];
  private bufferedBytes = 0;

  /** Producer backpressure waiters (window full). */
  private waiters: (() => void)[] = [];
  /** close() waiter, resolved when the buffer fully drains. */
  private drainWaiter: (() => void) | null = null;

  private rotateRequested = false;
  private closedDone = false;
  private fatalError: Error | null = null;

  private consecutiveReconnects = 0;
  private totalReconnects = 0;
  private recycleTimer: unknown = null;
  private ensureReadyPromise: Promise<void> | null = null;

  /** Lifetime counters + waiters backing {@link ackBarrier}. */
  private admitted = 0;
  private acked = 0;
  private ackBarriers: { threshold: number; resolve: () => void }[] = [];

  constructor(deps: SocketWriterDeps, config?: Partial<SocketWriterConfig>) {
    this.deps = deps;
    this.config = { ...resolveSocketWriterConfig(), ...config };
  }

  /** Frames written but not yet acked (exposed for tests/diagnostics). */
  get pendingCount(): number {
    return this.buffer.length;
  }

  async write(frame: Uint8Array): Promise<void> {
    this.throwIfUnusable();
    while (
      this.buffer.length >= this.config.maxInFlightFrames ||
      this.bufferedBytes >= this.config.maxInFlightBytes
    ) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.throwIfUnusable();
    }
    this.buffer.push({ frame, sentIndex: null });
    this.bufferedBytes += frame.byteLength;
    this.admitted++;
    this.pump();
  }

  /**
   * Resolves once every frame admitted before this call has been acked (or
   * the writer has failed/aborted). It never rejects: its consumer is
   * platform lifetime extension (`waitUntil`, so a function invocation is
   * not suspended while admitted frames are still awaiting durability
   * confirmation), not error propagation — write failures surface through
   * `write()`/`close()`.
   */
  ackBarrier(): Promise<void> {
    if (this.fatalError || this.acked >= this.admitted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.ackBarriers.push({ threshold: this.admitted, resolve });
    });
  }

  /** Resolves once every written frame is durable and the channel is closed. */
  async close(): Promise<void> {
    this.throwIfUnusable();
    if (this.buffer.length > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiter = resolve;
        this.pump();
      });
      this.throwIfUnusable();
    }
    this.teardownChannel();
    this.closedDone = true;
  }

  /** Drop everything immediately; unacked frames are abandoned. */
  abort(reason?: unknown): void {
    this.fail(
      reason instanceof Error
        ? reason
        : new WorkflowRuntimeError(
            `Stream socket writer aborted${reason ? `: ${String(reason)}` : ''}`
          )
    );
  }

  // --- internals ----------------------------------------------------------

  private throwIfUnusable(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.closedDone) {
      throw new WorkflowRuntimeError('Stream socket writer is already closed');
    }
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.teardownChannel();
    this.buffer = [];
    this.bufferedBytes = 0;
    this.releaseWaiters();
    this.drainWaiter?.();
    this.drainWaiter = null;
    // Ack barriers only extend the function's lifetime; on failure there is
    // nothing left to wait for (the error surfaces through write/close).
    const barriers = this.ackBarriers;
    this.ackBarriers = [];
    for (const { resolve } of barriers) resolve();
  }

  private releaseWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Close the current channel locally. Bumping the epoch first makes the
   * channel's own late onClose callback a stale no-op, so a local close never
   * takes the unclean-reconnect path.
   */
  private teardownChannel(): void {
    if (this.recycleTimer !== null) {
      (this.deps.clearTimer ?? clearTimeout)(this.recycleTimer as never);
      this.recycleTimer = null;
    }
    if (this.channel) {
      const channel = this.channel;
      this.channel = null;
      this.epoch++;
      channel.close();
    }
  }

  /** Send whatever the window allows; lazily (re)open the channel. */
  private pump(): void {
    if (this.fatalError) return;
    if (this.buffer.length === 0) {
      // Fully drained. Settle a pending close() FIRST — resolving the drain
      // must not depend on channel state, or a rotation completing on the
      // final ack would tear the channel down and strand the waiter forever.
      if (this.drainWaiter) {
        const resolve = this.drainWaiter;
        this.drainWaiter = null;
        resolve();
      }
      // An empty buffer satisfies a pending rotation immediately.
      if (this.rotateRequested && this.channel) {
        this.rotateRequested = false;
        this.teardownChannel();
      }
      return;
    }
    if (!this.channel) {
      void this.ensureChannel();
      return;
    }
    if (this.rotateRequested) {
      // Stop feeding the old channel; once its sent frames are all acked,
      // rotate to a fresh one.
      if (!this.buffer.some((f) => f.sentIndex !== null)) {
        this.rotateRequested = false;
        this.teardownChannel();
        this.pump();
      }
      return;
    }
    for (const entry of this.buffer) {
      if (entry.sentIndex !== null) continue;
      entry.sentIndex = this.sentInEpoch++;
      this.channel.send(entry.frame);
    }
  }

  private async ensureChannel(): Promise<void> {
    if (this.channel || this.connecting || this.fatalError) return;
    this.connecting = true;
    // Claim this connect attempt's epoch up front so the captured value stays
    // stable across the whole attempt. The transport may deliver its own
    // onClose (which drives onChannelClose with this epoch) *before* the
    // connect promise rejects; passing the captured epoch — rather than the
    // live this.epoch — into the catch keeps the second call a stale no-op, so
    // one failed connect counts as exactly one reconnect.
    const epoch = ++this.epoch;
    this.sentInEpoch = 0;
    try {
      if (this.deps.ensureReady) {
        this.ensureReadyPromise ??= this.deps.ensureReady();
        await this.ensureReadyPromise;
      }
      const channel = await this.deps.connect({
        onAck: (ack) => this.onAck(epoch, ack.index),
        onClose: (event) => this.onChannelClose(epoch, event),
      });
      if (epoch !== this.epoch || this.fatalError) {
        // The writer moved on (abort/rotate) while we were connecting.
        channel.close();
        return;
      }
      this.channel = channel;
      this.startRecycleTimer();
      this.pump();
    } catch (error) {
      this.connecting = false;
      this.onChannelClose(epoch, {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.connecting = false;
  }

  private startRecycleTimer(): void {
    const setTimer = this.deps.setTimer ?? setTimeout;
    this.recycleTimer = setTimer(() => {
      this.rotateRequested = true;
      this.pump();
    }, this.config.recycleMs);
  }

  private onAck(epoch: number, index: number): void {
    if (epoch !== this.epoch || this.fatalError) return;
    const head = this.buffer[0];
    if (!head || head.sentIndex !== index) {
      // The two sides disagree about connection state; resend rather than
      // guess. Read-side dedupe absorbs any overlap.
      this.forceReconnect('ack out of sequence');
      return;
    }
    this.buffer.shift();
    this.bufferedBytes -= head.frame.byteLength;
    this.acked++;
    if (this.ackBarriers.length > 0) {
      const still = this.ackBarriers.filter((barrier) => {
        if (barrier.threshold <= this.acked) {
          barrier.resolve();
          return false;
        }
        return true;
      });
      this.ackBarriers = still;
    }
    this.consecutiveReconnects = 0;
    this.releaseWaiters();
    this.pump();
  }

  /**
   * A channel ended without the writer closing it (server bound, network cut,
   * connect failure, or forced reconnect). Local closes never land here —
   * {@link teardownChannel} bumps the epoch first, so their events are stale.
   */
  private onChannelClose(
    epoch: number,
    event: { code?: number; reason?: string }
  ): void {
    if (epoch !== this.epoch || this.fatalError) return;
    this.channel = null;
    this.epoch++;
    if (this.recycleTimer !== null) {
      (this.deps.clearTimer ?? clearTimeout)(this.recycleTimer as never);
      this.recycleTimer = null;
    }

    // 1009 (message too big) is deterministic: the server's per-message size
    // cap rejected a frame, and resending would hit the same cap until the
    // reconnect budget dies with an opaque error. Fail immediately with the
    // actual cause instead.
    if (event.code === 1009) {
      const largest = this.buffer.reduce(
        (max, entry) => Math.max(max, entry.frame.byteLength),
        0
      );
      this.fail(
        new WorkflowRuntimeError(
          `Stream write channel rejected a chunk as too large ` +
            `(largest in-flight chunk: ${largest} bytes). Split the data ` +
            `into smaller chunks before writing.`
        )
      );
      return;
    }

    // Everything unacked may or may not have persisted: mark it unsent and
    // resend it all on a fresh channel (read-side dedupe absorbs overlap).
    for (const entry of this.buffer) entry.sentIndex = null;
    this.consecutiveReconnects++;
    this.totalReconnects++;
    if (this.consecutiveReconnects > this.config.maxConsecutiveReconnects) {
      this.fail(
        new WorkflowRuntimeError(
          `Stream write channel failed ${this.consecutiveReconnects} times in a row` +
            `${event.reason ? ` (last: ${event.reason})` : ''}`
        )
      );
      return;
    }
    if (this.totalReconnects > this.config.maxTotalReconnects) {
      this.fail(
        new WorkflowRuntimeError(
          `Stream write channel exceeded its lifetime reconnect budget ` +
            `(${this.config.maxTotalReconnects})`
        )
      );
      return;
    }

    const backoffs = this.config.reconnectBackoffMs;
    const delay =
      backoffs[Math.min(this.consecutiveReconnects - 1, backoffs.length - 1)];
    const setTimer = this.deps.setTimer ?? setTimeout;
    setTimer(() => this.pump(), delay);
  }

  private forceReconnect(reason: string): void {
    if (!this.channel) return;
    const channel = this.channel;
    this.channel = null;
    const currentEpoch = this.epoch;
    channel.close();
    // Drive the unclean-close path directly (with the still-current epoch) so
    // reconnection doesn't depend on the dead socket delivering its close
    // event; when that event does arrive, the epoch bump makes it stale.
    this.onChannelClose(currentEpoch, { reason });
  }
}
