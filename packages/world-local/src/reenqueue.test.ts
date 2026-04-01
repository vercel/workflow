import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalWorld, type LocalWorld } from './index.js';
import { createRun, updateRun } from './test-helpers.js';

// Mock node:timers/promises so the queue's setTimeout resolves immediately
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

describe('re-enqueue active runs on start', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = path.join(os.tmpdir(), `wf-reenqueue-${Date.now()}`);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('re-enqueues pending and running runs after restart', async () => {
    // Phase 1: create a world and populate it with runs in various states
    const world1 = createLocalWorld({ dataDir });
    await world1.start();

    const pendingRun = await createRun(world1, {
      deploymentId: 'dpl_1',
      workflowName: 'myWorkflow',
      input: new Uint8Array([1]),
    });

    const runningRun = await createRun(world1, {
      deploymentId: 'dpl_1',
      workflowName: 'otherWorkflow',
      input: new Uint8Array([2]),
    });
    await updateRun(world1, runningRun.runId, 'run_started');

    const completedRun = await createRun(world1, {
      deploymentId: 'dpl_1',
      workflowName: 'myWorkflow',
      input: new Uint8Array([3]),
    });
    await updateRun(world1, completedRun.runId, 'run_started');
    await updateRun(world1, completedRun.runId, 'run_completed', {
      output: new Uint8Array([4]),
    });

    const failedRun = await createRun(world1, {
      deploymentId: 'dpl_1',
      workflowName: 'myWorkflow',
      input: new Uint8Array([5]),
    });
    await updateRun(world1, failedRun.runId, 'run_started');
    await updateRun(world1, failedRun.runId, 'run_failed', {
      error: { message: 'boom' },
    });

    await world1.close();

    // Phase 2: create a new world (simulating restart), register a handler
    // to capture enqueued messages
    const world2 = createLocalWorld({ dataDir });
    const receivedRunIds: string[] = [];
    world2.registerHandler('__wkf_workflow_', async (req) => {
      const body = await req.json();
      receivedRunIds.push(body.runId);
      return Response.json({ ok: true });
    });

    await world2.start();

    // Wait for async queue processing to complete
    await vi.waitFor(() => {
      expect(receivedRunIds).toHaveLength(2);
    });

    expect(receivedRunIds).toContain(pendingRun.runId);
    expect(receivedRunIds).toContain(runningRun.runId);
    expect(receivedRunIds).not.toContain(completedRun.runId);
    expect(receivedRunIds).not.toContain(failedRun.runId);

    await world2.close();
  });

  it('does nothing when there are no active runs', async () => {
    // Create a world with only completed runs
    const world1 = createLocalWorld({ dataDir });
    await world1.start();

    const run = await createRun(world1, {
      deploymentId: 'dpl_1',
      workflowName: 'myWorkflow',
      input: new Uint8Array([1]),
    });
    await updateRun(world1, run.runId, 'run_started');
    await updateRun(world1, run.runId, 'run_completed', {
      output: new Uint8Array([2]),
    });

    await world1.close();

    // Restart — handler should not be called
    const world2 = createLocalWorld({ dataDir });
    const receivedRunIds: string[] = [];
    world2.registerHandler('__wkf_workflow_', async (req) => {
      const body = await req.json();
      receivedRunIds.push(body.runId);
      return Response.json({ ok: true });
    });

    await world2.start();

    // Give the queue a tick to process (it shouldn't have anything)
    await new Promise((r) => globalThis.setTimeout(r, 50));
    expect(receivedRunIds).toHaveLength(0);

    await world2.close();
  });

  it('does nothing on first start with empty data dir', async () => {
    const world = createLocalWorld({ dataDir });
    const receivedRunIds: string[] = [];
    world.registerHandler('__wkf_workflow_', async (req) => {
      const body = await req.json();
      receivedRunIds.push(body.runId);
      return Response.json({ ok: true });
    });

    // start() initializes the data dir and should not fail or enqueue anything
    await world.start();

    await new Promise((r) => globalThis.setTimeout(r, 50));
    expect(receivedRunIds).toHaveLength(0);

    await world.close();
  });
});
