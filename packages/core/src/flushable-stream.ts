import { WorkflowRuntimeError } from '@workflow/errors';
import { type PromiseWithResolvers, withResolvers } from '@workflow/utils';
import { envNumber } from '@workflow/world';
import { STREAM_WRITE_BATCH_SYMBOL } from './symbols.js';

/**
 * A batched, durable write entry point a sink may expose under
 * {@link STREAM_WRITE_BATCH_SYMBOL}. Resolves once every chunk in the batch
 * has reached the server. See `WorkflowServerWritableStream`.
 */
type BatchWrite = (chunks: Uint8Array[]) => Promise<void>;

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
 * limit — batch sizing enforces that independently.
 */
export const MAX_INFLIGHT_CHUNKS = 1000;

const getMaxInflightChunks = (): number =>
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

const getMaxChunksPerBatch = (): number =>
  envNumber('WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH', MAX_CHUNKS_PER_BATCH, {
    integer: true,
    min: 1,
  });

/**
 * Wire limit: maximum cumulative bytes in a single coalesced `writeMulti`.
 * Chunk *count* alone is not enough — 1,000 small chunks are ~100KB but 1,000
 * file-sized chunks can be hundreds of MB, which platform request-body limits
 * reject long before the count cap matters. A batch is split once adding the
 * next chunk would exceed this (a single chunk larger than the cap still goes
 * out alone). Default 1 MiB. Override: `WORKFLOW_STREAM_MAX_BYTES_PER_BATCH`.
 */
export const MAX_BYTES_PER_BATCH = 1024 * 1024;

const getMaxBytesPerBatch = (): number =>
  envNumber('WORKFLOW_STREAM_MAX_BYTES_PER_BATCH', MAX_BYTES_PER_BATCH, {
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
 * wait is half the interval — so 10ms means ~5ms average wait per step
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
      state.resolve();
      clearInterval(intervalId);
      state.writablePollingInterval = undefined;
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
      state.resolve();
      clearInterval(intervalId);
      state.readablePollingInterval = undefined;
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
  // When the sink can accept a batch of chunks in one durable write (server
  // writables do), coalesce chunks that arrive while a previous batch is still
  // in flight into a single server write. Without this, the WHATWG
  // `WritableStream` contract serializes the sink one chunk per write() and the
  // per-chunk `await writer.write()` in the fallback means the sink's buffer
  // never holds more than one chunk — so its `writeMulti` batching path never
  // engages and every chunk becomes its own server round trip.
  const batchWrite = (sink as { [STREAM_WRITE_BATCH_SYMBOL]?: BatchWrite })[
    STREAM_WRITE_BATCH_SYMBOL
  ];
  return typeof batchWrite === 'function'
    ? flushablePipeCoalescing(source, sink, state, batchWrite)
    : flushablePipePerChunk(source, sink, state);
}

/**
 * Per-chunk variant of {@link flushablePipe}: awaits each `writer.write()`
 * before reading the next chunk. Used for sinks without a durable batch write
 * (plain `WritableStream`s, `TransformStream` writables on the read path).
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

      // Read from source - don't count as pending op since we're just waiting for data
      // The important ops are writes to the sink (server)
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
    // about why it was cancelled. On normal completion cancelReason is undefined,
    // which is a harmless no-op on an already-done reader.
    reader.cancel(cancelReason).catch(() => {});
    reader.releaseLock();
    writer.releaseLock();
  }
}

/**
 * Shared, mutable coordination state between the coalescing pipe's producer
 * (reads from source into `queue`) and consumer (drains `queue` in batches).
 */
interface CoalesceContext {
  state: FlushableStreamState;
  batchWrite: BatchWrite;
  /** Chunks read but not yet handed to a batch write. */
  queue: Uint8Array[];
  /** Set once the source has reported `done`. */
  sourceDone: boolean;
  /** Resolver that wakes the consumer when the queue grows or the source ends. */
  wakeConsumer: (() => void) | null;
  /** Resolver that wakes the producer when the consumer relieves backpressure. */
  wakeProducer: (() => void) | null;
  /** Wire limit: max chunks per coalesced `writeMulti`. */
  maxChunksPerBatch: number;
  /** Wire limit: max cumulative bytes per coalesced `writeMulti`. */
  maxBytesPerBatch: number;
}

function wake(ctx: CoalesceContext, which: 'wakeConsumer' | 'wakeProducer') {
  const resolve = ctx[which];
  if (resolve) {
    ctx[which] = null;
    resolve();
  }
}

/**
 * How many leading queued chunks fit in one `writeMulti` without crossing the
 * chunk-count or byte wire limits. Always returns at least 1 so a single chunk
 * larger than the byte cap still makes progress (alone).
 */
function nextBatchSize(ctx: CoalesceContext): number {
  let count = 0;
  let bytes = 0;
  for (const chunk of ctx.queue) {
    if (count >= ctx.maxChunksPerBatch) break;
    if (count > 0 && bytes + chunk.byteLength > ctx.maxBytesPerBatch) break;
    count++;
    bytes += chunk.byteLength;
  }
  return count;
}

/**
 * Consumer loop: drains the queue one batch at a time, awaiting each batch so it
 * is durable on the server before its chunks leave `pendingOps`. It takes as
 * much of the queue as the wire limits allow each round, so chunks that arrived
 * while the previous batch was in flight coalesce into the next server write.
 *
 * `pendingOps` is decremented only after `batchWrite` *succeeds*: on failure the
 * chunks stay retained in the sink's buffer (see `WorkflowServerWritableStream`)
 * and are therefore still "read but not durable", so they must keep counting.
 * A throw propagates out of the loop; the pipe's producer then tears down.
 */
async function drainBatches(ctx: CoalesceContext): Promise<void> {
  while (true) {
    if (ctx.queue.length === 0) {
      if (ctx.sourceDone) return;
      await new Promise<void>((resolve) => {
        ctx.wakeConsumer = resolve;
      });
      continue;
    }
    const count = nextBatchSize(ctx);
    const batch = ctx.queue.slice(0, count);
    ctx.queue = ctx.queue.slice(count);
    await ctx.batchWrite(batch);
    ctx.state.pendingOps -= batch.length;
    // Relieve producer backpressure now that this batch is durable.
    wake(ctx, 'wakeProducer');
  }
}

/**
 * Await the next chunk while a batch write is in flight, racing three outcomes:
 * a read result, the sink closing under us, or a server-write failure from the
 * consumer (surfaced promptly even while blocked on the read). On normal
 * completion the consumer only settles after the producer sets `sourceDone`, so
 * its branch throws only on real failure.
 */
function readNextChunk(
  reader: ReadableStreamDefaultReader,
  writer: WritableStreamDefaultWriter,
  consumer: Promise<void>
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader['read']>>> {
  return Promise.race([
    reader.read(),
    writer.closed.then(() => {
      throw new WorkflowRuntimeError('Writable stream closed prematurely');
    }),
    consumer.then(
      () => {
        throw new WorkflowRuntimeError('Stream consumer ended prematurely');
      },
      (err) => {
        throw err;
      }
    ),
  ]);
}

/**
 * Backpressure: once too many chunks are outstanding, stop reading until the
 * consumer drains a batch. Racing the consumer avoids a deadlock if it ends or
 * fails while we wait.
 */
async function awaitBackpressureRelief(
  ctx: CoalesceContext,
  consumer: Promise<void>,
  maxInflight: number
): Promise<void> {
  if (ctx.state.pendingOps < maxInflight) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      ctx.wakeProducer = resolve;
    }),
    consumer.then(
      () => undefined,
      () => undefined
    ),
  ]);
}

