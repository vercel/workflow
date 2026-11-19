import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  RETENTION_ATTRIBUTE,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type SpecVersion,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, databaseFor } from '../db/index.js';
import { createStorage, type LocalStorage } from '../storage/index.js';
import { createStreamer } from '../streamer.js';
import { createRun } from '../test-helpers.js';
import {
  createUsageStorage,
  type UsageStorageOptions,
} from './usage-storage.js';

let dataDir: string;
let storage: LocalStorage;
let db: Database;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS', '1');
  dataDir = mkdtempSync(path.join(tmpdir(), 'usage-cache-'));
  storage = createStorage(dataDir);
  db = databaseFor(dataDir);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const NAMES = ['a', 'b', 'c', 'd'].map(
  (n) => `step//./src/workflows/order//${n}`
);

/** Tiny batches, so the first count runs as many batches with yields. */
const tinyBatches: UsageStorageOptions = {
  initialBatchRows: 1,
  batchTargetMs: 0.000_001,
};

/** A full recount: a usage reader with nothing remembered. */
const recount = (runId: string) => createUsageStorage(db).getRun(runId);

async function startRun(
  opts: { purge?: boolean; specVersion?: SpecVersion } = {}
) {
  const specVersion = opts.specVersion ?? SPEC_VERSION_CURRENT;
  const run = await createRun(
    storage,
    {
      deploymentId: 'dpl_test',
      workflowName: 'workflow//./src/workflows/order//processOrder',
      input: bytes(2000),
      ...(opts.purge && {
        attributes: { [RETENTION_ATTRIBUTE]: '0' },
        allowReservedAttributes: true,
      }),
    } as never,
    specVersion
  );
  const runId = run.runId;
  const event = (e: Record<string, unknown>) =>
    storage.events.create(runId, { specVersion, ...e } as never);
  await event({ eventType: 'run_started' });
  return { runId, event };
}

/** The i-th of a varied sequence of writes. */
async function writeSome(
  { runId, event }: Awaited<ReturnType<typeof startRun>>,
  i: number,
  inline = false
) {
  const stepId = `step_${i}`;
  const name = NAMES[i % NAMES.length];
  if (inline) {
    await event({
      eventType: 'step_started',
      correlationId: stepId,
      eventData: { stepName: name, input: bytes(100 + i) },
    });
  } else {
    await event({
      eventType: 'step_created',
      correlationId: stepId,
      eventData: { stepName: name, input: bytes(100 + i) },
    });
    await event({ eventType: 'step_started', correlationId: stepId });
  }
  if (i % 3 === 0) {
    await event({
      eventType: 'step_retrying',
      correlationId: stepId,
      eventData: { error: bytes(50) },
    });
    await event({ eventType: 'step_started', correlationId: stepId });
  }
  await event(
    i % 7 === 6
      ? {
          eventType: 'step_failed',
          correlationId: stepId,
          eventData: { error: bytes(60) },
        }
      : {
          eventType: 'step_completed',
          correlationId: stepId,
          eventData: { result: bytes(300 + i) },
        }
  );
  if (i % 4 === 1) {
    const hookId = `hook_${i}`;
    await event({
      eventType: 'hook_created',
      correlationId: hookId,
      eventData: { token: `token-${runId}-${i}`, metadata: bytes(20) },
    });
    await event({
      eventType: 'hook_received',
      correlationId: hookId,
      eventData: { payload: bytes(40 + i) },
    });
  }
  if (i % 5 === 2) {
    await event({
      eventType: 'wait_created',
      correlationId: `wait_${i}`,
      eventData: { resumeAt: new Date(Date.now() + 1000) },
    });
    await event({ eventType: 'wait_completed', correlationId: `wait_${i}` });
  }
  if (i % 6 === 3) {
    await createStreamer(dataDir).streams.write(
      runId,
      `strm_${runId}`,
      bytes(500 + i)
    );
  }
}

