import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStorage } from './storage.js';
import {
  createHook,
  createRun,
  createStep,
  updateRun,
  updateStep,
} from './test-helpers.js';

/**
 * File tagging functionality is used to allow world-local to contain multiple sub-directories
 * for different runners, usually the main app + the vitest test runner.
 */
describe('File tagging', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // world-sqlite: filesystem layout/claim/cache mechanics have no SQLite equivalent.

  // world-sqlite: filesystem layout/claim/cache mechanics have no SQLite equivalent.

  describe('tagged reads with fallback', () => {
    it('should read its own tagged files', async () => {
      const storage = createStorage(testDir, 'vitest-0');
      const run = await createRun(storage, {
        deploymentId: 'dep-1',
        workflowName: 'test-wf',
        input: new Uint8Array(),
      });

      const fetched = await storage.runs.get(run.runId);
      expect(fetched.runId).toBe(run.runId);
      expect(fetched.workflowName).toBe('test-wf');
    });

    it('should fall back to reading untagged files', async () => {
      // Write with untagged storage
      const untagged = createStorage(testDir);
      const run = await createRun(untagged, {
        deploymentId: 'dep-1',
        workflowName: 'untagged-wf',
        input: new Uint8Array(),
      });

      // Read with tagged storage — should find the untagged file via fallback
      const tagged = createStorage(testDir, 'vitest-0');
      const fetched = await tagged.runs.get(run.runId);
      expect(fetched.runId).toBe(run.runId);
      expect(fetched.workflowName).toBe('untagged-wf');
    });
  });

  describe('listing returns all files regardless of tag', () => {
    it('should list runs from both tagged and untagged sources', async () => {
      const untagged = createStorage(testDir);
      const tagged0 = createStorage(testDir, 'vitest-0');
      const tagged1 = createStorage(testDir, 'vitest-1');

      await createRun(untagged, {
        deploymentId: 'dep-1',
        workflowName: 'untagged-wf',
        input: new Uint8Array(),
      });
      await createRun(tagged0, {
        deploymentId: 'dep-2',
        workflowName: 'tagged0-wf',
        input: new Uint8Array(),
      });
      await createRun(tagged1, {
        deploymentId: 'dep-3',
        workflowName: 'tagged1-wf',
        input: new Uint8Array(),
      });

      // Any storage instance should see all 3 runs
      const result = await untagged.runs.list({
        pagination: { limit: 10 },
      });
      expect(result.data).toHaveLength(3);

      const names = result.data.map((r) => r.workflowName).sort();
      expect(names).toEqual(['tagged0-wf', 'tagged1-wf', 'untagged-wf']);
    });

    it('should list events from both tagged and untagged sources', async () => {
      const untagged = createStorage(testDir);
      const tagged = createStorage(testDir, 'vitest-0');

      const run1 = await createRun(untagged, {
        deploymentId: 'dep-1',
        workflowName: 'wf-1',
        input: new Uint8Array(),
      });
      const run2 = await createRun(tagged, {
        deploymentId: 'dep-2',
        workflowName: 'wf-2',
        input: new Uint8Array(),
      });

      // Each run_created produces one event
      const allEvents1 = await untagged.events.list({
        runId: run1.runId,
        pagination: { limit: 10 },
      });
      expect(allEvents1.data).toHaveLength(1);

      // Tagged storage can read the tagged run's events
      const allEvents2 = await tagged.events.list({
        runId: run2.runId,
        pagination: { limit: 10 },
      });
      expect(allEvents2.data).toHaveLength(1);
    });
  });

  describe('tagged clear()', () => {
    it('should only delete files with the matching tag', async () => {
      // Import createWorld to test clear()
      const { createWorld } = await import('./index.js');

      const untaggedWorld = createWorld({ dataDir: testDir });
      const taggedWorld = createWorld({
        dataDir: testDir,
        tag: 'vitest-0',
      });
      await untaggedWorld.start?.();

      // Create runs with both
      const untaggedRun = await createRun(untaggedWorld, {
        deploymentId: 'dep-1',
        workflowName: 'untagged-wf',
        input: new Uint8Array(),
      });
      await createRun(taggedWorld, {
        deploymentId: 'dep-2',
        workflowName: 'tagged-wf',
        input: new Uint8Array(),
      });

      // world-sqlite: assert remaining runs via the API below.
      // Clear tagged world — should only delete tagged files
      await taggedWorld.clear();

      // world-sqlite: removed tagged-file count assertions.
      // The untagged run should still be readable
      const fetched = await untaggedWorld.runs.get(untaggedRun.runId);
      expect(fetched.workflowName).toBe('untagged-wf');

      await untaggedWorld.close?.();
      await taggedWorld.close?.();
    });

    it('should not interfere with other tags', async () => {
      const { createWorld } = await import('./index.js');

      const world0 = createWorld({ dataDir: testDir, tag: 'vitest-0' });
      const world1 = createWorld({ dataDir: testDir, tag: 'vitest-1' });
      // Ensure data dir is initialized
      await world0.start?.();

      await createRun(world0, {
        deploymentId: 'dep-1',
        workflowName: 'wf-0',
        input: new Uint8Array(),
      });
      const run1 = await createRun(world1, {
        deploymentId: 'dep-2',
        workflowName: 'wf-1',
        input: new Uint8Array(),
      });

      // Clear tag 0
      await world0.clear();

      // world-sqlite: verify tag isolation through the surviving run.
      const fetched = await world1.runs.get(run1.runId);
      expect(fetched.workflowName).toBe('wf-1');

      await world0.close?.();
      await world1.close?.();
    });

    it('should clear events, steps, hooks, and waits', async () => {
      const { createWorld } = await import('./index.js');

      const world = createWorld({ dataDir: testDir, tag: 'vitest-0' });
      await world.start?.();

      const run = await createRun(world, {
        deploymentId: 'dep-1',
        workflowName: 'test-wf',
        input: new Uint8Array(),
      });
      await updateRun(world, run.runId, 'run_started');
      const step = await createStep(world, run.runId, {
        stepId: 'step_0',
        stepName: 'my-step',
        input: new Uint8Array(),
      });
      await updateStep(world, run.runId, step.stepId, 'step_started');
      await updateStep(world, run.runId, step.stepId, 'step_completed', {
        result: 'ok',
      });

      // world-sqlite: clear removes database entities, not directories.
      await world.clear();
      await expect(world.runs.get(run.runId)).rejects.toThrow();
      expect((await world.events.list({ runId: run.runId })).data).toHaveLength(
        0
      );
      expect((await world.steps.list({ runId: run.runId })).data).toHaveLength(
        0
      );
      await world.close?.();
    });

    // world-sqlite: filesystem layout/claim/cache mechanics have no SQLite equivalent.

    // world-sqlite: filesystem layout/claim/cache mechanics have no SQLite equivalent.
  });

  // world-sqlite: verify hook-token and stream cleanup via the public API.
  it('clears hook tokens so the same token can be reused', async () => {
    const { createWorld } = await import('./index.js');
    const world = createWorld({ dataDir: testDir, tag: 'vitest-0' });
    const run = await createRun(world, {
      deploymentId: 'dep-1',
      workflowName: 'hooks',
      input: new Uint8Array(),
    });
    await createHook(world, run.runId, {
      hookId: 'hook_before',
      token: 'reusable-token',
    });
    await world.clear();
    await expect(world.hooks.getByToken('reusable-token')).rejects.toThrow();
    const next = await createRun(world, {
      deploymentId: 'dep-1',
      workflowName: 'hooks',
      input: new Uint8Array(),
    });
    await createHook(world, next.runId, {
      hookId: 'hook_after',
      token: 'reusable-token',
    });
    expect((await world.hooks.getByToken('reusable-token')).hookId).toBe(
      'hook_after'
    );
    await world.close?.();
  });

  it('clears tagged stream data without deleting another tag', async () => {
    const { createWorld } = await import('./index.js');
    const world = createWorld({ dataDir: testDir, tag: 'vitest-0' });
    const other = createWorld({ dataDir: testDir, tag: 'vitest-1' });
    await world.streams.write('wrun_a', 'strm_a', 'hello');
    await other.streams.write('wrun_b', 'strm_b', 'world');
    await world.clear();
    expect(
      (await world.streams.getChunks('wrun_a', 'strm_a')).data
    ).toHaveLength(0);
    const { data } = await other.streams.getChunks('wrun_b', 'strm_b');
    expect(data).toHaveLength(1);
    expect(Buffer.from(data[0].data).toString()).toBe('world');
    await world.close?.();
    await other.close?.();
  });

  describe('untagged clear()', () => {
    it('can write new entities after clearing cached directories', async () => {
      const { createWorld } = await import('./index.js');
      const world = createWorld({ dataDir: testDir });
      await world.start?.();

      await createRun(world, {
        deploymentId: 'dep-before-clear',
        workflowName: 'before-clear',
        input: new Uint8Array(),
      });
      await world.clear();

      const run = await createRun(world, {
        deploymentId: 'dep-after-clear',
        workflowName: 'after-clear',
        input: new Uint8Array(),
      });

      expect((await world.runs.get(run.runId)).workflowName).toBe(
        'after-clear'
      );
      await world.close?.();
    });
  });

  describe('full lifecycle with tags', () => {
    it('should support complete run lifecycle through tagged storage', async () => {
      const storage = createStorage(testDir, 'vitest-0');

      // Create and start run
      const run = await createRun(storage, {
        deploymentId: 'dep-1',
        workflowName: 'lifecycle-wf',
        input: new Uint8Array([1, 2, 3]),
      });
      expect(run.status).toBe('pending');

      await updateRun(storage, run.runId, 'run_started');
      const startedRun = await storage.runs.get(run.runId);
      expect(startedRun.status).toBe('running');

      // Create and complete a step
      const step = await createStep(storage, run.runId, {
        stepId: 'step_0',
        stepName: 'process-data',
        input: new Uint8Array([4, 5]),
      });
      expect(step.status).toBe('pending');

      await updateStep(storage, run.runId, step.stepId, 'step_started');
      await updateStep(storage, run.runId, step.stepId, 'step_completed', {
        result: { processed: true },
      });

      const completedStep = await storage.steps.get(run.runId, step.stepId);
      expect(completedStep.status).toBe('completed');

      // Complete the run
      await updateRun(storage, run.runId, 'run_completed', {
        output: { success: true },
      });
      const completedRun = await storage.runs.get(run.runId);
      expect(completedRun.status).toBe('completed');

      // world-sqlite: tag suffixes are row metadata, not filenames.
    });
  });

  // world-sqlite: filesystem layout/claim/cache mechanics have no SQLite equivalent.
});
