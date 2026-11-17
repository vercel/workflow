/**
 * Runs with an orchestrator message waiting behind a running delivery that
 * the delivery cannot cover with a re-run: a `run.wakeUp()` naming waits, a
 * start, a legacy hook resume, a recovery message, or an invocation. Shared
 * by a World's queue, which marks them, and its live feed, which ends a
 * marked run's subscriptions and refuses new ones. A delivery whose feed is
 * down does not linger, so it releases the run's gate to the message at once
 * instead of after the linger window.
 */
export interface BlockedRuns {
  /**
   * Marks `runId` blocked until the returned function is called (by the
   * waiting message once it holds the gate). Idempotent release.
   */
  block(runId: string): () => void;
  /** Whether a message is waiting for `runId`. */
  isBlocked(runId: string): boolean;
  /**
   * Calls `listener` when a run becomes blocked. Returns a function that
   * removes it.
   */
  onBlocked(listener: (runId: string) => void): () => void;
}

export function createBlockedRuns(): BlockedRuns {
  const counts = new Map<string, number>();
  const listeners = new Set<(runId: string) => void>();
  return {
    block(runId) {
      const count = counts.get(runId) ?? 0;
      counts.set(runId, count + 1);
      if (count === 0) {
        for (const listener of [...listeners]) {
          try {
            listener(runId);
          } catch {
            // A listener's failure is its own.
          }
        }
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (counts.get(runId) ?? 1) - 1;
        if (left > 0) counts.set(runId, left);
        else counts.delete(runId);
      };
    },
    isBlocked(runId) {
      return counts.has(runId);
    },
    onBlocked(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
