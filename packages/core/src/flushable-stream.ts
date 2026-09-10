import { WorkflowRuntimeError } from '@workflow/errors';
import { type PromiseWithResolvers, withResolvers } from '@workflow/utils';
import { envNumber } from '@workflow/world/env-config';
import { STREAM_DRAIN_SYMBOL } from './symbols.js';

/**
 * A durability barrier a sink may expose under {@link STREAM_DRAIN_SYMBOL}:
 * resolves once every chunk the sink has accepted is durably written, rejects
 * if any server write failed. See `WorkflowServerWritableStream`.
 */
type DrainBarrier = () => Promise<void>;

/**
 * Flow-control knob: upper bound on chunks read-but-not-yet-durably-written
 * while coalescing. Once this many chunks are outstanding the producer stops
 * reading until the consumer drains a batch, so a fast producer paired with a
 * slow server can't grow the in-memory queue without bound. Override:
 * `WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS`.
 *
 * This is deliberately distinct from the per-request batch caps below: this
 * bounds how much is *buffered*, those bound how much goes out in one
 * `writeMulti`. Raising this must never let a single request exceed a wire
 * limit, since batch sizing enforces that independently.
 */
export const MAX_INFLIGHT_CHUNKS = 1000;

export const getMaxInflightChunks = (): number =>
  envNumber('WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS', MAX_INFLIGHT_CHUNKS, {
    integer: true,
    min: 1,
  });

/**
 * Wire limit: maximum number of chunks in a single coalesced `writeMulti`.
 * The server enforces a per-multi-write chunk cap (1,000 today); a batch is
 * split at this bound so it can never be rejected wholesale, independently of
 * the backpressure knob above. Override: `WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH`.
 */
export const MAX_CHUNKS_PER_BATCH = 1000;

export const getMaxChunksPerBatch = (): number =>
  envNumber('WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH', MAX_CHUNKS_PER_BATCH, {
    integer: true,
    min: 1,
  });

/**
 * Wire limit: maximum cumulative bytes in a single coalesced `writeMulti`.
 * Chunk *count* alone is not enough: 1,000 small chunks are ~100KB but 1,000
 * file-sized chunks can be hundreds of MB, which platform request-body limits
 * reject long before the count cap matters. A batch is split once adding the
 * next chunk would exceed this (a single chunk larger than the cap still goes
 * out alone). Default 1 MiB. Override: `WORKFLOW_STREAM_MAX_BYTES_PER_BATCH`.
 */
export const MAX_BYTES_PER_BATCH = 1024 * 1024;

export const getMaxBytesPerBatch = (): number =>
  envNumber('WORKFLOW_STREAM_MAX_BYTES_PER_BATCH', MAX_BYTES_PER_BATCH, {
    integer: true,
    min: 1,
  });

/**
 * Buffer bound (bytes) for the server writable's group-commit buffer, the
 * byte-denominated counterpart of {@link MAX_INFLIGHT_CHUNKS}. `write()`
 * blocks once this much data is buffered-but-not-durable, so a fast producer
 * of large chunks can't grow client memory without bound. Default 8 MiB
 * (eight request-sized groups). Override: `WORKFLOW_STREAM_MAX_BUFFERED_BYTES`.
 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export const getMaxBufferedBytes = (): number =>
  envNumber('WORKFLOW_STREAM_MAX_BUFFERED_BYTES', MAX_BUFFERED_BYTES, {
    integer: true,
    min: 1,
  });

/**
 * Polling interval (in ms) for lock release detection.
 *
 * The Web Streams API does not expose an event for "lock released but stream
 * still open"; we can only distinguish that state by periodically attempting
 * to acquire a reader/writer. For that reason we use polling instead of a
 * fully event-driven approach here.
 *
 * 10ms is chosen so the polling tick almost never sits on the critical path:
 * the V2 step-executor's `opsSettled` race waits for this state to resolve
 * after each step body returns, so a coarser interval (the previous 100ms)
 * adds visible per-step latency to streaming workflows. With a uniformly
 * distributed offset between step return and the next tick, the expected
 * wait is half the interval, so 10ms means ~5ms average wait per step
 * instead of ~50ms. The per-tick work is `writable.locked` plus a
 * `getWriter()`/`releaseLock()` probe, both microsecond-scale; 10× more
 * ticks during a stream's lifetime is not measurable in practice.
 */
