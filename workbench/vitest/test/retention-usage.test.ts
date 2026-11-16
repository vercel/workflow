import { randomBytes } from 'node:crypto';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import { retentionUsageWorkflow } from '../workflows/retention-usage.js';

/**
 * Data Written is what a run wrote. Deleting a run's data when it finishes
 * (`experimental_retention: 0`) saves on Data Retained, not on Data Written,
 * so two runs that write the same data report the same size.
 */
async function runTwice(specVersion?: number) {
  // Random, so no payload compression can shrink one copy and not the other.
  const payload = new Uint8Array(randomBytes(300_000));
  const world = await getWorld();
  const usageOf = async (options: Parameters<typeof start>[2]) => {
    const run = await start(retentionUsageWorkflow, [payload], {
      ...(specVersion !== undefined && { specVersion }),
      ...options,
    });
    // A purged run's return value is gone with its data, so wait for it to
    // finish instead of reading it.
    await expect.poll(() => run.status, { timeout: 30_000 }).toBe('completed');
    return world.experimental_usage!.getRun(run.runId);
  };
  const kept = await usageOf({});
  const purged = await usageOf({ experimental_retention: 0 });
  console.log(
    `spec ${specVersion ?? 'default'}: kept ${kept.dataWritten.bytes} bytes (${JSON.stringify(kept.dataWritten.byEntity)}), purged ${purged.dataWritten.bytes} bytes (${JSON.stringify(purged.dataWritten.byEntity)})`
  );
  return { kept, purged };
}

/** Bytes two equal runs' rows may differ by, entity by entity. */
const TOLERANCE = 100;

function expectSameDataWritten(
  kept: Awaited<ReturnType<typeof runTwice>>['kept'],
  purged: Awaited<ReturnType<typeof runTwice>>['purged']
) {
  expect(purged.events).toBe(kept.events);
  for (const entity of ['run', 'step', 'hook', 'stream'] as const) {
    // Equal up to the few bytes that differ between any two runs: step
    // events carry latency telemetry whose digits vary, and the purged
    // run's events carry its `"$retention":"0"` attribute.
    expect(
      Math.abs(
        purged.dataWritten.byEntity[entity] - kept.dataWritten.byEntity[entity]
      ),
      entity
    ).toBeLessThan(TOLERANCE);
  }
  // Both wrote the 300 KB payload at least twice (run input, step input).
  expect(kept.dataWritten.bytes).toBeGreaterThan(600_000);
  expect(purged.dataWritten.bytes).toBeGreaterThan(600_000);
  expect(kept.dataWritten.source).toBe('log');
  expect(purged.dataWritten.source).toBe('saved-at-purge');
}

describe('data written by a run whose data is deleted when it finishes', () => {
  it('is what the run wrote, at the default spec', async () => {
    const { kept, purged } = await runTwice();
    expectSameDataWritten(kept, purged);
    expect(kept.dataPurged).toBe(false);
    expect(purged.dataPurged).toBe(true);
  }, 60_000);

  it('is what the run wrote, on spec 9', async () => {
    const { kept, purged } = await runTwice(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    expectSameDataWritten(kept, purged);
    expect(kept.dataPurged).toBe(false);
    expect(purged.dataPurged).toBe(true);
  }, 60_000);
});