describe('remembered usage counts', () => {
  it('equal a full recount after every write of a long run', async () => {
    const run = await startRun();
    const cached = createUsageStorage(db, undefined, tinyBatches);
    for (let i = 0; i < 40; i++) {
      await writeSome(run, i);
      expect(await cached.getRun(run.runId)).toEqual(await recount(run.runId));
    }
    await run.event({
      eventType: 'run_completed',
      eventData: { output: bytes(10) },
    });
    const final = await cached.getRun(run.runId);
    expect(final).toEqual(await recount(run.runId));
    // And the events agree with the log read the slow way.
    const listed = await storage.events.list({
      runId: run.runId,
      pagination: { limit: 1000 },
      resolveData: 'none',
    });
    expect(final.events).toBe(listed.data.length);
  });

  it('equal a full recount on a spec 9 run with inline steps', async () => {
    const run = await startRun({
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    const cached = createUsageStorage(db, undefined, tinyBatches);
    for (let i = 0; i < 20; i++) {
      await writeSome(run, i, i % 2 === 0);
      expect(await cached.getRun(run.runId)).toEqual(await recount(run.runId));
    }
  });

  it('equal a full recount across a zero-retention purge and a late write', async () => {
    const run = await startRun({
      purge: true,
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    const recounted: string[] = [];
    const cached = createUsageStorage(db, undefined, {
      ...tinyBatches,
      onRecount: (runId) => recounted.push(runId),
    });
    for (let i = 0; i < 10; i++) {
      await writeSome(run, i);
      expect(await cached.getRun(run.runId)).toEqual(await recount(run.runId));
    }
    // A step still running when the run finishes and its data is deleted.
    await run.event({
      eventType: 'step_started',
      correlationId: 'step_late',
      eventData: { stepName: NAMES[0], input: bytes(900) },
    });
    expect(await cached.getRun(run.runId)).toEqual(await recount(run.runId));
    await run.event({
      eventType: 'run_completed',
      eventData: { output: bytes(10) },
    });
    expect(recounted).toEqual([]);
    const purged = await cached.getRun(run.runId);
    // Its counts were taken while it ran, before the purge: taken again.
    expect(recounted).toEqual([run.runId]);
    expect(purged.dataWritten.source).toBe('saved-at-purge');
    expect(purged).toEqual(await recount(run.runId));
    await run.event({
      eventType: 'step_completed',
      correlationId: 'step_late',
      eventData: { result: bytes(4000) },
    });
    expect(await cached.getRun(run.runId)).toEqual(await recount(run.runId));
  });

  it('equal a full recount when a purge without saved sizes lands mid-count', async () => {
    // A run purged by a world-local that did not save sizes, while this one
    // is counting it: the counts taken before the purge are taken again.
    const run = await startRun({ purge: true });
    for (let i = 0; i < 10; i++) await writeSome(run, i);
    let purgedOnce = false;
    const recounted: string[] = [];
    const cached = createUsageStorage(db, undefined, {
      ...tinyBatches,
      onRecount: (runId) => recounted.push(runId),
      onBatch: async () => {
        if (purgedOnce) return;
        purgedOnce = true;
        await run.event({
          eventType: 'run_completed',
          eventData: { output: bytes(10) },
        });
        db.run('DELETE FROM run_usage_purged WHERE run_id = ?', run.runId);
      },
    });
    const usage = await cached.getRun(run.runId);
    expect(purgedOnce).toBe(true);
    // It was running when the read began, so its batches read rows the
    // purge then rewrote: counted again.
    expect(recounted).toEqual([run.runId]);
    expect(usage.dataWritten.source).toBe('left-after-purge');
    expect(usage).toEqual(await recount(run.runId));
  });

  it('count a run that had finished with its data deleted once, not twice', async () => {
    const run = await startRun({ purge: true });
    for (let i = 0; i < 10; i++) await writeSome(run, i);
    await run.event({
      eventType: 'run_completed',
      eventData: { output: bytes(10) },
    });
    const recounted: string[] = [];
    let batches = 0;
    const cold = createUsageStorage(db, undefined, {
      ...tinyBatches,
      onRecount: (runId) => recounted.push(runId),
      onBatch: () => {
        batches += 1;
      },
    });
    // Every pass over the run's rows from the start of its log.
    const all = db.all.bind(db);
    const fromStart: unknown[] = [];
    const spy = vi.spyOn(db, 'all').mockImplementation(((
      sql: string,
      ...params: unknown[]
    ) => {
      if (sql.includes('GROUP BY event_type') && params[1] === 0) {
        fromStart.push(params);
      }
      return all(sql, ...(params as never[]));
    }) as typeof db.all);
    let usage: Awaited<ReturnType<typeof cold.getRun>>;
    try {
      usage = await cold.getRun(run.runId);
    } finally {
      spy.mockRestore();
    }
    // Counted in batches, and not again in one block.
    expect(batches).toBeGreaterThan(1);
    expect(fromStart).toHaveLength(1);
    expect(recounted).toEqual([]);
    expect(usage.dataWritten.source).toBe('saved-at-purge');
    expect(usage).toEqual(await recount(run.runId));
  });

  it('equal a full recount when a deletion on demand lands mid-count', async () => {
    const run = await startRun();
    for (let i = 0; i < 10; i++) await writeSome(run, i);
    await run.event({
      eventType: 'run_completed',
      eventData: { output: bytes(10) },
    });
    let deleted = false;
    const cached = createUsageStorage(db, undefined, {
      ...tinyBatches,
      onBatch: async () => {
        if (deleted) return;
        deleted = true;
        await storage.runs.deleteDataMany!({ runIds: [run.runId] });
      },
    });
    const usage = await cached.getRun(run.runId);
    expect(deleted).toBe(true);
    expect(usage.dataWritten.source).toBe('saved-at-purge');
    expect(usage).toEqual(await recount(run.runId));
  });

  it('take writes that land between batches of the first count into the result', async () => {
    const run = await startRun();
    for (let i = 0; i < 12; i++) await writeSome(run, i);
    let extra = 100;
    const cached = createUsageStorage(db, undefined, {
      ...tinyBatches,
      onBatch: async () => {
        if (extra < 104) await writeSome(run, extra++);
      },
    });
    const usage = await cached.getRun(run.runId);
    expect(extra).toBe(104);
    // One consistent view: every row up to the run's position, once.
    expect(usage).toEqual(await recount(run.runId));
  });

  it('count a run once when reads of it overlap', async () => {
    const run = await startRun();
    for (let i = 0; i < 12; i++) await writeSome(run, i);
    const batchesOf = async (reads: number) => {
      let batches = 0;
      const reader = createUsageStorage(db, undefined, {
        ...tinyBatches,
        onBatch: () => {
          batches++;
        },
      });
      const results = await Promise.all(
        Array.from({ length: reads }, () => reader.getRun(run.runId))
      );
      return { batches, results };
    };
    const one = await batchesOf(1);
    const five = await batchesOf(5);
    expect(one.batches).toBeGreaterThan(5);
    // The overlapping reads wait for the first count instead of each
    // counting the whole run (each count blocks the process).
    expect(five.batches).toBe(one.batches);
    const truth = await recount(run.runId);
    for (const usage of five.results) expect(usage).toEqual(truth);
  });

  it('count every write once when overlapping reads race the writer', async () => {
    const run = await startRun();
    for (let i = 0; i < 12; i++) await writeSome(run, i);
    let extra = 200;
    const reader = createUsageStorage(db, undefined, {
      ...tinyBatches,
      onBatch: async () => {
        if (extra < 203) await writeSome(run, extra++);
      },
    });
    const reads = await Promise.all(
      Array.from({ length: 5 }, () => reader.getRun(run.runId))
    );
    const truth = await recount(run.runId);
    expect(reads.at(-1)).toEqual(truth);
    for (const usage of reads) {
      expect(usage.events).toBeLessThanOrEqual(truth.events);
    }
  });

  it('read nothing again for a run that has not written since', async () => {
    const run = await startRun();
    for (let i = 0; i < 8; i++) await writeSome(run, i);
    const cached = createUsageStorage(db, undefined, tinyBatches);
    const first = await cached.getRun(run.runId);
    const all = vi.spyOn(db, 'all');
    const second = await cached.getRun(run.runId);
    const rowReads = all.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM events')
    );
    all.mockRestore();
    expect(second).toEqual(first);
    expect(rowReads).toHaveLength(0);
  });

  it('read only the new rows of a run that wrote since', async () => {
    const run = await startRun();
    for (let i = 0; i < 8; i++) await writeSome(run, i);
    const cached = createUsageStorage(db, undefined, tinyBatches);
    await cached.getRun(run.runId);
    const positions = db.get<{ seq: number }>(
      'SELECT seq FROM runs WHERE run_id = ?',
      run.runId
    );
    await writeSome(run, 8);
    const all = vi.spyOn(db, 'all');
    await cached.getRun(run.runId);
    const ranges = all.mock.calls
      .filter(([sql]) => String(sql).includes('seq > ?2 AND seq <= ?3'))
      .map((call) => call[2]);
    all.mockRestore();
    // The reads start where the last count stopped, and never before it.
    expect(ranges[0]).toBe(Number(positions?.seq));
    for (const from of ranges) {
      expect(Number(from)).toBeGreaterThanOrEqual(Number(positions?.seq));
    }
  });

  it('forget the least recently read runs past the limit', async () => {
    const runs = [await startRun(), await startRun(), await startRun()];
    for (const run of runs) await writeSome(run, 0);
    let batches = 0;
    const cached = createUsageStorage(db, undefined, {
      ...tinyBatches,
      maxRuns: 2,
      onBatch: () => {
        batches++;
      },
    });
    for (const run of runs) await cached.getRun(run.runId);
    batches = 0;
    // The first run was dropped: it is counted again, the last one is not.
    await cached.getRun(runs[2].runId);
    expect(batches).toBe(0);
    await cached.getRun(runs[0].runId);
    expect(batches).toBeGreaterThan(0);
    expect(await cached.getRun(runs[0].runId)).toEqual(
      await recount(runs[0].runId)
    );
  });

  it('forget a run that is gone', async () => {
    const tagged = createStorage(dataDir, 'tenant-a');
    const run = await createRun(tagged, {
      deploymentId: 'dpl_test',
      workflowName: 'workflow//./src/w//wf',
      input: bytes(10),
    });
    const cached = createUsageStorage(db, 'tenant-a');
    await expect(cached.getRun(run.runId)).resolves.toMatchObject({
      events: 1,
    });
    db.run('DELETE FROM events WHERE run_id = ?', run.runId);
    db.run('DELETE FROM runs WHERE run_id = ?', run.runId);
    await expect(cached.getRun(run.runId)).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError
    );
  });

  it('sizes each run’s batches from its own rows, not the run read before it', async () => {
    // A run of many small rows grows the batch to thousands of rows. A run
    // of large rows read next by the same World must not inherit that size,
    // or its whole first count runs as one synchronous block.
    const small = await startRun();
    for (let i = 0; i < 400; i++) {
      await small.event({
        eventType: 'step_created',
        correlationId: `step_s${i}`,
        eventData: { stepName: NAMES[0], input: bytes(8) },
      });
      await small.event({
        eventType: 'step_started',
        correlationId: `step_s${i}`,
      });
      await small.event({
        eventType: 'step_completed',
        correlationId: `step_s${i}`,
        eventData: { result: bytes(8) },
      });
    }
    const large = await startRun();
    for (let i = 0; i < 30; i++) {
      await large.event({
        eventType: 'step_created',
        correlationId: `step_l${i}`,
        eventData: { stepName: NAMES[1], input: bytes(300_000) },
      });
      await large.event({
        eventType: 'step_started',
        correlationId: `step_l${i}`,
      });
      await large.event({
        eventType: 'step_completed',
        correlationId: `step_l${i}`,
        eventData: { result: bytes(300_000) },
      });
    }
    const yields: Record<string, number[]> = {};
    const reader = createUsageStorage(db, undefined, {
      onBatch: (runId, countedSeq) => {
        yields[runId] = [...(yields[runId] ?? []), countedSeq];
      },
    });
    await reader.getRun(small.runId);
    // The small run's batches did grow well past the first size.
    const smallYields = yields[small.runId] ?? [];
    const smallSizes = smallYields.map(
      (seq, i) => seq - (smallYields[i - 1] ?? 0)
    );
    expect(Math.max(...smallSizes)).toBeGreaterThan(64);

    const usage = await reader.getRun(large.runId);
    const largeYields = yields[large.runId] ?? [];
    // It yields, and its first batch is the first size, not the small run's.
    expect(largeYields.length).toBeGreaterThan(1);
    expect(largeYields[0]).toBeLessThanOrEqual(4);
    expect(usage).toEqual(await recount(large.runId));
  });

  it('is what the World uses', async () => {
    const run = await startRun();
    await writeSome(run, 0);
    expect(await storage.experimental_usage!.getRun(run.runId)).toEqual(
      await recount(run.runId)
    );
  });
});
