export function waitUntil(promise: Promise<unknown>): void {
  void import('@vercel/functions').then(({ waitUntil }) => {
    waitUntil(promise);
  });
}

/**
 * Schedule a background promise via `waitUntil`, guaranteeing that the
 * promise handed to `waitUntil` can never reject. Nothing consumes a
 * `waitUntil` promise, so a rejection surfaces as an `unhandledRejection`
 * and can crash the process — even when the same underlying error is
 * correctly handled by an awaited copy elsewhere.
 *
 * Expected client-disconnect errors (`AbortError` / `ResponseAborted`)
 * are ignored. Any other error is passed to `onError` and swallowed.
 */
export function safeWaitUntil(
  promise: Promise<unknown>,
  onError: (err: unknown) => void
): void {
  waitUntil(
    promise.catch((err) => {
      const isAbortError =
        err?.name === 'AbortError' || err?.name === 'ResponseAborted';
      if (!isAbortError) {
        try {
          onError(err);
        } catch {
          // Never let onError break the no-reject guarantee.
        }
      }
    })
  );
}

/**
 * A small wrapper around `waitUntil` that also returns
 * the result of the awaited promise.
 */
export async function waitedUntil<T>(fn: () => Promise<T>): Promise<T> {
  const result = fn();
  waitUntil(
    result.catch(() => {
      // Ignore error from the promise being rejected.
      // It's expected that the invoker of `waitedUntil`
      // will handle the error.
    })
  );
  return result;
}
