import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  formatRunUsageSummary,
  formatStepCreationNote,
  formatStepEventsBreakdown,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseFor } from '../db/index.js';
import { createWorld } from '../index.js';
import { createStorage, type LocalStorage } from '../storage/index.js';
import { createStreamer } from '../streamer.js';
import {
  createHook,
  createRun,
  createStep,
  disposeHook,
  updateRun,
  updateStep,
} from '../test-helpers.js';

let dataDir: string;
let storage: LocalStorage;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS', '1');
  dataDir = mkdtempSync(path.join(tmpdir(), 'usage-storage-'));
  storage = createStorage(dataDir);
});

afterEach(() => {
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const WORKFLOW = 'workflow//./src/workflows/order//processOrder';
const CHARGE = 'step//./src/workflows/order//chargeCard';
const EMAIL = 'step//./src/workflows/order//sendEmail';

const bytes = (n: number) => new Uint8Array(n).fill(7);

async function startRun(input = bytes(16)) {
  const run = await createRun(storage, {
    deploymentId: 'dpl_test',
    workflowName: WORKFLOW,
    input,
  });
  await updateRun(storage, run.runId, 'run_started');
  return run.runId;
}

/** A step that succeeds first time: created, started, completed. */
async function runStep(runId: string, stepId: string, stepName: string) {
  await createStep(storage, runId, { stepId, stepName, input: bytes(8) });
  await updateStep(storage, runId, stepId, 'step_started');
  await updateStep(storage, runId, stepId, 'step_completed', {
    result: bytes(8),
  });
}

/** Every event of the run, read page by page through the public listing. */
async function listAllEvents(runId: string) {
  const all = [];
  let cursor: string | undefined;
  do {
    const page = await storage.events.list({
      runId,
      pagination: { limit: 200, cursor },
      resolveData: 'none',
    });
    all.push(...page.data);
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

const usageOf = (runId: string) => storage.experimental_usage!.getRun(runId);

describe('experimental_usage.getRun (world-local)', () => {
  it('counts a simple run: 3 run events and 3 per step', async () => {
    const runId = await startRun();
    await runStep(runId, 'step_1', CHARGE);
    await updateRun(storage, runId, 'run_completed', { output: bytes(4) });

    const usage = await usageOf(runId);

    expect(usage).toMatchObject({
      runId,
      status: 'completed',
      inProgress: false,
      events: 6,
      billableEvents: 6,
      retries: { count: 0, events: 0 },
      dataRetained: null,
    });
    // A tie is broken by name.
    expect(usage.eventsBySpan).toEqual([
      { kind: 'step', name: CHARGE, events: 3, share: 0.5, retries: 0 },
      { kind: 'run', name: WORKFLOW, events: 3, share: 0.5, retries: 0 },
    ]);
    expect(usage.dataWritten.byEntity.run).toBeGreaterThan(0);
    expect(usage.dataWritten.byEntity.step).toBeGreaterThan(0);
    expect(usage.dataWritten.byEntity.hook).toBe(0);
    expect(usage.dataWritten.byEntity.stream).toBe(0);
    expect(usage.stepEvents).toEqual({
      steps: 1,
      events: 3,
      byType: {
        created: 1,
        started: 1,
        completed: 1,
        failed: 0,
        retrying: 0,
        other: 0,
      },
    });
    expect(formatRunUsageSummary(usage)).toBe('6 billable events · 0 retries');
  });

  it('counts one retry as two extra events on its step', async () => {
    const runId = await startRun();
    await createStep(storage, runId, {
      stepId: 'step_1',
      stepName: CHARGE,
      input: bytes(8),
    });
    await updateStep(storage, runId, 'step_1', 'step_started');
    await updateStep(storage, runId, 'step_1', 'step_retrying', {
      error: bytes(8),
    });
    await updateStep(storage, runId, 'step_1', 'step_started');
    await updateStep(storage, runId, 'step_1', 'step_completed', {
      result: bytes(8),
    });
    await updateRun(storage, runId, 'run_completed', { output: bytes(4) });

    const usage = await usageOf(runId);

    // 3 for the run, 3 for the step, +2 for its retry.
    expect(usage.events).toBe(8);
    expect(usage.retries).toEqual({ count: 1, events: 2 });
    expect(usage.eventsBySpan[0]).toMatchObject({
      kind: 'step',
      name: CHARGE,
      events: 5,
      retries: 1,
    });
    expect(usage.stepEvents.byType).toMatchObject({
      created: 1,
      started: 2,
      completed: 1,
      retrying: 1,
    });
    expect(formatRunUsageSummary(usage)).toBe(
      '8 billable events · 1 retry (+2 events)'
    );
  });

  it('counts the whole log of a run past the first page of 200 events', async () => {
    const runId = await startRun();
    for (let i = 0; i < 150; i++) {
      await runStep(runId, `step_c${i}`, CHARGE);
    }
    for (let i = 0; i < 20; i++) {
      await runStep(runId, `step_e${i}`, EMAIL);
    }

    const usage = await usageOf(runId);
    const listed = await listAllEvents(runId);

    expect(listed.length).toBe(2 + 170 * 3);
    expect(usage.events).toBe(listed.length);
    expect(usage.events).toBeGreaterThan(200);
    // One span per step name, however many times the step ran.
    expect(usage.eventsBySpan.map((span) => [span.name, span.events])).toEqual([
      [CHARGE, 450],
      [EMAIL, 60],
      [WORKFLOW, 2],
    ]);
    expect(usage.eventsBySpan[0].share).toBeCloseTo(450 / 512);
    expect(usage.inProgress).toBe(true);
  });

  it('reports hook and stream data written by entity', async () => {
    const runId = await startRun();
    await createHook(storage, runId, {
      hookId: 'hook_1',
      token: 'approval-token',
      metadata: bytes(32),
    });
    await storage.events.create(runId, {
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook_1',
      eventData: { payload: bytes(64) },
    });
    await disposeHook(storage, runId, 'hook_1');
    const streamer = createStreamer(dataDir);
    await streamer.streams.write(runId, 'strm_out', bytes(1000));
    await streamer.streams.write(runId, 'strm_out', bytes(500));
    await streamer.streams.close(runId, 'strm_out');
    // Another run's stream is not this run's data.
    await streamer.streams.write('wrun_other', 'strm_x', bytes(999));

    const usage = await usageOf(runId);
    const { byEntity } = usage.dataWritten;

    expect(usage.eventsBySpan).toContainEqual({
      kind: 'hook',
      name: 'hook',
      events: 3,
      share: 3 / 5,
      retries: 0,
    });
    expect(byEntity.stream).toBe(1500);
    // The hook's payloads are stored base64-encoded inside its events.
    expect(byEntity.hook).toBeGreaterThan(Math.ceil((96 * 4) / 3));
    expect(byEntity.step).toBe(0);
    expect(usage.dataWritten.bytes).toBe(
      byEntity.run + byEntity.step + byEntity.hook + byEntity.stream
    );
  });

  it('counts a failed run, its exhausted retries included', async () => {
    const runId = await startRun();
    await createStep(storage, runId, {
      stepId: 'step_1',
      stepName: CHARGE,
      input: bytes(8),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await updateStep(storage, runId, 'step_1', 'step_started');
      await updateStep(storage, runId, 'step_1', 'step_retrying', {
        error: bytes(8),
      });
    }
    await updateStep(storage, runId, 'step_1', 'step_started');
    await updateStep(storage, runId, 'step_1', 'step_failed', {
      error: bytes(8),
    });
    await updateRun(storage, runId, 'run_failed', { error: bytes(8) });

    const usage = await usageOf(runId);

    expect(usage.status).toBe('failed');
    expect(usage.inProgress).toBe(false);
    // run: created, started, failed. step: created, 3 × started,
    // 2 × retrying, failed.
    expect(usage.events).toBe(3 + 7);
    expect(usage.retries).toEqual({ count: 2, events: 4 });
    expect(usage.stepEvents).toMatchObject({
      steps: 1,
      events: 7,
      byType: { created: 1, started: 3, retrying: 2, failed: 1, completed: 0 },
    });
    expect(formatRunUsageSummary(usage)).toBe(
      '10 billable events · 2 retries (+4 events)'
    );
  });

  it('reads an in-progress run as it grows', async () => {
    const runId = await startRun();
    await createStep(storage, runId, {
      stepId: 'step_1',
      stepName: CHARGE,
      input: bytes(8),
    });
    await updateStep(storage, runId, 'step_1', 'step_started');

    const before = await usageOf(runId);
    expect(before).toMatchObject({
      status: 'running',
      inProgress: true,
      events: 4,
    });

    await updateStep(storage, runId, 'step_1', 'step_completed', {
      result: bytes(8),
    });
    const after = await usageOf(runId);
    expect(after.events).toBe(5);
    expect(after.dataWritten.bytes).toBeGreaterThan(before.dataWritten.bytes);
  });

  it('counts a spec 8 lazy start with the step_created it writes', async () => {
    // Spec 8 records a lazily started inline step's creation as a synthetic
    // step_created, so the log still shows three events.
    const runId = await startRun();
    await storage.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'step_inline',
      eventData: { stepName: EMAIL, input: bytes(8) },
    } as never);
    await updateStep(storage, runId, 'step_inline', 'step_completed', {
      result: bytes(8),
    });

    const usage = await usageOf(runId);
    expect(usage.stepEvents).toMatchObject({
      steps: 1,
      events: 3,
      byType: { created: 1, started: 1, completed: 1 },
    });
  });

  it('counts a spec 9 run that mixes inline and queued steps', async () => {
    // A spec 9 inline step is created by its first step_started: no
    // step_created. A queued step keeps its step_created.
    const run = await createRun(
      storage,
      { deploymentId: 'dpl_test', workflowName: WORKFLOW, input: bytes(4) },
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    const runId = run.runId;
    const event = (e: Record<string, unknown>) =>
      storage.events.create(runId, {
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        ...e,
      } as never);
    for (const id of ['step_i1', 'step_i2']) {
      await event({
        eventType: 'step_started',
        correlationId: id,
        eventData: { stepName: EMAIL, input: bytes(8) },
      });
      await event({
        eventType: 'step_completed',
        correlationId: id,
        eventData: { result: bytes(8) },
      });
    }
    await event({
      eventType: 'step_created',
      correlationId: 'step_q1',
      eventData: { stepName: CHARGE, input: bytes(8) },
    });
    await event({ eventType: 'step_started', correlationId: 'step_q1' });
    await event({
      eventType: 'step_completed',
      correlationId: 'step_q1',
      eventData: { result: bytes(8) },
    });

    const usage = await usageOf(runId);
    const listed = await listAllEvents(runId);
    expect(listed.filter((e) => e.eventType === 'step_created')).toHaveLength(
      1
    );
    expect(usage.stepEvents).toEqual({
      steps: 3,
      events: 7,
      byType: {
        created: 1,
        started: 3,
        completed: 3,
        failed: 0,
        retrying: 0,
        other: 0,
      },
    });
    // The inline steps are named from their rows.
    expect(usage.eventsBySpan).toContainEqual(
      expect.objectContaining({ kind: 'step', name: EMAIL, events: 4 })
    );
    expect(formatStepEventsBreakdown(usage)).toBe(
      '3 steps wrote 7 events: 1 created, 3 started, 3 completed'
    );
    expect(formatStepCreationNote(usage)).toBe(
      '2 steps have no created event: they ran inline, and their first started event created them.'
    );
  });

  it('counts sleeps and attributes', async () => {
    const runId = await startRun();
    await storage.events.create(runId, {
      eventType: 'wait_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'wait_1',
      eventData: { resumeAt: new Date(Date.now() + 1000) },
    });
    await storage.events.create(runId, {
      eventType: 'wait_completed',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'wait_1',
    } as never);

    const usage = await usageOf(runId);
    expect(usage.events).toBe(4);
    expect(usage.eventsBySpan).toContainEqual(
      expect.objectContaining({ kind: 'wait', name: 'sleep', events: 2 })
    );
  });

  it('does not count placeholders in the log as events', async () => {
    const runId = await startRun();
    const db = databaseFor(dataDir);
    db.transact(() => {
      const seq =
        Number(
          db.get<{ seq: number }>(
            'SELECT seq FROM runs WHERE run_id = ?',
            runId
          )?.seq
        ) + 1;
      db.run(
        `INSERT INTO events (run_id, seq, event_type, correlation_id, doc)
         VALUES (?, ?, 'noop', NULL, '{}')`,
        runId,
        seq
      );
      db.run('UPDATE runs SET seq = ? WHERE run_id = ?', seq, runId);
    });

    const usage = await usageOf(runId);
    expect(usage.events).toBe(2);
    expect(usage.billableEvents).toBe(2);
  });

  it('rejects a run it does not see', async () => {
    await expect(usageOf('wrun_missing')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError
    );
    // Without a database file yet, it reads nothing and creates nothing.
    const empty = createStorage(
      mkdtempSync(path.join(tmpdir(), 'usage-empty-'))
    );
    await expect(
      empty.experimental_usage!.getRun('wrun_missing')
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
  });

  it("hides another tag's run, like runs.get", async () => {
    const tagged = createStorage(dataDir, 'tenant-a');
    const run = await createRun(tagged, {
      deploymentId: 'dpl_test',
      workflowName: WORKFLOW,
      input: bytes(4),
    });

    await expect(
      tagged.experimental_usage!.getRun(run.runId)
    ).resolves.toMatchObject({ events: 1 });
    await expect(usageOf(run.runId)).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError
    );
    await expect(storage.runs.get(run.runId)).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError
    );
  });

  it('rejects an unsafe run id before querying', async () => {
    await expect(usageOf('../etc')).rejects.toThrow();
  });

  it('is exposed on the World', async () => {
    const world = createWorld({ dataDir });
    try {
      const runId = await startRun();
      await expect(
        world.experimental_usage!.getRun(runId)
      ).resolves.toMatchObject({ runId, events: 2 });
    } finally {
      await world.close?.();
    }
  });
});