/**
 * Batching variant of {@link flushablePipe} for sinks that expose a durable
 * batch write ({@link STREAM_WRITE_BATCH_SYMBOL}). A producer reads from
 * `source` into a queue; {@link drainBatches} coalesces queued chunks into as
 * few server writes as possible — turning a fast burst of chunks into a handful
 * of round trips instead of one per chunk.
 *
 * Durability is preserved exactly as in the per-chunk path: `state.pendingOps`
 * counts chunks that have been read but not yet durably written, so the
 * lock-release completion (`pollWritableLock` / `pollReadableLock`) never fires
 * while data is still queued or in flight, and the source-done path awaits every
 * batch before closing.
 */
async function flushablePipeCoalescing(
  source: ReadableStream,
  sink: WritableStream,
  state: FlushableStreamState,
  batchWrite: BatchWrite
): Promise<void> {
  const reader = source.getReader();
  const writer = sink.getWriter();
  const maxInflight = getMaxInflightChunks();
  let cancelReason: unknown;

  const ctx: CoalesceContext = {
    state,
    batchWrite,
    queue: [],
    sourceDone: false,
    wakeConsumer: null,
    wakeProducer: null,
    maxChunksPerBatch: getMaxChunksPerBatch(),
    maxBytesPerBatch: getMaxBytesPerBatch(),
  };
  const consumer = drainBatches(ctx);

  try {
    while (!state.streamEnded) {
      const readResult = await readNextChunk(reader, writer, consumer);
      if (state.streamEnded) return;

      if (readResult.done) {
        // Signal end-of-source and wait for every queued/in-flight batch to
        // reach the server before closing, so no chunk is dropped.
        ctx.sourceDone = true;
        wake(ctx, 'wakeConsumer');
        await consumer;
        state.streamEnded = true;
        await writer.close();
        if (!state.doneResolved) {
          state.doneResolved = true;
          state.resolve();
        }
        return;
      }

      // Count the chunk as pending the moment it is read — it stays counted
      // until its batch is durably written.
      ctx.queue.push(readResult.value as Uint8Array);
      state.pendingOps++;
      wake(ctx, 'wakeConsumer');

      await awaitBackpressureRelief(ctx, consumer, maxInflight);
    }
  } catch (err) {
    state.streamEnded = true;
    cancelReason = err;
    // Let the consumer settle so its rejection (if any) is observed here rather
    // than surfacing as an unhandled rejection.
    ctx.sourceDone = true;
    wake(ctx, 'wakeConsumer');
    await consumer.catch(() => {});
    if (!state.doneResolved) {
      state.doneResolved = true;
      state.reject(err);
    }
    throw err;
  } finally {
    reader.cancel(cancelReason).catch(() => {});
    reader.releaseLock();
    writer.releaseLock();
  }
}
