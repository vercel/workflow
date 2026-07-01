// ============================================================================
// Single-request streaming segment writer
// ============================================================================
//
// Drives a logical durable stream of frames through a sequence of long-lived
// streaming PUT requests ("segments") instead of one short request per flush
// batch. Within a segment the writer pushes frames into the request body as the
// producer emits them; the world persists each frame in near-real-time. A
// segment is voluntarily ended ("soft-closed") well before any platform limit,
// at which point a clean `200` confirms every frame in it is durable.
//
// Why segments:
//  - A clean `200` is the only commit signal (there is no ack channel). Ending
//    a segment every ~10 s (or N frames / byte budget / on idle) makes that
//    signal frequent, so the writer's in-memory buffer of unconfirmed frames
//    stays small and the rare recovery path stays cheap.
//  - On a clean `200` the writer drops the whole buffer and opens the next
//    segment — no counting, no tail fetch.
//  - Segments for one writer are serialized (segment N+1 opens only after N's
//    response) so the writer's frame order is preserved and each `200` is an
//    unambiguous commit boundary.
//
// On an UNCLEAN segment failure (connection drop / 5xx — anything but a clean
// `200`) the writer hands its still-unconfirmed frames to a `recover` callback,
// which reads the persisted tail, finds this writer's own last-persisted frame
// (by the framed-v2 marker), and replays the rest on a fresh request. Recovery
// lives outside this module (it needs the world + writerId); this module only
// decides WHEN a segment ends and WHICH frames are still unconfirmed.
//
// Concurrency: the WritableStream contract serializes `write()` calls, so the
// only concurrent actor is the idle timer. A small mutex (`exclusive`)
// serializes every segment state transition (open / finalize) against both.

/**
 * A streaming PUT in flight. `body` carries raw frames (the world applies the
 * wire encoding); `response` resolves with the backend chunk indices when the
 * body is closed cleanly, or rejects on an unclean failure.
 */
export interface SegmentTransport {
  /**
   * Open a streaming request whose body is `frames` (one raw frame per chunk).
   * Resolves when the body has been closed by the writer AND the backend has
   * acknowledged the whole segment with a clean status; rejects otherwise.
   */
  writeStream(
    frames: ReadableStream<Uint8Array>
  ): Promise<{ chunkIndices: number[] }>;
}

export interface SegmentWriterDeps extends SegmentTransport {
  /**
   * Recover after an unclean segment failure: durably persist `unconfirmed`
   * (the frames not yet acknowledged by a clean `200`) by reading the tail and
   * replaying this writer's un-persisted frames. `priorIndices` are the chunk
   * indices from the last clean segment — the anchor for the tail scan (the
   * failed segment's frames were reserved at or after `max(priorIndices)+1`).
   * Resolves with the chunk indices ultimately assigned, or rejects if the
   * write has truly failed (e.g. a reserved-but-never-persisted tail chunk
   * after the backoff window).
   *
   * When omitted, an unclean failure is fatal: it rejects the pending
   * `write()`/`close()` and aborts the stream (no worse than an un-retried
   * write). The real implementation is wired in when the writer is enabled.
   */
  recover?(
    unconfirmed: Uint8Array[],
    priorIndices: readonly number[],
    error: unknown
  ): Promise<{ chunkIndices: number[] }>;

  /**
   * Awaited once before the first segment opens — the turbo run-ready barrier,
   * so the first PUT reaches the world only after the run exists. A no-op after
   * the first call. Optional (undefined outside turbo / on the await path).
   */
  ensureReady?(): Promise<void>;

  /** Millisecond clock. Injectable for deterministic tests. Default Date.now. */
  now?(): number;
  /** Schedule a one-shot timer. Default global setTimeout. */
  setTimer?(fn: () => void, ms: number): unknown;
  /** Cancel a timer from {@link setTimer}. Default global clearTimeout. */
  clearTimer?(handle: unknown): void;
}

