/**
 * Execute a workflow while delivering inputs through a separate callback.
 * Before returning, stop input intake, finish any input already being processed,
 * and execute again if inputs completed since the last execution began.
 * The input iterator is private to the Postgres World.
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
      if (input.done || stopped) return;
      await deliver(input.value);
      revision++;
      changed();
    }
  })().catch((error) => {
    failure = { error };
    changed();
  });
  const deadline = Date.now() + 120_000;
  let stopping: Promise<void> | undefined;
  const stopInputs = () => {
    stopped = true;
    stopping ??= (async () => {
      try {
        await iterator.return?.();
      } finally {
        await pump;
      }
      checkFailure();
    })();
    return stopping;
  };
  try {
    for (;;) {
      const before = revision;
      const result = await execute();
      checkFailure();
      if (Date.now() < deadline && revision === before) {
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
      if (Date.now() >= deadline || revision === before) {
        // Stop intake before deciding this job is finished. A delivery can be
        // in flight throughout the idle window (or the execution deadline).
        // Once it commits, this may be its only remaining durable wake.
        await stopInputs();
        return revision === before ? result : await execute();
      }
    }
  } finally {
    await stopInputs();
  }
}
