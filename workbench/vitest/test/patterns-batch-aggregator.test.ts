// Deadlines are NOT tested by waiting MAX_WAIT_MS (5 minutes) or by
// force-waking the coordinator's real timer child (that run is spawned
// inside a step and isn't reachable from the test). Instead each test starts
// its own aggregatorTimer(key, 1ms, timerId) — byte-for-byte the workflow the
// coordinator spawns — which delivers the same { type: 'timer', timerId }
// message. It takes effect only when timerId matches the coordinator's
// current timerSeq, so the sequence numbers below track the real state
// machine.
//
// A flush does NOT end the run: the coordinator clears the buffer and keeps
// looping, and only winds down when a matching deadline finds the buffer
// empty. So every test ends by delivering one last timer to let the run
// finish — without it `await coordinator.returnValue` would sit for the full
// MAX_WAIT_MS. The real 5-minute timer children fire long after, find the
// coordinator gone, and exit via their catch — by design.
//
// How timerSeq moves (the coordinator bumps it on every transition that
// invalidates a pending deadline):
//   first item into an empty buffer → bump, arm MAX_WAIT_MS
//   size flush                      → no bump; that window's timer is still
//                                     pending and becomes the idle deadline
//   deadline flush                  → bump, arm the next idle deadline
import { afterAll, describe, expect, it } from 'vitest';
import { getHookByToken, getRun, start } from 'workflow/api';
import {
  cancelCoordinator,
  readAggregatorFlushes,
} from '../workflows/drivers/batch-aggregator-drivers.js';
import {
  aggregatorSend,
  aggregatorTimer,
} from '../workflows/patterns/batch-aggregator.js';

// MAX_ITEMS in the canonical file.
const MAX_ITEMS = 100;

// The local world persists across vitest invocations — coordinators from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = `${Date.now().toString(36)}`;
const KEYS = {
  size: `agg-size-${RUN}`,
  dedupe: `agg-dedupe-${RUN}`,
  deadline: `agg-deadline-${RUN}`,
  refill: `agg-refill-${RUN}`,
};

/** Deliver one deadline message to the `key` coordinator, now. */
async function deliverTimer(key: string, timerId: number) {
  const timer = await start(aggregatorTimer, [key, 1, timerId]);
  await timer.returnValue;
}

