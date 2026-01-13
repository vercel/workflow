import { type PromiseWithResolvers, withResolvers } from '@workflow/utils';

/**
 * Polling interval (in ms) for lock release detection.
 *
 * The Web Streams API does not expose an event for "lock released but stream
 * still open"; we can only distinguish that state by periodically attempting
 * to acquire a reader/writer. For that reason we use polling instead of a
 * fully event-driven approach here.
 *
 * 100ms is a compromise between:
 * - Latency: how quickly we notice that the user has released their lock, and
 * - Cost/CPU usage: how often timers fire, especially with many concurrent
 *   streams or in serverless environments where billed time matters.
 *
 * This value should only be changed with care, as decreasing it will
 * increase polling frequency (and thus potential cost), while increasing it
 * will add worst-case delay before the `done` promise resolves after a lock
 * is released.
 */
export const LOCK_POLL_INTERVAL_MS = 100;

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
  return {
    ...withResolvers<void>(),
    pendingOps: 0,
    doneResolved: false,
    streamEnded: false,
  };
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
  }, LOCK_POLL_INTERVAL_MS);

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
  }, LOCK_POLL_INTERVAL_MS);

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
export async function flushablePipe(
  source: ReadableStream,
  sink: WritableStream,
  state: FlushableStreamState
): Promise<void> {
  const reader = source.getReader();
  const writer = sink.getWriter();

  try {
    while (true) {
      // Check if stream has ended
      if (state.streamEnded) {
        return;
      }

      // Read from source - don't count as pending op since we're just waiting for data
      // The important ops are writes to the sink (server)
      const readResult = await reader.read();

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
    reader.releaseLock();
    writer.releaseLock();
  }
}
