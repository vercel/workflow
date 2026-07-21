import type { World } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { getReturnValueStreamId } from '../util.js';
import { isReturnValueStreamEnabled } from './constants.js';

/**
 * Fast-path completion signal for `await run.returnValue`.
 *
 * The waiter (see {@link createReturnValueSignalWaiter}, wired into
 * `Run#pollReturnValue`) blocks on a run-scoped system stream instead of a
 * fixed ~1s poll. The writer ({@link signalRunTerminal}) drops a tiny marker
 * onto that stream at every terminal transition so the waiter wakes within a
 * stream round-trip, then re-reads the authoritative run record.
 *
 * The stream is a *signal only*, never the source of truth: the waiter always
 * fetches the real result via `runs.get` after being woken, and a slow
 * fallback poll backstops any missed signal (crash between the terminal event
 * write and the stream write, transient stream failure, pre-feature runs).
 */

/**
 * The single byte written to the return-value system stream to wake a waiter.
 * The content is irrelevant — the waiter re-fetches the run on any non-empty
 * chunk — so this is deliberately minimal.
 */
const RETURN_VALUE_SIGNAL_MARKER = new Uint8Array([1]);

/**
 * Whether the return-value stream fast path should engage. Gated only on the
 * kill switch (default on): every World implements streams with the durable
 * cross-reader catch-up this relies on — a late/racing reader opening at
 * `startIndex: 0` observes a marker written (and the close) before it attached
 * — verified per-world in the test suite, so there is no per-World capability
 * gate. Both the writer and the waiter gate on this, so with the kill switch
 * thrown the writer emits nothing and the waiter keeps the legacy fixed poll,
 * byte-identical to the pre-feature behavior.
 *
 * Takes `world` (unused today) to keep the writer/waiter call sites uniform and
 * leave room to fall back should a future World ever lack stream catch-up.
 */
export function isReturnValueSignalActive(_world: World): boolean {
  return isReturnValueStreamEnabled();
}

/**
 * Emit the run-completion fast-path signal for a run that has just reached a
 * terminal transition (completed / failed / cancelled). Best-effort: gated on
 * {@link isReturnValueSignalActive} and swallows every error, because a failed
 * signal only costs the waiter its fast path — the fallback poll still
 * resolves it. Callers should invoke this *after* the authoritative terminal
 * `run_*` event has been durably written.
 *
 * Awaited by callers so the stream write completes before the invocation is
 * frozen/terminated (Vercel drops in-flight fetches once the handler returns);
 * the two stream RPCs are the small cost the completing side pays to save the
 * waiting side up to a full poll interval.
 */
export async function signalRunTerminal(
  world: World,
  runId: string
): Promise<void> {
  if (!isReturnValueSignalActive(world)) return;
  const name = getReturnValueStreamId(runId);
  try {
    await world.streams.write(runId, name, RETURN_VALUE_SIGNAL_MARKER);
    await world.streams.close(runId, name);
  } catch (err) {
    // Best-effort fast path — the waiter's fallback poll covers a miss.
    runtimeLogger.debug('return-value signal write failed (non-fatal)', {
      workflowRunId: runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A one-shot waiter over the run-scoped return-value system stream. Opens a
 * single reader lazily and lets the poll loop `await` "signal or timeout" in
 * place of its fixed sleep. Once the stream signals (a non-empty chunk or a
 * clean close) the reader is exhausted and subsequent waits fall through to
 * the fallback timer — by then the run is terminal and the loop's top-of-turn
 * `runs.get` resolves it.
 */
export interface ReturnValueSignalWaiter {
  /**
   * Resolve when the stream signals OR after `fallbackMs`, whichever comes
   * first. Never rejects — a stream-read failure degrades to timeout-only
   * waiting so the caller keeps polling at the fallback cadence.
   */
  waitForSignalOrTimeout(fallbackMs: number): Promise<void>;
  /** Tear down the underlying stream reader. Idempotent. */
  close(): void;
}

export function createReturnValueSignalWaiter(
  world: World,
  runId: string
): ReturnValueSignalWaiter {
  const name = getReturnValueStreamId(runId);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let signalled = false;
  // The in-flight "read until first real chunk or close" promise. Created once
  // and reused across waits so a signal arriving during a fallback window
  // isn't dropped between iterations.
  let readPromise: Promise<void> | undefined;

  function beginRead(): Promise<void> {
    if (!readPromise) {
      readPromise = (async () => {
        try {
          // startIndex 0: read from the beginning so a marker written before
          // the reader attached (the late-attach / catch-up case) is replayed
          // rather than skipped.
          const stream = await world.streams.get(runId, name, 0);
          reader = stream.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            // The stream backend may flush a leading zero-length chunk to
            // commit response headers before any data; skip empties so we only
            // wake on the real marker (or the terminal close).
            if (value && value.byteLength > 0) break;
          }
        } catch (err) {
          // Read failed — signal won't arrive in real time; rely on the
          // fallback poll. Mark signalled so we don't spin reopening a broken
          // stream every iteration.
          runtimeLogger.debug('return-value signal read failed (non-fatal)', {
            workflowRunId: runId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          signalled = true;
        }
      })();
    }
    return readPromise;
  }

  return {
    async waitForSignalOrTimeout(fallbackMs: number): Promise<void> {
      // Once the stream has signalled (or failed), there is nothing more to
      // wait on — just honor the fallback interval before the next runs.get.
      if (signalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, fallbackMs));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, fallbackMs);
      });
      try {
        await Promise.race([beginRead(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close(): void {
      const r = reader;
      reader = undefined;
      if (r) {
        // Fire-and-forget: a service-backed World's cancel may hit the network,
        // and tearing down must not block returnValue's resolution.
        void r.cancel().catch(() => {});
      }
    },
  };
}
