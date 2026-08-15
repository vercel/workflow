import { EventEmitter } from 'node:events';
import { envNumber } from '@workflow/world';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Drizzle } from './drizzle/index.js';
import { listenChannel } from './streamer.js';

/**
 * Terminal-run-status wakeups behind `runs.waitForTerminalStatus`.
 *
 * A caller awaiting a run's outcome (`await run.returnValue`) asks the World
 * to hold the read until the run finishes, instead of re-reading it every
 * second and paying up to a full interval of quantization. Postgres already
 * has the primitive for that: the run-terminal write issues a `NOTIFY` (see
 * {@link notifyRunTerminal}) and the waiter is parked on a `LISTEN` for it —
 * the same mechanism `createStreamer` uses for stream chunks.
 *
 * The notification is a *signal only*: waiters re-read the run row, so a
 * duplicate or lost message can never produce a wrong answer. Because it can
 * be lost — a `NOTIFY` that fires between a waiter's read and its `LISTEN`, a
 * dropped listener connection — the wait is also backstopped by a periodic
 * re-read ({@link getRunStatusPollIntervalMs}), which bounds the damage of a
 * miss to one interval.
 *
 * One `LISTEN` connection is shared by every waiter in the process and is
 * opened lazily, so a deployment that never awaits a run never pays for it.
 */

/** `NOTIFY` channel carrying terminal run ids. */
export const RUN_STATUS_TOPIC = 'workflow_run_status';

/**
 * How long to wait before re-attempting the shared `LISTEN` connection after a
 * failed attempt. Long enough that a database that cannot host the listener at
 * all costs one connection attempt every few seconds rather than one per
 * waiting run per poll interval, short enough that a restart is picked back up
 * well within a single run's wait.
 */
const LISTEN_RETRY_BACKOFF_MS = 5_000;

const RUN_STATUS_POLL_INTERVAL_MS = 1_000;

/**
 * Backstop re-read interval for a terminal-status wait, in ms. Override with
 * `WORKFLOW_POSTGRES_RUN_STATUS_POLL_INTERVAL_MS`.
 *
 * The `NOTIFY` is what makes the wait fast; this only bounds how long a *lost*
 * notification can go unnoticed, so it is kept at the interval the SDK would
 * have polled at anyway — the wait is then never slower than the poll it
 * replaces, and normally three orders of magnitude faster.
 */
export function getRunStatusPollIntervalMs(): number {
  return envNumber(
    'WORKFLOW_POSTGRES_RUN_STATUS_POLL_INTERVAL_MS',
    RUN_STATUS_POLL_INTERVAL_MS,
    { integer: true, min: 1 }
  );
}

/**
 * Announce that a run reached a terminal status.
 *
 * Best-effort: a failed `NOTIFY` costs a waiter its backstop interval and
 * nothing else, so it must never fail the write that produced the status.
 * Call it after the terminal `UPDATE` has committed.
 */
export async function notifyRunTerminal(
  drizzle: Drizzle,
  runId: string
): Promise<void> {
  try {
    await drizzle.execute(sql`SELECT pg_notify(${RUN_STATUS_TOPIC}, ${runId})`);
  } catch {
    // Intentionally ignored — see above.
  }
}

export interface RunStatusListener {
  /**
   * Resolve when `runId` is announced terminal, when `timeoutMs` elapses, or
   * when `signal` aborts — whichever is first. The caller decides what
   * happened by re-reading the run.
   */
  wait(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  /** Release the shared `LISTEN` connection. Safe to call more than once. */
  close(): Promise<void>;
}

export function createRunStatusListener(pool: Pool): RunStatusListener {
  const emitter = new EventEmitter<{ [key: `run:${string}`]: [] }>();
  // Many runs can be awaited at once; the 10-listener default would warn on
  // legitimate fan-out.
  emitter.setMaxListeners(0);

  let subscription:
    | Promise<{ close: () => Promise<void> } | undefined>
    | undefined;
  let retrySubscribeAfter = 0;

  const ensureSubscribed = () => {
    if (subscription) return subscription;
    // A failed LISTEN must be re-attemptable — a database restart or a brief
    // network blip at process start would otherwise degrade every wait to
    // backstop polling for the lifetime of the process. Bounded by a backoff
    // so that a genuinely unavailable listener does not turn every waiting
    // run into a connection attempt per poll interval.
    if (Date.now() < retrySubscribeAfter) return undefined;

    subscription = listenChannel(pool, RUN_STATUS_TOPIC, async (payload) => {
      if (payload) emitter.emit(`run:${payload}`);
    }).catch(() => {
      // No listener connection available (pool options that don't permit a
      // second client, a database without LISTEN, a restarting server). Waits
      // degrade to the backstop re-read — the behavior of a plain poll — and
      // the next wait past the backoff tries again.
      subscription = undefined;
      retrySubscribeAfter = Date.now() + LISTEN_RETRY_BACKOFF_MS;
      return undefined;
    });
    return subscription;
  };

  return {
    async wait(runId, timeoutMs, signal) {
      if (timeoutMs <= 0 || signal?.aborted) return;

      const key = `run:${runId}` as const;
      // Kick off (or reuse) the shared subscription without awaiting it, so
      // the listener below is registered in this same tick — a notification
      // delivered while the connection is still coming up then lands on this
      // waiter instead of slipping past it.
      void ensureSubscribed();

      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          emitter.off(key, settle);
          signal?.removeEventListener('abort', settle);
          resolve();
        };

        const timer = setTimeout(settle, timeoutMs);
        // Never hold the process open for a run nobody is waiting on anymore.
        timer.unref?.();
        emitter.once(key, settle);
        signal?.addEventListener('abort', settle, { once: true });
      });
    },

    async close() {
      const pending = subscription;
      subscription = undefined;
      // Keep a closed listener closed: nothing should re-open it after the
      // world has been shut down.
      retrySubscribeAfter = Number.POSITIVE_INFINITY;
      emitter.removeAllListeners();
      const active = await pending?.catch(() => undefined);
      await active?.close().catch(() => undefined);
    },
  };
}