export const LOCK_POLL_INTERVAL_MS = 10;

/** Effective lock-poll interval. Override: `WORKFLOW_LOCK_POLL_INTERVAL_MS`. */
const getLockPollIntervalMs = (): number =>
  envNumber('WORKFLOW_LOCK_POLL_INTERVAL_MS', LOCK_POLL_INTERVAL_MS, {
    integer: true,
    min: 1,
  });

/**
 * State tracker for flushable stream operations.
 * Resolves when either:
 * 1. Stream completes (close/error), OR
 * 2. Lock is released AND all pending operations are flushed
 *
 * Note: `doneResolved` and `streamEnded` are separate:
 * - `doneResolved`: The `done` promise has been resolved (step can complete)
 * - `streamEnded`: The underlying stream has actually closed/errored
 *
 * Once `doneResolved` is set to true, the `done` promise will not resolve
 * again. Re-acquiring locks after release is not supported as a way to
 * trigger additional completion signaling.
 */
export interface FlushableStreamState extends PromiseWithResolvers<void> {
  /** Number of write operations currently in flight to the server */
  pendingOps: number;
  /** Whether the `done` promise has been resolved */
  doneResolved: boolean;
  /** Whether the underlying stream has actually closed/errored */
  streamEnded: boolean;
  /** Interval ID for writable lock polling (if active) */
  writablePollingInterval?: ReturnType<typeof setInterval>;
  /** Interval ID for readable lock polling (if active) */
  readablePollingInterval?: ReturnType<typeof setInterval>;
  /**
   * Durability barrier of the pipe's sink, when it acks writes on buffer
   * entry (see {@link STREAM_DRAIN_SYMBOL}). Lock-release completion awaits
   * this before resolving so `pendingOps === 0` (fast, buffered acks) can't
   * complete a step while data is still client-side.
   */
  drainBarrier?: DrainBarrier;
}

export function createFlushableState(): FlushableStreamState {
  const state: FlushableStreamState = {
    ...withResolvers<void>(),
    pendingOps: 0,
    doneResolved: false,
    streamEnded: false,
  };

  // The runtime awaits this promise after user code returns. Observe early
  // stream failures now so they do not become unhandled rejections first.
  state.promise.catch(() => {});

  return state;
}

/**
 * Checks if a WritableStream is unlocked (user released lock) vs closed.
 * When a stream is closed, .locked is false but getWriter() throws.
 * We only want to resolve via polling when the stream is unlocked, not closed.
 * If closed, the pump will handle resolution via the stream ending naturally.
 */
function isWritableUnlockedNotClosed(writable: WritableStream): boolean {
  if (writable.locked) return false;

  let writer: WritableStreamDefaultWriter | undefined;
  try {
    // Try to acquire writer - if successful, stream is unlocked (not closed)
    writer = writable.getWriter();
  } catch {
    // getWriter() throws if stream is closed/errored - let pump handle it
    return false;
  }

  try {
    writer.releaseLock();
  } catch {
    // If releaseLock() throws for any reason, conservatively treat the
    // stream as closed/errored so callers don't assume it's safe to use.
    // The pump will observe the failure via the stream's end state.
    return false;
  }

  return true;
}

/**
 * Checks if a ReadableStream is unlocked (user released lock) vs closed.
 */
