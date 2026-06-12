// The deadline flush is NOT tested by waiting MAX_WAIT_MS (5 minutes) or by
// force-waking the coordinator's real timer child (that run is spawned
// inside a step and isn't reachable from the test). Instead the test starts
// its own aggregatorTimer(key, 1ms, timerId=1) — byte-for-byte the workflow
// the coordinator spawns — which delivers the same { type: 'timer',
// timerId: 1 } message and matches the current timerSeq, exercising the
// deadline-flush path end to end. The real 5-minute timer child later finds
// the coordinator gone and exits via its catch — by design.
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
};

// Read-only and idempotent, so retried on WorkflowRunNotFoundError: a
// concurrently launched vitest invocation reuses this worker's pool-id tag
// and its setup clear() can delete our in-flight run files.
async function readFlushesFor(key: string) {
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

    const result = await coordinator.returnValue;
    expect(result).toEqual({
      key: KEYS.size,
      flushed: MAX_ITEMS,
      reason: 'size',
    });

    const flushes = await readFlushesFor(KEYS.size);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].reason).toBe('size');
    expect(flushes[0].items).toHaveLength(MAX_ITEMS);
    expect(flushes[0].items[0]).toBe('item-0');
    expect(flushes[0].items[MAX_ITEMS - 1]).toBe(`item-${MAX_ITEMS - 1}`);
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

    const result = await coordinator.returnValue;
    expect(result).toEqual({
      key: KEYS.dedupe,
      flushed: MAX_ITEMS,
      reason: 'size',
    });

    const flushes = await readFlushesFor(KEYS.dedupe);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].items).toHaveLength(MAX_ITEMS);
    expect(flushes[0].items).not.toContain('item-0-DUPLICATE');
    expect(flushes[0].items.filter((item) => item === 'item-0')).toHaveLength(
      1
    );
  });

  it('flushes a partial buffer when the deadline timer fires', async () => {
    await aggregatorSend(KEYS.deadline, 'a', 'id-a');
    const hook = await getHookByToken(`aggregator:${KEYS.deadline}`);
    const coordinator = getRun(hook.runId);

    await aggregatorSend(KEYS.deadline, 'b', 'id-b');
    await aggregatorSend(KEYS.deadline, 'c', 'id-c');

    // Deliver the deadline message without waiting MAX_WAIT_MS (see file
    // header). timerSeq is 1: only the first item starts the deadline.
    const timer = await start(aggregatorTimer, [KEYS.deadline, 1, 1]);
    await timer.returnValue;

    const result = await coordinator.returnValue;
    expect(result).toEqual({
      key: KEYS.deadline,
      flushed: 3,
      reason: 'deadline',
    });

    const flushes = await readFlushesFor(KEYS.deadline);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].reason).toBe('deadline');
    expect(flushes[0].items).toEqual(['a', 'b', 'c']);
  });
});
