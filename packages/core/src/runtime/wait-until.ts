export function waitUntil(promise: Promise<unknown>): void {
  void import('@vercel/functions').then(({ waitUntil }) => {
    waitUntil(promise);
  });
}

export function isExpectedClientDisconnectError(err: unknown): boolean {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? (err as { name?: unknown }).name
      : undefined;
  return name === 'AbortError' || name === 'ResponseAborted';
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
      if (!isExpectedClientDisconnectError(err)) {
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
 * Schedule a background promise and wait a short window for quick success or
 * failure. Returns false when the timeout wins so callers can queue a
 * continuation while `waitUntil` keeps the background work alive.
 */
export async function waitForBackgroundOps(
  promise: Promise<unknown>,
  {
    onError,
    timeoutMs = 500,
  }: { onError: (err: unknown) => void; timeoutMs?: number }
): Promise<boolean> {
  safeWaitUntil(promise, onError);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        (err) => {
          if (isExpectedClientDisconnectError(err)) return true as const;
          throw err;
        }
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
