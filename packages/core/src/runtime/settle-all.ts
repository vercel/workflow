/**
 * Waits for every one of `promises` to settle, then throws the first
 * rejection in list order (not the first in time), if any. Nothing the caller
 * does next can overlap a promise still in flight, and a failure is not lost
 * because another settled first.
 */
export async function settleAllThrowFirst(
  promises: readonly Promise<unknown>[]
): Promise<void> {
  // Nothing to wait for costs no turn of the event loop.
  if (promises.length === 0) return;
  const settled = await Promise.allSettled(promises);
  const failed = settled.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  if (failed) throw failed.reason;
}

/**
 * Runs `tasks` with at most `limit` in flight at once, in list order, and,
 * like {@link settleAllThrowFirst}, resolves once every one has settled and
 * throws the first rejection in list order. The first `limit` tasks start
 * before this returns its promise, the rest as earlier ones settle; a task
 * that must claim something before any other code runs claims it before it is
 * queued here.
 */
export async function runBounded(
  tasks: readonly (() => Promise<unknown>)[],
  limit: number
): Promise<void> {
  if (tasks.length === 0) return;
  const failures: { index: number; reason: unknown }[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      try {
        await tasks[index]!();
      } catch (reason) {
        failures.push({ index, reason });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker)
  );
  if (failures.length > 0) {
    throw failures.reduce((a, b) => (b.index < a.index ? b : a)).reason;
  }
}
