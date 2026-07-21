import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createReturnValueSignalWaiter,
  signalRunTerminal,
} from './return-value-signal.js';

/**
 * Per-world verification for the return-value fast path against the *real*
 * world-local streamer (filesystem-backed, in-process EventEmitter + disk
 * poll). Exercises the catch-up contract the waiter depends on: a marker
 * written and the stream closed at a run's terminal transition is observed by
 * a reader opening at `startIndex: 0`, whether it attaches after the fact
 * (durable disk replay) or races the write (live delivery).
 */

// If the signal is really being observed, the waiter resolves in milliseconds;
// the fallback poll is set far higher so a resolution this fast can only be the
// signal, never the timeout.
const FALLBACK_MS = 60_000;
const SIGNAL_DEADLINE_MS = 3_000;

/** Reject if the promise does not settle within `ms` — proves signal, not fallback. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`did not resolve within ${ms}ms`)),
        ms
      ).unref?.()
    ),
  ]);
}

describe('return-value signal against world-local', () => {
  let dir: string;
  let world: LocalWorld;

  beforeEach(async () => {
    delete process.env.WORKFLOW_RETURN_VALUE_STREAM;
    dir = mkdtempSync(join(tmpdir(), 'rv-signal-local-'));
    world = createWorld({
      dataDir: dir,
      recoverActiveRuns: false,
      // Flush stream writes immediately so the test doesn't wait on a buffer.
      streamFlushIntervalMs: 0,
    });
    await world.start();
  });

  afterEach(async () => {
    delete process.env.WORKFLOW_RETURN_VALUE_STREAM;
    await world.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('late attach: a reader opened after write+close catches up on the buffered marker/close', async () => {
    const runId = 'wrun_localLate';
    // Terminal signal fires and completes fully before any reader exists.
    await signalRunTerminal(world, runId);

    const waiter = createReturnValueSignalWaiter(world, runId);
    try {
      await withDeadline(
        waiter.waitForSignalOrTimeout(FALLBACK_MS),
        SIGNAL_DEADLINE_MS
      );
    } finally {
      waiter.close();
    }
  });

  it('live fast path: a reader opened before the signal wakes when it fires', async () => {
    const runId = 'wrun_localLive';
    const waiter = createReturnValueSignalWaiter(world, runId);
    // Begin waiting first, then emit the terminal signal.
    const waited = waiter.waitForSignalOrTimeout(FALLBACK_MS);
    await signalRunTerminal(world, runId);
    try {
      await withDeadline(waited, SIGNAL_DEADLINE_MS);
    } finally {
      waiter.close();
    }
  });
});
