import { type PromiseWithResolvers, withResolvers } from '@workflow/utils';

/** Polling interval for lock release detection */
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
 * The pump continues running even after `doneResolved=true` to handle
 * any future writes if the user acquires a new lock.
 */
export interface FlushableStreamState extends PromiseWithResolvers<void> {
  /** Number of write operations currently in flight to the server */
  pendingOps: number;
  /** Whether the `done` promise has been resolved */
  doneResolved: boolean;
  /** Whether the underlying stream has actually closed/errored */
  streamEnded: boolean;
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

  try {
    // Try to acquire writer - if successful, stream is unlocked (not closed)
    const writer = writable.getWriter();
    writer.releaseLock();
    return true;
  } catch {
    // getWriter() throws if stream is closed/errored - let pump handle it
    return false;
  }
}

/**
 * Checks if a ReadableStream is unlocked (user released lock) vs closed.
 */
function isReadableUnlockedNotClosed(readable: ReadableStream): boolean {
  if (readable.locked) return false;

  try {
    // Try to acquire reader - if successful, stream is unlocked (not closed)
    const reader = readable.getReader();
    reader.releaseLock();
    return true;
  } catch {
    // getReader() throws if stream is closed/errored - let pump handle it
    return false;
  }
}

/**
 * Polls a WritableStream to check if the user has released their lock.
 * Resolves the done promise when lock is released and no pending ops remain.
 *
 * Note: Only resolves if stream is unlocked but NOT closed. If the user closes
 * the stream, the pump will handle resolution via the stream ending naturally.
 */
export function pollWritableLock(
  writable: WritableStream,
  state: FlushableStreamState
): void {
  const intervalId = setInterval(() => {
    // Stop polling if already resolved or stream ended
    if (state.doneResolved || state.streamEnded) {
      clearInterval(intervalId);
      return;
    }

    // Check if lock is released (not closed) and no pending ops
    if (isWritableUnlockedNotClosed(writable) && state.pendingOps === 0) {
      state.doneResolved = true;
      state.resolve();
      clearInterval(intervalId);
    }
  }, LOCK_POLL_INTERVAL_MS);
}

/**
 * Polls a ReadableStream to check if the user has released their lock.
 * Resolves the done promise when lock is released and no pending ops remain.
 *
 * Note: Only resolves if stream is unlocked but NOT closed. If the user closes
 * the stream, the pump will handle resolution via the stream ending naturally.
 */
export function pollReadableLock(
  readable: ReadableStream,
  state: FlushableStreamState
): void {
  const intervalId = setInterval(() => {
    // Stop polling if already resolved or stream ended
    if (state.doneResolved || state.streamEnded) {
      clearInterval(intervalId);
      return;
    }

    // Check if lock is released (not closed) and no pending ops
    if (isReadableUnlockedNotClosed(readable) && state.pendingOps === 0) {
      state.doneResolved = true;
      state.resolve();
      clearInterval(intervalId);
    }
  }, LOCK_POLL_INTERVAL_MS);
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

      // Check if stream has ended (e.g., due to error in another path)
      if (state.streamEnded) {
        return;
      }
    }
  } catch (err) {
    state.streamEnded = true;
    if (!state.doneResolved) {
      state.doneResolved = true;
      state.reject(err);
    }
    throw err;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}
