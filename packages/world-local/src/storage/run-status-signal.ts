import { EventEmitter } from 'node:events';
import { envNumber } from '@workflow/world';

/**
 * In-process wakeups for `runs.waitForTerminalStatus`.
 *
 * world-local's store is the filesystem, which has no change notification a
 * reader can subscribe to. So the wait is built from two halves:
 *
 * - **The emitter below**, signaled by the run-lifecycle writer
 *   (`writeRunUnderLifecycleLock` in `events-storage.ts`) whenever it commits
 *   a terminal run. In the ordinary local-dev topology the workflow and the
 *   caller awaiting its result live in the same process, so this is the path
 *   that actually fires, and it fires within a tick of the run finishing.
 *
 * - **A short backstop poll** of the run file (see
 *   {@link getRunStatusPollIntervalMs}), which covers everything the emitter
 *   cannot see: a second process (a `wf dev` server plus a separate CLI
 *   invocation, or several workers over one data dir), and the narrow window
 *   between a waiter's read and its subscribe.
 *
 * Neither half is trusted for the status itself: the waiter always re-reads
 * the run file, so a missed or duplicated signal only ever costs latency.
 */

/** Signals are edge-only: the run id is the whole message. */
const emitter = new EventEmitter<{ [key: `run:${string}`]: [] }>();
// A dev server can have many runs awaited at once; the default cap of 10
// listeners per event would warn on legitimate fan-out.
emitter.setMaxListeners(0);

const RUN_STATUS_POLL_INTERVAL_MS = 100;

/**
 * Backstop interval for the terminal-status wait, in ms. Override with
 * `WORKFLOW_LOCAL_RUN_STATUS_POLL_INTERVAL_MS`.
 *
 * Deliberately far below the SDK's own 1s `runs.get` poll: re-reading one
 * small JSON file is cheap, and this is the ceiling on how long a *cross
 * process* local run takes to be noticed.
 */
export function getRunStatusPollIntervalMs(): number {
  return envNumber(
    'WORKFLOW_LOCAL_RUN_STATUS_POLL_INTERVAL_MS',
    RUN_STATUS_POLL_INTERVAL_MS,
    { integer: true, min: 1 }
  );
}

/**
 * Announce that a run reached a terminal status in this process. Call it after
 * the run file has been written, so a woken waiter re-reads a terminal run.
 */
export function signalRunTerminal(runId: string): void {
  emitter.emit(`run:${runId}`);
}

/**
 * Wait for the next in-process terminal signal for `runId`, the timeout, or an
 * abort, whichever comes first. Resolves either way; the caller decides what
 * to do by re-reading the run.
 */
export function waitForRunTerminalSignal(
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const key = `run:${runId}` as const;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emitter.off(key, settle);
      signal?.removeEventListener('abort', settle);
      resolve();
    };

    // Deliberately left ref'd. Nothing else here holds the event loop open:
    // the emitter `once`, the abort listener and the pending promise are all
    // invisible to it, and world-local's store is the filesystem, so between
    // two backstop reads a process whose only job is `await run.returnValue`
    // has no active handle at all. Unref'ing this timer let such a process
    // drain its loop and exit 0 with the wait unsettled, silently returning
    // nothing for a run that was merely still going. The interval poll this
    // replaces (`Run#pollReturnValue`) sleeps on a ref'd timer for exactly
    // this reason, so keeping it ref'd is parity, not a new cost: a caller
    // that stops caring aborts via `params.signal`.
    const timer = setTimeout(settle, timeoutMs);
    emitter.once(key, settle);
    signal?.addEventListener('abort', settle, { once: true });
  });
}
