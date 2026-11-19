import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  formatDataPurgedNote,
  RETENTION_ATTRIBUTE,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type SpecVersion,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseFor } from '../db/index.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { createWorld } from '../index.js';
import { createStorage, type LocalStorage } from '../storage/index.js';
import { createStreamer } from '../streamer.js';
import { createRun } from '../test-helpers.js';
import { PAYLOAD_BYTES_SQL } from './purged-usage.js';

let dataDir: string;
let storage: LocalStorage;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS', '1');
  dataDir = mkdtempSync(path.join(tmpdir(), 'purged-usage-'));
  storage = createStorage(dataDir);
});

afterEach(() => {
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const STEP = 'step//./src/workflows/order//chargeCard';
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

/**
 * A run whose data is deleted when it finishes, or its twin that keeps it.
 * The twin's attribute key has the same length as `$retention`, so the two
 * runs' rows are the same size byte for byte.
 */
async function startRun(
  purge: boolean,
  specVersion: SpecVersion = SPEC_VERSION_CURRENT
) {
  const run = await createRun(
    storage,
    {
      deploymentId: 'dpl_test',
      workflowName: 'workflow//./src/workflows/order//processOrder',
      input: bytes(5000),
      attributes: purge ? { [RETENTION_ATTRIBUTE]: '0' } : { zretention: '0' },
      allowReservedAttributes: true,
    } as never,
    specVersion
  );
  const runId = run.runId;
  const event = (e: Record<string, unknown>) =>
    storage.events.create(runId, { specVersion, ...e } as never);
  return { runId, event };
}

/** A completed step with payloads, a stream, then the run's finish. */
async function writeAndFinish(
  { runId, event }: Awaited<ReturnType<typeof startRun>>,
  opts: { leaveStepRunning?: string } = {}
) {
  await event({ eventType: 'run_started' });
  await event({
    eventType: 'step_created',
    correlationId: 'step_1',
    eventData: { stepName: STEP, input: bytes(3000) },
  });
  await event({ eventType: 'step_started', correlationId: 'step_1' });
  await event({
    eventType: 'step_completed',
    correlationId: 'step_1',
    eventData: { result: bytes(4000) },
  });
  if (opts.leaveStepRunning) {
    await event({
      eventType: 'step_started',
      correlationId: opts.leaveStepRunning,
      eventData: { stepName: STEP, input: bytes(1000) },
    });
  }
  const streamer = createStreamer(dataDir);
  // Stream names are global: one per run.
  await streamer.streams.write(runId, `strm_${runId}`, bytes(2500));
  await streamer.streams.close(runId, `strm_${runId}`);
  await event({
    eventType: 'run_completed',
    eventData: { output: bytes(6000) },
  });
}

const usageOf = (runId: string) => storage.experimental_usage!.getRun(runId);

const savedRows = (runId: string) =>
  databaseFor(dataDir).all(
    'SELECT * FROM run_usage_purged WHERE run_id = ?',
    runId
  );

describe('data written by a run whose data is deleted when it finishes', () => {
  it('reports the sizes saved before the purge, equal to a run that kept its data', async () => {
    const kept = await startRun(false);
    await writeAndFinish(kept);
    const purged = await startRun(true);
    await writeAndFinish(purged);

    const keptUsage = await usageOf(kept.runId);
    const purgedUsage = await usageOf(purged.runId);

    expect(keptUsage.dataWritten.source).toBe('log');
    expect(keptUsage.dataPurged).toBe(false);
    expect(purgedUsage.dataWritten.source).toBe('saved-at-purge');
    expect(purgedUsage.dataPurged).toBe(true);
    // Byte for byte what the twin that kept its data reports.
    expect(purgedUsage.dataWritten).toEqual({
      ...keptUsage.dataWritten,
      source: 'saved-at-purge',
    });
    expect(purgedUsage.dataWritten.byEntity.stream).toBe(2500);
    expect(purgedUsage.events).toBe(keptUsage.events);
    expect(purgedUsage.eventsBySpan).toEqual(keptUsage.eventsBySpan);

    // The purge did delete the data: the rows now hold a fraction of it.
    const left = databaseFor(dataDir).get<{ bytes: number }>(
      'SELECT SUM(length(CAST(doc AS BLOB))) AS bytes FROM events WHERE run_id = ?',
      purged.runId
    );
    expect(Number(left?.bytes)).toBeLessThan(purgedUsage.dataWritten.bytes / 5);
  });

  it('counts a late write on a finished spec 9 run exactly once', async () => {
    // A spec 9 run finishes while a step still runs; the step's completion
    // is appended after the purge (an append on a terminal run).
    const finishLate = async (purge: boolean) => {
      const run = await startRun(purge, SPEC_VERSION_SINGLE_ORCHESTRATOR);
      await writeAndFinish(run, { leaveStepRunning: 'step_late' });
      const before = await usageOf(run.runId);
      await run.event({
        eventType: 'step_completed',
        correlationId: 'step_late',
        eventData: { result: bytes(7000) },
      });
      return { runId: run.runId, before, after: await usageOf(run.runId) };
    };
    const kept = await finishLate(false);
    const purged = await finishLate(true);

    expect(purged.after.dataWritten.source).toBe('saved-at-purge');
    // The late row is added on top of the saved sizes, once.
    const lateRow =
      purged.after.dataWritten.byEntity.step -
      purged.before.dataWritten.byEntity.step;
    // The late payload's bytes, exactly: payloads, not the row's JSON.
    expect(lateRow).toBe(7000);
    expect(lateRow).toBe(
      kept.after.dataWritten.byEntity.step -
        kept.before.dataWritten.byEntity.step
    );
    expect(purged.after.dataWritten).toEqual({
      ...kept.after.dataWritten,
      source: 'saved-at-purge',
    });
    expect(purged.after.events).toBe(kept.after.events);
  });

  // A late step write on a purged run is scrubbed as it lands, by a second
  // purge in the same transaction: the sizes it wrote are saved first.
  for (const [eventType, field] of [
    ['step_completed', 'result'],
    ['step_failed', 'error'],
    ['step_retrying', 'error'],
  ] as const) {
    it(`counts the payload of a late ${eventType} in full, though it is scrubbed`, async () => {
      const finishLate = async (purge: boolean) => {
        const run = await startRun(purge, SPEC_VERSION_SINGLE_ORCHESTRATOR);
        await writeAndFinish(run, { leaveStepRunning: 'step_late' });
        const before = await usageOf(run.runId);
        await run.event({
          eventType,
          correlationId: 'step_late',
          eventData: { [field]: bytes(7000) },
        });
        return { runId: run.runId, before, after: await usageOf(run.runId) };
      };
      const kept = await finishLate(false);
      const purged = await finishLate(true);

      // The payload is gone from the row...
      const row = databaseFor(dataDir).get<{ bytes: number; seq: number }>(
        `SELECT length(CAST(doc AS BLOB)) AS bytes, seq FROM events
         WHERE run_id = ? AND event_type = ? ORDER BY seq DESC LIMIT 1`,
        purged.runId,
        eventType
      );
      expect(Number(row?.bytes)).toBeLessThan(7000);
      // ...and counted as written, the same as the twin's, never shrinking.
      expect(purged.after.dataWritten).toEqual({
        ...kept.after.dataWritten,
        source: 'saved-at-purge',
      });
      expect(purged.after.dataWritten.bytes).toBe(
        purged.before.dataWritten.bytes + 7000
      );
      // One saved row, now covering the late write.
      const saved = savedRows(purged.runId) as { seq: number }[];
      expect(saved).toHaveLength(1);
      expect(Number(saved[0].seq)).toBe(Number(row?.seq));
      // Read again: the same.
      expect((await usageOf(purged.runId)).dataWritten).toEqual(
        purged.after.dataWritten
      );
    });
  }

  it('saves nothing on a late write to a run purged before sizes were saved', async () => {
    const purged = await startRun(true, SPEC_VERSION_SINGLE_ORCHESTRATOR);
    await writeAndFinish(purged, { leaveStepRunning: 'step_late' });
    // A purge by a world-local that did not save sizes.
    const db = databaseFor(dataDir);
    db.run('DELETE FROM run_usage_purged WHERE run_id = ?', purged.runId);
    await purged.event({
      eventType: 'step_completed',
      correlationId: 'step_late',
      eventData: { result: bytes(7000) },
    });

    // Its earlier rows were already scrubbed, so a save now would report
    // what is left as what it wrote.
    expect(savedRows(purged.runId)).toHaveLength(0);
    const usage = await usageOf(purged.runId);
    expect(usage.dataWritten.source).toBe('left-after-purge');
    const left = db.get<{ bytes: number }>(
      `SELECT SUM(${PAYLOAD_BYTES_SQL}) AS bytes FROM events WHERE run_id = ?`,
      purged.runId
    );
    expect(usage.dataWritten.bytes).toBe(Number(left?.bytes));
  });

  describe('deleted on demand (runs.deleteDataMany)', () => {
    const deleteData = (runId: string) =>
      storage.runs.deleteDataMany!({ runIds: [runId] });

    it('saves what a kept run wrote before deleting it, and says it was deleted', async () => {
      const kept = await startRun(false);
      await writeAndFinish(kept);
      const before = await usageOf(kept.runId);
      expect(before.dataPurged).toBe(false);

      const result = await deleteData(kept.runId);
      expect(result.results[0].outcome).toBe('deleted');
      const after = await usageOf(kept.runId);
      expect(after.dataPurged).toBe(true);
      expect(after.dataWritten).toEqual({
        ...before.dataWritten,
        source: 'saved-at-purge',
      });
      expect(after.events).toBe(before.events);
      // True for a deletion on demand: nothing about when it finished.
      expect(formatDataPurgedNote(after)).toBe(
        "This run's data was deleted; sizes show what it wrote."
      );

      // Deleting it again changes nothing.
      expect((await deleteData(kept.runId)).results[0].outcome).toBe(
        'already_deleted'
      );
      expect((await usageOf(kept.runId)).dataWritten).toEqual(
        after.dataWritten
      );
      expect(savedRows(kept.runId)).toHaveLength(1);
    });

    it('does not save the scrubbed rows of a run deleted before sizes were saved', async () => {
      const purged = await startRun(true);
      await writeAndFinish(purged);
      // A purge by a world-local that did not save sizes.
      const db = databaseFor(dataDir);
      db.run('DELETE FROM run_usage_purged WHERE run_id = ?', purged.runId);

      expect((await deleteData(purged.runId)).results[0].outcome).toBe(
        'already_deleted'
      );
      expect(savedRows(purged.runId)).toHaveLength(0);
      const usage = await usageOf(purged.runId);
      expect(usage.dataWritten.source).toBe('left-after-purge');
      expect(formatDataPurgedNote(usage)).toBe(
        "This run's data was deleted before its sizes were kept; sizes show what is left."
      );
    });

    it('counts a late step write on a run deleted on demand in full', async () => {
      const finishLate = async (purge: boolean) => {
        const run = await startRun(false, SPEC_VERSION_SINGLE_ORCHESTRATOR);
        await writeAndFinish(run, { leaveStepRunning: 'step_late' });
        if (purge) await deleteData(run.runId);
        await run.event({
          eventType: 'step_completed',
          correlationId: 'step_late',
          eventData: { result: bytes(7000) },
        });
        return usageOf(run.runId);
      };
      const kept = await finishLate(false);
      const deleted = await finishLate(true);
      expect(deleted.dataWritten).toEqual({
        ...kept.dataWritten,
        source: 'saved-at-purge',
      });
    });
  });

  it('falls back to what is left for a run purged before sizes were saved', async () => {
    const purged = await startRun(true);
    await writeAndFinish(purged);
    // A purge by a world-local that did not save sizes.
    databaseFor(dataDir).run(
      'DELETE FROM run_usage_purged WHERE run_id = ?',
      purged.runId
    );

    const usage = await usageOf(purged.runId);
    expect(usage.dataPurged).toBe(true);
    expect(usage.dataWritten.source).toBe('left-after-purge');
    const left = databaseFor(dataDir).get<{ bytes: number }>(
      `SELECT SUM(${PAYLOAD_BYTES_SQL}) AS bytes FROM events WHERE run_id = ?`,
      purged.runId
    );
    expect(usage.dataWritten.bytes).toBe(Number(left?.bytes));
    expect(usage.dataWritten.byEntity.stream).toBe(0);
  });

  it('saves nothing for a run that keeps its data, and reports its rows as before', async () => {
    const kept = await startRun(false);
    await writeAndFinish(kept);

    const db = databaseFor(dataDir);
    // No purge ran, so the table was never created.
    expect(
      db.get(
        "SELECT 1 AS one FROM sqlite_master WHERE name = 'run_usage_purged'"
      )
    ).toBeUndefined();
    const usage = await usageOf(kept.runId);
    const rows = db.get<{ bytes: number }>(
      `SELECT SUM(${PAYLOAD_BYTES_SQL}) AS bytes FROM events WHERE run_id = ?`,
      kept.runId
    );
    expect(usage).toMatchObject({ dataPurged: false });
    expect(usage.dataWritten.source).toBe('log');
    expect(usage.dataWritten.bytes).toBe(Number(rows?.bytes) + 2500);
  });

  it('keeps one saved row per run, written in the purge transaction', async () => {
    const purged = await startRun(true);
    await writeAndFinish(purged);
    expect(savedRows(purged.runId)).toHaveLength(1);
    // A cancel of the finished run is a no-op and saves nothing new.
    await expect(
      purged.event({ eventType: 'run_cancelled' })
    ).rejects.toThrow();
    expect(savedRows(purged.runId)).toHaveLength(1);
  });

  it('leaves the schema version alone, so an older world-local still opens the database', async () => {
    const purged = await startRun(true);
    await writeAndFinish(purged);
    expect(databaseFor(dataDir).get('PRAGMA user_version')).toEqual({
      user_version: SCHEMA_VERSION,
    });
  });

  it('is cleared with its runs', async () => {
    const world = createWorld({ dataDir, tag: 'tenant-a' });
    try {
      storage = createStorage(dataDir, 'tenant-a');
      const purged = await startRun(true);
      await writeAndFinish(purged);
      expect(savedRows(purged.runId)).toHaveLength(1);
      await world.clear?.();
      expect(savedRows(purged.runId)).toHaveLength(0);
    } finally {
      await world.close?.();
    }
  });
});
