import { describe, expect, it } from 'vitest';
import { getRun, start } from 'workflow/api';
import {
  fixBugAndRedrive,
  readDeadLetterSink,
} from '../workflows/drivers/dead-letter-queue-drivers.js';
import {
  processWithDeadLetters,
  type QueueItem,
} from '../workflows/patterns/dead-letter-queue.js';

const RUN = Date.now().toString(36);

function item(id: string, poison = false): QueueItem {
  return {
    id,
    payload: { value: `payload-${id}`, ...(poison ? { poison: true } : {}) },
  };
}

async function snapshotSink() {
  const run = await start(readDeadLetterSink, []);
  return await run.returnValue;
}

// NOTE: test order matters — fixBugAndRedrive flips a module-level demo
// flag, so the redrive test runs last.
describe('dead letter queue pattern', () => {
  it('dead-letters the poison item and keeps processing the rest', async () => {
    const poisonId = `dlq-${RUN}-poison`;
    const items = [
      item(`dlq-${RUN}-1`),
      item(poisonId, true),
      item(`dlq-${RUN}-2`),
      item(`dlq-${RUN}-3`),
    ];

    const run = await start(processWithDeadLetters, [items]);
    const result = await run.returnValue;

    expect(result).toEqual({ total: 4, succeeded: 3, deadLettered: 1 });

    // The DLQ holds the poison item with its payload and error message.
    const sink = await snapshotSink();
    const deadLetter = sink.find((entry) => entry.item.id === poisonId);
    expect(deadLetter).toBeDefined();
    expect(deadLetter?.item.payload).toMatchObject({ poison: true });
    expect(deadLetter?.error).toContain(`Cannot process ${poisonId}`);
    expect(deadLetter?.failedAt).toBeTypeOf('string');
  });

  it('redrives dead letters successfully once the bug is fixed', async () => {
    // Everything currently in the sink came from the previous test (plus
    // any retries) — all of it is poison-flagged.
    const before = await snapshotSink();
    expect(before.length).toBeGreaterThanOrEqual(1);

    const run = await start(fixBugAndRedrive, [100]);
    const redrive = await run.returnValue;
    if (!('runId' in redrive)) {
      throw new Error('Expected redrive to start a batch');
    }
    expect(redrive.redriven).toBe(before.length);

    // The redrive batch reprocesses the items with the same workflow — all
    // succeed now that the demo bug is fixed.
    const batchResult = await getRun<{
      total: number;
      succeeded: number;
      deadLettered: number;
    }>(redrive.runId).returnValue;
    expect(batchResult).toEqual({
      total: before.length,
      succeeded: before.length,
      deadLettered: 0,
    });

    // The sink was drained and nothing was re-dead-lettered.
    const after = await snapshotSink();
    expect(after).toEqual([]);
  });

  it('redrive is a no-op when the DLQ is empty', async () => {
    const run = await start(fixBugAndRedrive, [100]);
    const redrive = await run.returnValue;
    expect(redrive).toEqual({ redriven: 0 });
  });
});