function isReadableUnlockedNotClosed(readable: ReadableStream): boolean {
  if (readable.locked) return false;

  let reader: ReadableStreamDefaultReader | undefined;
  try {
    // Try to acquire reader - if successful, stream is unlocked (not closed)
    reader = readable.getReader();
  } catch {
    // getReader() throws if stream is closed/errored - let pump handle it
    return false;
  }

  try {
    reader.releaseLock();
  } catch {
    // If releaseLock() throws for any reason, conservatively treat the
    // stream as closed/errored so callers don't assume it's safe to use.
    // The pump will observe the failure via the stream's end state.
    return false;
  }

  return true;
}

/**
 * Settle the flushable completion after the sink's durability barrier.
 *
 * Lock release means the producer is done *writing*; with a group-commit
 * sink, accepted chunks may still be client-buffered or in a request that is
 * in flight. Awaiting the barrier here keeps the completion's meaning
 * ("everything written so far is durable") identical to the pre-batching
 * behavior where each write() was individually durable.
 */
function resolveAfterDrain(state: FlushableStreamState): void {
  const barrier = state.drainBarrier;
  if (!barrier) {
    state.resolve();
    return;
  }
  barrier().then(
    () => state.resolve(),
    (err) => state.reject(err)
  );
}

/**
 * Polls a WritableStream to check if the user has released their lock.
 * Resolves the done promise when lock is released and no pending ops remain.
 *
 * Note: Only resolves if stream is unlocked but NOT closed. If the user closes
 * the stream, the pump will handle resolution via the stream ending naturally.
 *
 * Protection: If polling is already active on this state, the existing interval
 * is used to avoid creating multiple simultaneous polling operations.
 */
export function pollWritableLock(
  writable: WritableStream,
  state: FlushableStreamState
): void {
  // Prevent multiple simultaneous polling on the same state
  if (state.writablePollingInterval !== undefined) {
    return;
  }

  const intervalId = setInterval(() => {
    // Stop polling if already resolved or stream ended
    if (state.doneResolved || state.streamEnded) {
      clearInterval(intervalId);
      state.writablePollingInterval = undefined;
      return;
    }

    // Check if lock is released (not closed) and no pending ops
    if (isWritableUnlockedNotClosed(writable) && state.pendingOps === 0) {
      state.doneResolved = true;
      clearInterval(intervalId);
      state.writablePollingInterval = undefined;
      resolveAfterDrain(state);
    }
  }, getLockPollIntervalMs());

  state.writablePollingInterval = intervalId;
}

/**
 * Polls a ReadableStream to check if the user has released their lock.
 * Resolves the done promise when lock is released and no pending ops remain.
 *
 * Note: Only resolves if stream is unlocked but NOT closed. If the user closes
 * the stream, the pump will handle resolution via the stream ending naturally.
 *
 * Protection: If polling is already active on this state, the existing interval
 * is used to avoid creating multiple simultaneous polling operations.
 */
export function pollReadableLock(
  readable: ReadableStream,
  state: FlushableStreamState
): void {
  // Prevent multiple simultaneous polling on the same state
  if (state.readablePollingInterval !== undefined) {
    return;
  }

  const intervalId = setInterval(() => {
    // Stop polling if already resolved or stream ended
    if (state.doneResolved || state.streamEnded) {
      clearInterval(intervalId);
      state.readablePollingInterval = undefined;
      return;
    }

    // Check if lock is released (not closed) and no pending ops
    if (isReadableUnlockedNotClosed(readable) && state.pendingOps === 0) {
      state.doneResolved = true;
      clearInterval(intervalId);
      state.readablePollingInterval = undefined;
      resolveAfterDrain(state);
    }
  }, getLockPollIntervalMs());

  state.readablePollingInterval = intervalId;
}

/**
 * Creates a flushable pipe from a ReadableStream to a WritableStream.
 * Unlike pipeTo(), this resolves when:
 * 1. The source stream completes (close/error), OR
 * 2. The user releases their lock on userStream AND all pending writes are flushed
 *
 * @param source - The readable stream to read from (e.g., transform's readable)
 * @param sink - The writable stream to write to (e.g., server writable)
 * @param state - The flushable state tracker
 * @returns Promise that resolves when stream ends (not when done promise resolves)
 */
