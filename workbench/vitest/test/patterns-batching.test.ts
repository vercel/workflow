import { waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import type { Run } from 'workflow/api';
import { getRun, start } from 'workflow/api';
import {
  batchImport,
  type ImportRecord,
} from '../workflows/patterns/batching.js';

const RUN = Date.now().toString(36);

function record(name: string, email: string): ImportRecord {
  return { name, email, role: 'member' };
}

/** Wake the next not-yet-woken sleep (skips IDs we already woke). */
async function wakeNextSleep(
  run: Run<unknown>,
  woken: Set<string>
): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sleepId = await waitForSleep(run);
    if (!woken.has(sleepId)) {
      woken.add(sleepId);
      await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });
      return sleepId;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for a new pending sleep');
}

describe('batching pattern', () => {
  it('processes all records in batches, pacing with a sleep between batches', async () => {
    // 5 records with batchSize 2 → batches of [2, 2, 1] → 2 pacing sleeps.
    const records = [
      record('A', `a-${RUN}@test.dev`),
      record('B', `b-${RUN}@test.dev`),
      record('C', `c-${RUN}@test.dev`),
      record('D', `d-${RUN}@test.dev`),
      record('E', `e-${RUN}@test.dev`),
    ];
    const run = await start(batchImport, [records, 2]);

    const woken = new Set<string>();
    await wakeNextSleep(run, woken);
    await wakeNextSleep(run, woken);

    const result = await run.returnValue;
    expect(result).toEqual({ total: 5, succeeded: 5, failed: 0, failures: [] });
    // Batch boundaries respected: exactly ceil(5/2) - 1 = 2 pacing sleeps.
    expect(woken.size).toBe(2);
  });

  it('isolates failures inside a batch instead of aborting the import', async () => {
    const badEmail = `no-at-sign-${RUN}`;
    const records = [
      record('A', `ok1-${RUN}@test.dev`),
      record('B', badEmail),
      record('C', `ok2-${RUN}@test.dev`),
    ];
    const run = await start(batchImport, [records, 2]);

    const woken = new Set<string>();
    await wakeNextSleep(run, woken);

    const result = await run.returnValue;
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].email).toBe(badEmail);
    expect(result.failures[0].reason).toContain('Invalid email');
  });

  it('does not sleep when everything fits in a single batch', async () => {
    const records = [
      record('A', `solo1-${RUN}@test.dev`),
      record('B', `solo2-${RUN}@test.dev`),
    ];
    const run = await start(batchImport, [records, 10]);

    const result = await run.returnValue;
    expect(result).toEqual({ total: 2, succeeded: 2, failed: 0, failures: [] });
  });
});
