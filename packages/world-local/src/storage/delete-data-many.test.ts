import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SPEC_VERSION_CURRENT,
  type Storage,
  type Streamer,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFor } from '../db/index.js';
import { createStorage } from '../storage.js';
import { createStreamer } from '../streamer.js';
import { createStep, updateStep } from '../test-helpers.js';

describe('runs.deleteDataMany (world-local)', () => {
  let testDir: string;
  let storage: Storage;
  let streamer: Streamer;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-data-test-'));
    storage = createStorage(testDir);
    streamer = createStreamer(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const RUN_INPUT = new Uint8Array([1, 2, 3]);
  const RUN_OUTPUT = new Uint8Array([4, 5, 6]);
  const STEP_INPUT = new Uint8Array([7, 7, 7]);
  const STEP_OUTPUT = new Uint8Array([8, 8, 8]);

  /** A running run with one completed step and one closed stream. */
  async function startRun(): Promise<WorkflowRun> {
    const created = await storage.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'delete-data-workflow',
        input: RUN_INPUT,
      },
    });
    const run = created.run;
    if (!run) throw new Error('Expected run to be created');
    await storage.events.create(run.runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as never);
    await createStep(storage, run.runId, {
      stepId: 'step_001',
      stepName: 'step//./mod//doWork',
      input: STEP_INPUT,
    });
    await updateStep(storage, run.runId, 'step_001', 'step_completed', {
      result: STEP_OUTPUT,
    });
    await streamer.streams.write(run.runId, 'stream-a', 'secret payload');
    await streamer.streams.close(run.runId, 'stream-a');
    return run;
  }

  async function finishedRun(): Promise<WorkflowRun> {
    const run = await startRun();
    await storage.events.create(run.runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: RUN_OUTPUT },
    });
    return run;
  }

  /** Every payload field the run's log still holds. */
  async function eventPayloads(runId: string): Promise<unknown[]> {
    const { data } = await storage.events.list({ runId, pagination: {} });
    return data.flatMap((event) => {
      const eventData = (event as { eventData?: Record<string, unknown> })
        .eventData;
      if (!eventData) return [];
      return ['input', 'output', 'result', 'error', 'payload']
        .filter((field) => eventData[field] !== undefined)
        .map((field) => eventData[field]);
    });
  }

  it("deletes a finished run's data, keeping the run, its steps and its events listed", async () => {
    const run = await finishedRun();
    expect(await eventPayloads(run.runId)).not.toEqual([]);
    const before = Date.now();

    const result = await storage.runs.deleteDataMany?.({
      runIds: [run.runId],
    });

    expect(result).toEqual({
      summary: {
        requested: 1,
        deleted: 1,
        alreadyDeleted: 0,
        skipped: 0,
        notCreated: 0,
        notFound: 0,
        failed: 0,
      },
      results: [{ runId: run.runId, outcome: 'deleted' }],
    });

    const persisted = await storage.runs.get(run.runId);
    expect(persisted.status).toBe('completed');
    expect(persisted.input).toBeUndefined();
    expect(persisted.output).toBeUndefined();
    expect(persisted.expiredAt?.getTime()).toBeGreaterThanOrEqual(before);

    const steps = await storage.steps.list({ runId: run.runId });
    expect(steps.data).toHaveLength(1);
    expect(steps.data[0].input).toBeUndefined();
    expect(steps.data[0].output).toBeUndefined();

    expect(await eventPayloads(run.runId)).toEqual([]);

    expect(await streamer.streams.list(run.runId)).toEqual(['stream-a']);
    const chunks = await streamer.streams.getChunks(run.runId, 'stream-a');
    expect(chunks.data).toEqual([]);
    expect(chunks.done).toBe(true);
  });

  it.each([
    'run_completed',
    'run_cancelled',
  ] as const)('does not expose the original writer cache after another instance writes %s and deletes data', async (eventType) => {
    const run = await startRun();
    const other = createStorage(testDir);
    const before = await storage.events.listByCorrelationId({
      runId: run.runId,
      correlationId: 'step_001',
    });
    expect(before.data).toHaveLength(2);
    expect(await eventPayloads(run.runId)).not.toEqual([]);

    await other.events.create(run.runId, {
      eventType,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: eventType === 'run_completed' ? { output: RUN_OUTPUT } : {},
    });
    const deleted = await other.runs.deleteDataMany?.({ runIds: [run.runId] });
    expect(deleted?.results[0].outcome).toBe('deleted');

    // Exercise the correlation reader first: a general listing must not be
    // needed to invalidate this instance's cached step input and result.
    for (let attempt = 0; attempt < 2; attempt++) {
      const after = await storage.events.listByCorrelationId({
        runId: run.runId,
        correlationId: 'step_001',
      });
      expect(after.data).toHaveLength(2);
      expect(after.data[0].eventData).not.toHaveProperty('input', STEP_INPUT);
      expect(after.data[1].eventData).not.toHaveProperty('result', STEP_OUTPUT);
      expect(await eventPayloads(run.runId)).toEqual([]);
    }
  });

  it('answers already_deleted on a second call, keeping the first expiredAt', async () => {
    const run = await finishedRun();
    await storage.runs.deleteDataMany?.({ runIds: [run.runId] });
    const { expiredAt } = await storage.runs.get(run.runId);

    const again = await storage.runs.deleteDataMany?.({
      runIds: [run.runId],
    });

    expect(again?.results).toEqual([
      { runId: run.runId, outcome: 'already_deleted' },
    ]);
    expect(again?.summary.alreadyDeleted).toBe(1);
    expect((await storage.runs.get(run.runId)).expiredAt).toEqual(expiredAt);
  });

  it('skips a run that has not finished, leaving it running with its data', async () => {
    const run = await startRun();

    const result = await storage.runs.deleteDataMany?.({
      runIds: [run.runId],
    });

    expect(result?.results).toEqual([
      {
        runId: run.runId,
        outcome: 'skipped',
        reason: 'run_not_terminal',
        status: 'running',
      },
    ]);
    const persisted = await storage.runs.get(run.runId);
    expect(persisted.status).toBe('running');
    expect(persisted.input).toEqual(RUN_INPUT);
    expect(persisted.expiredAt).toBeUndefined();
    const steps = await storage.steps.list({ runId: run.runId });
    expect(steps.data[0].output).toEqual(STEP_OUTPUT);
  });

  it('answers every run in request order, with not_found for unknown IDs', async () => {
    const finished = await finishedRun();
    const running = await startRun();

    const result = await storage.runs.deleteDataMany?.({
      runIds: ['wrun_missing', running.runId, finished.runId, '../escape'],
    });

    expect(result?.results.map((r) => [r.runId, r.outcome])).toEqual([
      ['wrun_missing', 'not_found'],
      [running.runId, 'skipped'],
      [finished.runId, 'deleted'],
      ['../escape', 'not_found'],
    ]);
    expect(result?.summary).toEqual({
      requested: 4,
      deleted: 1,
      alreadyDeleted: 0,
      skipped: 1,
      notCreated: 0,
      notFound: 2,
      failed: 0,
    });
  });

  it('answers a retryable failure, deleting nothing, when a payload cannot be scrubbed, and a retry finishes the job', async () => {
    const run = await finishedRun();
    const db = databaseFor(testDir);
    const { doc } = db.get<{ doc: string }>(
      'SELECT doc FROM steps WHERE run_id = ?',
      run.runId
    ) as { doc: string };
    db.run(
      'UPDATE steps SET doc = ? WHERE run_id = ?',
      '{ not json',
      run.runId
    );

    const first = await storage.runs.deleteDataMany?.({ runIds: [run.runId] });
    expect(first?.results).toEqual([
      {
        runId: run.runId,
        outcome: 'failed',
        code: 'internal_error',
        retryable: true,
      },
    ]);
    expect(first?.summary.failed).toBe(1);
    // One transaction: the run itself was not marked deleted either.
    const untouched = await storage.runs.get(run.runId);
    expect(untouched.expiredAt).toBeUndefined();
    expect(untouched.output).toEqual(RUN_OUTPUT);

    db.run('UPDATE steps SET doc = ? WHERE run_id = ?', doc, run.runId);
    const retry = await storage.runs.deleteDataMany?.({ runIds: [run.runId] });
    expect(retry?.results).toEqual([{ runId: run.runId, outcome: 'deleted' }]);
    const steps = await storage.steps.list({ runId: run.runId });
    expect(steps.data[0].output).toBeUndefined();
    expect((await storage.runs.get(run.runId)).output).toBeUndefined();
  });

  it('rejects an empty, duplicated or oversized request', async () => {
    for (const runIds of [
      [],
      ['wrun_a', 'wrun_a'],
      Array.from({ length: 101 }, (_, i) => `wrun_${i}`),
    ]) {
      await expect(storage.runs.deleteDataMany?.({ runIds })).rejects.toThrow();
    }
  });
});