export interface SegmentWriterConfig {
  /** Max wall-clock lifetime of one segment before a voluntary soft-close. */
  softCloseMs: number;
  /**
   * Max frames per segment. Must stay below the backend's per-request chunk
   * cap (MAX_CHUNKS_PER_BATCH) — the writer soft-closes before reaching it.
   */
  maxFrames: number;
  /** Byte budget per segment before a voluntary soft-close. */
  maxBytes: number;
  /**
   * Idle window: a segment with no new frame for this long is soft-closed so a
   * low-throughput stream commits promptly and doesn't hold a connection open.
   */
  idleMs: number;
}

/**
 * Default segment bounds. `maxFrames` is intentionally below the backend's
 * 1000-chunk per-request cap so a segment never trips it; the constant is
 * single-sourced from the world layer at the wiring site rather than duplicated
 * here.
 */
export const DEFAULT_SEGMENT_CONFIG: SegmentWriterConfig = {
  softCloseMs: 10_000,
  maxFrames: 900,
  maxBytes: 8 * 1024 * 1024,
  idleMs: 250,
};

interface ActiveSegment {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  response: Promise<{ chunkIndices: number[] }>;
  startedAt: number;
  frameCount: number;
  byteCount: number;
}

/**
 * Segment manager. Feed it raw frames with {@link write}; it batches them into
 * streaming PUT segments and commits each on a clean response. Call
 * {@link close} to flush and finalize, or {@link abort} to discard.
 */
export class StreamSegmentWriter {
  private readonly deps: Required<
    Pick<SegmentWriterDeps, 'now' | 'setTimer' | 'clearTimer'>
  > &
    SegmentWriterDeps;
  private readonly config: SegmentWriterConfig;

