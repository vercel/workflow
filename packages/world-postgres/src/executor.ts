/** How long after an execution a job waits for an input to complete. */
const IDLE_WINDOW_MS = 100;

/**
 * Execute a workflow while delivering inputs through a separate callback.
 * Before returning, stop input intake, finish any input already being processed,
 * and execute again if inputs completed since the last execution began.
 * The input iterator is private to the Postgres World.
 *
 * The job is finished once an execution returned and no input completed
 * since it began, for an idle window after it. An input that is still being
 * delivered is not idle, however long its delivery takes: the job waits for
 * it and executes again, and so reaches the inputs the source holds behind
 * it. Ending there instead would drop them, and a delivery can be the only
 * wake those inputs have left (the wakes of inputs sent while a run's lease
 * was held collapse into one).
 *
 * Stopping intake can still leave an input undelivered: one the source hands
 * over as intake stops, or one it had read but not handed over yet.
 * `afterIntake` runs once intake has stopped and no input is being delivered,
 * before the job returns, so the caller can look for such inputs and leave a
 * wake for them.
 */
export async function executeWithInputs<T>(
  source: AsyncIterable<T>,
  execute: () => Promise<unknown>,
  deliver: (input: T) => Promise<void>,
  afterIntake?: () => Promise<void>
): Promise<unknown> {
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;
  let revision = 0;
  /** An input is being delivered. */
  let delivering = false;
  let failure: { error: unknown } | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const notify of listeners) notify();
  };
  const checkFailure = () => {
    if (failure) throw failure.error;
  };
  /** Resolves when an input completes or fails, or after `ms`. */
  const nextChange = (ms: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      listeners.add(finish);
    });
  const pump = (async () => {
    while (!stopped) {
      const input = await iterator.next();
      if (input.done || stopped) return;
      delivering = true;
      try {
        await deliver(input.value);
      } finally {
        delivering = false;
      }
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
        await nextChange(IDLE_WINDOW_MS);
      }
      // Not idle while an input is being delivered: wait for it to complete
      // (or fail), then execute again.
      while (
        delivering &&
        revision === before &&
        !failure &&
        Date.now() < deadline
      ) {
        await nextChange(deadline - Date.now());
      }
      checkFailure();
      if (Date.now() >= deadline || revision === before) {
        // Stop intake before deciding this job is finished. A delivery can be
        // in flight throughout the idle window (or the execution deadline).
        // Once it commits, this may be its only remaining durable wake.
        await stopInputs();
        const final = revision === before ? result : await execute();
        await afterIntake?.();
        return final;
      }
    }
  } finally {
    await stopInputs();
  }
}
