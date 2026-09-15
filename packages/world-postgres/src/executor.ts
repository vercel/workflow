/**
 * Backend-private input service for one executor HTTP request. Core only sees
 * ordinary handler calls and returns values; it never receives this iterator.
 */
export async function executeWithInputs<T>(
  source: AsyncIterable<T>,
  execute: () => Promise<unknown>,
  deliver: (input: T) => Promise<void>
): Promise<unknown> {
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;
  let revision = 0;
  let failure: { error: unknown } | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const notify of listeners) notify();
  };
  const checkFailure = () => {
    if (failure) throw failure.error;
  };
  const pump = (async () => {
    while (!stopped) {
      const input = await iterator.next();
      if (input.done) return;
      await deliver(input.value);
      revision++;
      changed();
    }
  })().catch((error) => {
    failure = { error };
    changed();
  });
  const deadline = Date.now() + 120_000;
  try {
    for (;;) {
      const before = revision;
      const result = await execute();
      checkFailure();
      if (Date.now() >= deadline) return result;
      if (revision === before) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            listeners.delete(finish);
            resolve();
          };
          const timer = setTimeout(finish, 100);
          listeners.add(finish);
        });
      }
      checkFailure();
      if (revision === before) return result;
    }
  } finally {
    stopped = true;
    await iterator.return?.();
    await pump;
    checkFailure();
  }
}