  /** Frames written but not yet confirmed durable by a clean segment response. */
  private unconfirmed: Uint8Array[] = [];
  /** Chunk indices from the most recent clean segment (recovery anchor). */
  private lastCommittedIndices: number[] = [];
  private current: ActiveSegment | null = null;
  private idleHandle: unknown = null;
  private readyAwaited = false;
  private closed = false;
  private aborted = false;
  /** Serializes segment state transitions against the idle timer. */
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: SegmentWriterDeps, config: SegmentWriterConfig) {
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as never)),
      ...deps,
    };
    this.config = config;
  }

  /** Chunk indices assigned by the last clean segment. Empty until one commits. */
  get committedIndices(): readonly number[] {
    return this.lastCommittedIndices;
  }

  /** Count of frames written but not yet confirmed durable. */
  get pendingCount(): number {
    return this.unconfirmed.length;
  }

  /** Run `fn` with exclusive access to segment state (mutex over `tail`). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Keep the chain alive but swallow errors on the shared tail; the real
    // result/rejection is returned to the caller via `run`.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleHandle = this.deps.setTimer(() => {
      this.idleHandle = null;
      // Finalize a quiet segment. Errors surface on the next write()/close()
      // via the mutex chain; swallow here so an unhandled rejection doesn't
      // escape the timer callback.
      void this.exclusive(() => this.finalizeSegment()).catch(() => undefined);
    }, this.config.idleMs);
  }

  private clearIdleTimer(): void {
    if (this.idleHandle != null) {
      this.deps.clearTimer(this.idleHandle);
      this.idleHandle = null;
    }
  }

  private async openSegment(): Promise<void> {
    if (!this.readyAwaited) {
      this.readyAwaited = true;
      if (this.deps.ensureReady) {
        try {
          await this.deps.ensureReady();
        } catch {
          // Ordering barrier only: if the run truly failed to start, the PUT
          // below surfaces the real error.
        }
      }
    }
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transform.writable.getWriter();
    // Start the request now; it stays pending until we close the writer.
    const response = this.deps.writeStream(transform.readable);
    this.current = {
      writer,
      response,
      startedAt: this.deps.now(),
      frameCount: 0,
      byteCount: 0,
    };
  }

  /**
   * End the current segment and wait for its commit. On a clean response the
   * unconfirmed buffer is dropped and the recovery anchor advanced. On an
   * unclean failure, `recover` (if provided) persists the unconfirmed frames;
   * without it, the error propagates.
   */
  private async finalizeSegment(): Promise<void> {
    const seg = this.current;
    if (!seg) return;
    this.current = null;
    this.clearIdleTimer();

    // Signal end-of-body. If the underlying request already errored, close()
    // may reject — the response promise is the authoritative outcome.
    try {
      await seg.writer.close();
    } catch {
      // fall through to the response
    }

    try {
      const { chunkIndices } = await seg.response;
      this.lastCommittedIndices = chunkIndices;
      this.unconfirmed = [];
    } catch (error) {
      if (!this.deps.recover) throw error;
      const { chunkIndices } = await this.deps.recover(
        this.unconfirmed,
        this.lastCommittedIndices,
        error
      );
      // Recovery replays only the un-persisted suffix, so it may return no
      // indices (everything was already durable). Keep the prior anchor in that
      // case rather than clobbering it with an empty array.
      if (chunkIndices.length > 0) this.lastCommittedIndices = chunkIndices;
      this.unconfirmed = [];
    }
  }

  /** Whether adding one more frame of `size` bytes should end the segment first. */
  private shouldSoftCloseBefore(size: number, seg: ActiveSegment): boolean {
    return (
      seg.frameCount + 1 > this.config.maxFrames ||
      seg.byteCount + size > this.config.maxBytes
    );
  }

  private overTimeBudget(seg: ActiveSegment): boolean {
    return this.deps.now() - seg.startedAt >= this.config.softCloseMs;
  }

  /**
   * Write one raw frame. Resolves when the frame has been accepted into the
   * current segment's body (honoring backpressure) — not when it is confirmed
   * durable (that happens at the next clean segment response).
   */
  write(frame: Uint8Array): Promise<void> {
    return this.exclusive(async () => {
      if (this.aborted) throw new Error('Segment writer aborted');
      if (this.closed) throw new Error('Segment writer already closed');

      // A full/expired segment is finalized before this frame joins a new one,
      // so the frame that would exceed the bound starts the next segment.
      if (
        this.current &&
        (this.shouldSoftCloseBefore(frame.length, this.current) ||
          this.overTimeBudget(this.current))
      ) {
        await this.finalizeSegment();
      }
      if (!this.current) {
        await this.openSegment();
      }
      const seg = this.current as ActiveSegment;

      // Buffer for potential recovery replay, then push into the body
      // (backpressure throttles the producer here).
      this.unconfirmed.push(frame);
      await seg.writer.write(frame);
      seg.frameCount += 1;
      seg.byteCount += frame.length;

      // A busy segment that has hit its time budget ends now so the next frame
      // opens a fresh one; a quiet segment is ended by the idle timer.
      if (this.overTimeBudget(seg)) {
        await this.finalizeSegment();
      } else {
        this.armIdleTimer();
      }
    });
  }

  /** Finalize any open segment and mark the writer closed. */
  close(): Promise<void> {
    return this.exclusive(async () => {
      this.clearIdleTimer();
      this.closed = true;
      if (this.current) {
        await this.finalizeSegment();
      }
    });
  }

  /**
   * Abort: discard unconfirmed frames and tear down any open segment. Best
   * effort — never rejects.
   */
  async abort(reason?: unknown): Promise<void> {
    this.aborted = true;
    this.clearIdleTimer();
    const seg = this.current;
    this.current = null;
    this.unconfirmed = [];
    if (seg) {
      await seg.writer.abort(reason).catch(() => undefined);
      // Consume the response rejection so it doesn't surface as unhandled.
      seg.response.catch(() => undefined);
    }
  }
}
