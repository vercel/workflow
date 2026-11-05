/**
 * Coalesce concurrent calls that share a key: while a call for `key` is
 * running, later calls for the same key get its promise instead of starting
 * another. The entry is dropped once the call settles, so a later call (after
 * a failure, say) runs again.
 *
 * A Durable Object has one live instance, so an in-memory map is enough to
 * make "check the stored outcome, then do the work and store it" safe against
 * the requests that interleave at the work's `await`s.
 */
export function singleFlight<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = (async () => fn())().finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}
