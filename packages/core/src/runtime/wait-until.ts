export function waitUntil(promise: Promise<unknown>): void {
  void import('@vercel/functions').then(({ waitUntil }) => {
    waitUntil(promise);
  });
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