export function flushablePipe(
  source: ReadableStream,
  sink: WritableStream,
  state: FlushableStreamState
): Promise<void> {
  // Batching lives in the sink (`WorkflowServerWritableStream` group-commits
  // its buffer), so this pipe is a plain per-chunk pump regardless of path:
  // its only responsibilities are lock-release completion and durability
  // tracking. Group-commit sinks ack write() on buffer entry; adopt their
  // durability barrier so the lock-release completion still means
  // "everything written is durable" (see resolveAfterDrain).
  const drain = (sink as { [STREAM_DRAIN_SYMBOL]?: DrainBarrier })[
    STREAM_DRAIN_SYMBOL
  ];
  if (typeof drain === 'function') {
    state.drainBarrier = drain;
  }
  return flushablePipePerChunk(source, sink, state);
}

/**
 * The pump behind {@link flushablePipe}: awaits each `writer.write()` before
 * reading the next chunk. Against a group-commit sink, write() acks on buffer
 * entry, so this loop feeds the sink as fast as the producer emits (bounded
 * by the sink's buffer bound) and batching happens inside the sink; against a
 * plain sink each write is individually durable, as before. The source-done
 * path closes the sink, which drains it, so completion always implies
 * durability.
 */
async function flushablePipePerChunk(
  source: ReadableStream,
  sink: WritableStream,
  state: FlushableStreamState
): Promise<void> {
  const reader = source.getReader();
  const writer = sink.getWriter();
  let cancelReason: unknown;

  try {
    while (true) {
      // Check if stream has ended
      if (state.streamEnded) {
        return;
      }

      // Read from the source. Don't count this as a pending operation because
      // reads wait for data. The important operations are writes to the sink.
      const readResult = await Promise.race([
        reader.read(),
        writer.closed.then(() => {
          throw new WorkflowRuntimeError('Writable stream closed prematurely');
        }),
      ]);

      // Check if stream has ended (e.g., due to error in another path) before processing
      if (state.streamEnded) {
        return;
      }

      if (readResult.done) {
        // Source stream completed - close sink and resolve
        state.streamEnded = true;
        await writer.close();
        // Resolve done promise if not already resolved
        if (!state.doneResolved) {
          state.doneResolved = true;
          state.resolve();
        }
        return;
      }

      // Count write as a pending op - this is what we need to flush
      state.pendingOps++;
      try {
        await writer.write(readResult.value);
      } finally {
        state.pendingOps--;
      }
    }
  } catch (err) {
    state.streamEnded = true;
    cancelReason = err;
    // Against an early-ack sink, chunks can still be buffered or in flight
    // when the pipe fails (pendingOps only counts un-acked writes). Deliver
    // that accepted prefix before settling the failure: once the state
    // rejects, the step may persist its failure and the invocation finish,
    // and anything still client-side would be lost. The original pipe error
    // stays primary, since a drain failure is already sticky on the sink.
    if (state.drainBarrier) {
      await state.drainBarrier().catch(() => {});
    }
    if (!state.doneResolved) {
      state.doneResolved = true;
      state.reject(err);
    }
    // Propagate error through flushablePipe's own promise as well.
    // Callers that rely on the FlushableStreamState should use `state.promise`,
    // while other callers may depend on this rejection. Some known callers
    // explicitly ignore this rejection (`.catch(() => {})`) and rely solely
    // on `state.reject(err)` for error handling.
    throw err;
  } finally {
    // Cancel the upstream reader so the source knows to stop generating data.
    // Uses cancelReason (set in the catch block) so the source receives context
    // about why it was canceled. On normal completion cancelReason is undefined,
    // which is a harmless no-op on an already-done reader.
    reader.cancel(cancelReason).catch(() => {});
    reader.releaseLock();
    writer.releaseLock();
  }
}
