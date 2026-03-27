const isBrowser = typeof window !== 'undefined';

/**
 * Yields to the browser's macrotask queue so the main thread can run
 * rendering/paint work between stream chunks. Without this, a tight
 * pull→enqueue loop (common when replaying buffered data on reconnect)
 * starves the event loop and blocks paint until the stream ends.
 *
 * Only applies in browser environments — server-side consumers skip
 * the yield since there is no paint to unblock.
 */
const yieldToMacrotask = (): Promise<void> | void =>
  isBrowser ? new Promise((resolve) => setTimeout(resolve, 0)) : undefined;

/**
 * Converts an async iterator to a ReadableStream
 * @param fn - Function that returns an async generator
 * @param signal - Optional AbortSignal to cancel the stream
 * @returns A ReadableStream that yields the same values as the iterator
 */
export function iteratorToStream<T>(
  iterator: AsyncGenerator<T>,
  { signal }: { signal?: AbortSignal } = {}
): ReadableStream<T> {
  let abortHandler: (() => void) | undefined;

  return new ReadableStream<T>({
    start(controller) {
      // Set up abort signal handler if provided
      if (signal) {
        if (signal.aborted) {
          // If already aborted, error immediately
          controller.error(signal.reason || new Error('Aborted'));
          return;
        }

        // Listen for abort event
        abortHandler = () => {
          controller.error(signal.reason || new Error('Aborted'));
          // Try to clean up the iterator
          if (iterator.return) {
            iterator.return(undefined);
          }
        };

        signal.addEventListener('abort', abortHandler);
      }
    },

    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
          // Yield to the macrotask queue so the browser can paint between
          // chunks. This prevents the pull-enqueue loop from starving the
          // main thread when replaying buffered data (e.g. on reconnect).
          await yieldToMacrotask();
        }
      } catch (error) {
        controller.error(error);
      }
    },

    async cancel(_reason) {
      // Clean up abort handler if it exists
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }

      // Clean up the iterator
      if (iterator.return) {
        await iterator.return(undefined);
      }
    },
  });
}

/**
 * Converts a ReadableStream to an async iterator
 * @param stream - The ReadableStream to convert
 * @returns An async iterator that yields the stream's values
 */
export async function* streamToIterator<T>(
  stream: ReadableStream<T>
): AsyncIterableIterator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    // Always release the reader when done
    reader.releaseLock();
  }
}
