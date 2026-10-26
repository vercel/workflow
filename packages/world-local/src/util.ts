/**
 * Creates a lazily-evaluated, memoized version of the provided function.
 *
 * The returned object exposes a `value` getter that calls `fn` only once,
 * caches its result, and returns the cached value on subsequent accesses.
 *
 * @typeParam T - The return type of the provided function.
 * @param fn - The function to be called once and whose result will be cached.
 * @returns An object with a `value` property that returns the memoized result of `fn`.
 */
export function once<T>(fn: () => T) {
  const result = {
    get value() {
      const value = fn();
      Object.defineProperty(result, 'value', { value });
      return value;
    },
  };
  return result;
}

/**
 * In-process per-key async mutex backed by a caller-supplied `Map`.
 * Used by `createEventsStorage` to serialize same-key event writes
 * (`step_*` for the same step, `hook_created` for the same hook) and by
 * `createStreamer` to serialize updates to a run's stream index.
 * The map is instantiated per instance: different
 * instances do NOT share locks, so two instances sharing one data
 * directory behave exactly like two separate OS processes from the
 * locking standpoint. Cross-instance / cross-process arbitration
 * relies on the on-disk constraint / claim / lock files instead.
 */
export function withInProcessLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = locks.get(key);
  const taskBox: { task?: Promise<T> } = {};
  const task = (async () => {
    if (prev) {
      // Wait for the previous task to settle; don't inherit its errors.
      await prev.catch(() => undefined);
    }
    try {
      return await fn();
    } finally {
      if (locks.get(key) === taskBox.task) {
        locks.delete(key);
      }
    }
  })();
  taskBox.task = task;
  locks.set(key, task);
  return task;
}
