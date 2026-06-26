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

  it('only re-enqueues runs for the matching tag', async () => {
    const world0 = createLocalWorld({ dataDir, tag: 'vitest-0' });
    await world0.start();

    const run0 = await createRun(world0, {
      deploymentId: 'dpl_1',
      workflowName: 'taggedWorkflow0',
      input: new Uint8Array([1]),
    });

    const world1 = createLocalWorld({ dataDir, tag: 'vitest-1' });
    const run1 = await createRun(world1, {
      deploymentId: 'dpl_1',
      workflowName: 'taggedWorkflow1',
      input: new Uint8Array([2]),
    });

    await world0.close();
    await world1.close();

    const restartedWorld0 = createLocalWorld({ dataDir, tag: 'vitest-0' });
    const receivedRunIds: string[] = [];
    restartedWorld0.registerHandler('__wkf_workflow_', async (req) => {
      const body = await req.json();
      receivedRunIds.push(body.runId);
      return Response.json({ ok: true });
    });

    await restartedWorld0.start();

    await vi.waitFor(() => {
      expect(receivedRunIds).toEqual([run0.runId]);
    });

    expect(receivedRunIds).not.toContain(run1.runId);

    await restartedWorld0.close();
  });

  it('untagged recovery skips tagged runs sharing the data dir', async () => {
    // A vitest harness (tagged world) leaves an active run in the shared
    // data directory. createRun leaves the run in `pending`, which recovery
    // would otherwise pick up.
    const taggedWorld = createLocalWorld({ dataDir, tag: 'vitest-0' });
    const taggedRun = await createRun(taggedWorld, {
      deploymentId: 'dpl_1',
      workflowName: 'taggedWorkflow',
      input: new Uint8Array([1]),
    });
    await taggedWorld.close();

    // An untagged run that recovery SHOULD pick up, to prove the filter
    // isn't simply dropping everything.
    const untaggedWorld = createLocalWorld({ dataDir });
    const untaggedRun = await createRun(untaggedWorld, {
      deploymentId: 'dpl_1',
      workflowName: 'untaggedWorkflow',
      input: new Uint8Array([2]),
    });
    await untaggedWorld.close();

    // A normal dev server boots untagged on the same data dir.
    const devWorld = createLocalWorld({ dataDir });
    const receivedRunIds: string[] = [];
    devWorld.registerHandler('__wkf_workflow_', async (req) => {
      const body = await req.json();
      receivedRunIds.push(body.runId);
      return Response.json({ ok: true });
    });

    await devWorld.start();

    await vi.waitFor(() => {
      expect(receivedRunIds).toEqual([untaggedRun.runId]);
    });
    // The tagged run must never be re-enqueued: the untagged world cannot read
    // it back, so run_started would fail with "did not return the run entity".
    expect(receivedRunIds).not.toContain(taggedRun.runId);

    await devWorld.close();
  });

  it('keeps tag filtering when recovery paginates across multiple pages', async () => {
    const world0 = createLocalWorld({ dataDir, tag: 'vitest-0' });
    const world1 = createLocalWorld({ dataDir, tag: 'vitest-1' });
    const untaggedWorld = createLocalWorld({ dataDir });

    await world0.start();
    await world1.start();
    await untaggedWorld.start();

    const taggedRunIds: string[] = [];
    const otherRunIds: string[] = [];

    for (let i = 0; i < 25; i++) {
      const run = await createRun(world0, {
        deploymentId: 'dpl_1',
        workflowName: `taggedWorkflow${i}`,
        input: new Uint8Array([i]),
      });
      taggedRunIds.push(run.runId);
    }

    for (let i = 0; i < 5; i++) {
      const run = await createRun(world1, {
        deploymentId: 'dpl_1',
        workflowName: `otherTaggedWorkflow${i}`,
        input: new Uint8Array([i]),
      });
      otherRunIds.push(run.runId);
    }

    for (let i = 0; i < 5; i++) {
      const run = await createRun(untaggedWorld, {
        deploymentId: 'dpl_1',
        workflowName: `untaggedWorkflow${i}`,
        input: new Uint8Array([i]),
      });
      otherRunIds.push(run.runId);
    }

    await world0.close();
    await world1.close();
    await untaggedWorld.close();

    const restartedWorld0 = createLocalWorld({ dataDir, tag: 'vitest-0' });
    const receivedRunIds: string[] = [];
    restartedWorld0.registerHandler('__wkf_workflow_', async (req) => {
      const body = await req.json();
      receivedRunIds.push(body.runId);
      return Response.json({ ok: true });
    });

    await restartedWorld0.start();

    await vi.waitFor(() => {
      expect(receivedRunIds).toHaveLength(taggedRunIds.length);
    });

    expect(new Set(receivedRunIds)).toEqual(new Set(taggedRunIds));
    for (const runId of otherRunIds) {
      expect(receivedRunIds).not.toContain(runId);
    }

    await restartedWorld0.close();
  });

  it('skips startup recovery when recoverActiveRuns is false', async () => {
    const world1 = createLocalWorld({ dataDir });
    await world1.start();

    const run = await createRun(world1, {
      deploymentId: 'dpl_1',
      workflowName: 'myWorkflow',
      input: new Uint8Array([1]),
    });

    await world1.close();

    const world2 = createLocalWorld({ dataDir, recoverActiveRuns: false });
    const receivedRunIds: string[] = [];
    world2.registerHandler('__wkf_workflow_', async (req) => {
      const body = await req.json();
      receivedRunIds.push(body.runId);
      return Response.json({ ok: true });
    });

    await world2.start();

    await new Promise((r) => globalThis.setTimeout(r, 50));
    expect(receivedRunIds).toHaveLength(0);
    expect(receivedRunIds).not.toContain(run.runId);

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