// Read the flushes recorded for `key`, waiting until at least `expected`
// have landed. aggregatorSend resolves when the resume commits, not when the
// coordinator has processed it, and the coordinator no longer returns at a
// flush (see file header), so there is no run to await as a barrier — poll.
//
// Read-only and idempotent, so also retried on WorkflowRunNotFoundError: a
// concurrently launched vitest invocation reuses this worker's pool-id tag
// and its setup clear() can delete our in-flight run files.
async function readFlushesFor(key: string, expected: number) {
  const deadline = Date.now() + 30_000;
  let flushes: Awaited<ReturnType<typeof readOnce>> = [];
  for (;;) {
    flushes = await readOnce(key);
    if (flushes.length >= expected || Date.now() > deadline) return flushes;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function readOnce(key: string) {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const read = await start(readAggregatorFlushes, [key]);
      return await read.returnValue;
    } catch (err) {
      if ((err as Error).name !== 'WorkflowRunNotFoundError') throw err;
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastErr;
}

describe('batch-aggregator', () => {
  afterAll(async () => {
    for (const key of Object.values(KEYS)) {
      await cancelCoordinator(`aggregator:${key}`);
    }
  });

  it('flushes when the buffer reaches MAX_ITEMS', async () => {
    // aggregatorSend is host-callable (it's not a workflow function).
    await aggregatorSend(KEYS.size, 'item-0', 'id-0');
    // Grab the coordinator run while it's alive (hooks are deleted when the
    // owning run completes).
    const hook = await getHookByToken(`aggregator:${KEYS.size}`);
    const coordinator = getRun(hook.runId);

    for (let i = 1; i < MAX_ITEMS; i++) {
      await aggregatorSend(KEYS.size, `item-${i}`, `id-${i}`);
    }

    const flushes = await readFlushesFor(KEYS.size, 1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].reason).toBe('size');
    expect(flushes[0].items).toHaveLength(MAX_ITEMS);
    expect(flushes[0].items[0]).toBe('item-0');
    expect(flushes[0].items[MAX_ITEMS - 1]).toBe(`item-${MAX_ITEMS - 1}`);

    // A size flush doesn't re-arm, so the first window's timer (seq 1) is
    // still pending and now serves as the idle deadline. Deliver it: the
    // buffer is empty, so the run winds down.
    await deliverTimer(KEYS.size, 1);
    expect(await coordinator.returnValue).toEqual({
      key: KEYS.size,
      flushed: MAX_ITEMS,
      reason: 'idle',
    });
  });

  it('dedupes items by id — a resent id does not count toward the flush', async () => {
    await aggregatorSend(KEYS.dedupe, 'item-0', 'id-0');
    const hook = await getHookByToken(`aggregator:${KEYS.dedupe}`);
    const coordinator = getRun(hook.runId);

    // Resend id-0 with a different payload — must be dropped.
    await aggregatorSend(KEYS.dedupe, 'item-0-DUPLICATE', 'id-0');

    // 99 more unique items bring the buffer to exactly MAX_ITEMS, proving
    // the duplicate didn't count (101 sends, 100 buffered).
    for (let i = 1; i < MAX_ITEMS; i++) {
      await aggregatorSend(KEYS.dedupe, `item-${i}`, `id-${i}`);
    }

    const flushes = await readFlushesFor(KEYS.dedupe, 1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].items).toHaveLength(MAX_ITEMS);
    expect(flushes[0].items).not.toContain('item-0-DUPLICATE');
    expect(flushes[0].items.filter((item) => item === 'item-0')).toHaveLength(
      1
    );

    await deliverTimer(KEYS.dedupe, 1);
    expect(await coordinator.returnValue).toEqual({
      key: KEYS.dedupe,
      flushed: MAX_ITEMS,
      reason: 'idle',
    });
  });

  it('flushes a partial buffer when the deadline timer fires', async () => {
    await aggregatorSend(KEYS.deadline, 'a', 'id-a');
    const hook = await getHookByToken(`aggregator:${KEYS.deadline}`);
    const coordinator = getRun(hook.runId);

    await aggregatorSend(KEYS.deadline, 'b', 'id-b');
    await aggregatorSend(KEYS.deadline, 'c', 'id-c');

    // timerSeq is 1: only the first item into an empty buffer arms a
    // deadline.
    await deliverTimer(KEYS.deadline, 1);

    const flushes = await readFlushesFor(KEYS.deadline, 1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].reason).toBe('deadline');
    expect(flushes[0].items).toEqual(['a', 'b', 'c']);

    // The deadline flush armed the next deadline as seq 2. Nothing arrived
    // in that window, so delivering it ends the run.
    await deliverTimer(KEYS.deadline, 2);
    expect(await coordinator.returnValue).toEqual({
      key: KEYS.deadline,
      flushed: 3,
      reason: 'idle',
    });
  });

  it('keeps buffering in the same run after a flush instead of exiting', async () => {
    // Why the coordinator loops rather than returning at a flush: a real
    // flush is a network call, and an item delivered while it is in flight
    // resumes a hook that a returning run would never read again. Here the
    // next window is filled immediately after a size flush; the proof that
    // nothing was orphaned is that the SAME run accounts for both windows.
    await aggregatorSend(KEYS.refill, 'first', 'id-first');
    const hook = await getHookByToken(`aggregator:${KEYS.refill}`);
    const coordinator = getRun(hook.runId);

    for (let i = 1; i < MAX_ITEMS; i++) {
      await aggregatorSend(KEYS.refill, `item-${i}`, `id-${i}`);
    }
    // The size flush has happened; the run is still alive and still owns the
    // token, so these open a fresh window (timerSeq bumps to 2).
    await aggregatorSend(KEYS.refill, 'after-1', 'id-after-1');
    await aggregatorSend(KEYS.refill, 'after-2', 'id-after-2');

    await deliverTimer(KEYS.refill, 2);

    const flushes = await readFlushesFor(KEYS.refill, 2);
    expect(flushes).toHaveLength(2);
    expect(flushes[0].reason).toBe('size');
    expect(flushes[0].items).toHaveLength(MAX_ITEMS);
    expect(flushes[1].reason).toBe('deadline');
    expect(flushes[1].items).toEqual(['after-1', 'after-2']);

    // One run, both windows: MAX_ITEMS + 2. A coordinator that returned at
    // the size flush could only ever report MAX_ITEMS.
    await deliverTimer(KEYS.refill, 3);
    expect(await coordinator.returnValue).toEqual({
      key: KEYS.refill,
      flushed: MAX_ITEMS + 2,
      reason: 'idle',
    });
  });
});
