import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listJSONFiles, stripTag } from './fs.js';
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

  describe('stripTag', () => {
    it('should strip a tag suffix from a fileId', () => {
      expect(stripTag('wrun_ABC123.vitest-0')).toBe('wrun_ABC123');
      expect(stripTag('wrun_ABC-evnt_DEF.mytag')).toBe('wrun_ABC-evnt_DEF');
    });

    it('should not strip from fileIds without tags', () => {
      expect(stripTag('wrun_ABC123')).toBe('wrun_ABC123');
      expect(stripTag('wrun_ABC-step_0')).toBe('wrun_ABC-step_0');
    });

    it('should not strip numeric-only suffixes (not valid tags)', () => {
      // Tags must start with a letter
      expect(stripTag('wrun_ABC.123')).toBe('wrun_ABC.123');
    });
  });

  describe('tagged writes produce tagged filenames', () => {
    it('should write run files with tag suffix', async () => {
      const storage = createStorage(testDir, 'vitest-0');
      const run = await createRun(storage, {
        deploymentId: 'dep-1',
        workflowName: 'test-wf',
        input: new Uint8Array(),
      });

      const runsDir = path.join(testDir, 'runs');
      const files = await fs.readdir(runsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.vitest-0\.json$/);
      expect(files[0]).toContain(run.runId);
    });

    it('should write event files with tag suffix', async () => {
      const storage = createStorage(testDir, 'vitest-0');
      await createRun(storage, {
        deploymentId: 'dep-1',
        workflowName: 'test-wf',
        input: new Uint8Array(),
      });

      const eventsDir = path.join(testDir, 'events');
      const files = await fs.readdir(eventsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.vitest-0\.json$/);
    });

    it('should write step files with tag suffix', async () => {
      const storage = createStorage(testDir, 'vitest-0');
      const run = await createRun(storage, {
        deploymentId: 'dep-1',
        workflowName: 'test-wf',
        input: new Uint8Array(),
      });
      await updateRun(storage, run.runId, 'run_started');
      await createStep(storage, run.runId, {
        stepId: 'step_0',
        stepName: 'my-step',
        input: new Uint8Array(),
      });

      const stepsDir = path.join(testDir, 'steps');
      const files = await fs.readdir(stepsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.vitest-0\.json$/);
    });
  });

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
      // Import createLocalWorld to test clear()
      const { createLocalWorld } = await import('./index.js');

      const untaggedWorld = createLocalWorld({ dataDir: testDir });
      const taggedWorld = createLocalWorld({
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

      // Verify both exist
      const runsDir = path.join(testDir, 'runs');
      const before = await fs.readdir(runsDir);
      expect(before).toHaveLength(2);

      // Clear tagged world — should only delete tagged files
      await taggedWorld.clear();

      const after = await fs.readdir(runsDir);
      expect(after).toHaveLength(1);
      expect(after[0]).not.toContain('vitest-0');

      // The untagged run should still be readable
      const fetched = await untaggedWorld.runs.get(untaggedRun.runId);
      expect(fetched.workflowName).toBe('untagged-wf');

      await untaggedWorld.close?.();
      await taggedWorld.close?.();
    });

    it('should not interfere with other tags', async () => {
      const { createLocalWorld } = await import('./index.js');

      const world0 = createLocalWorld({ dataDir: testDir, tag: 'vitest-0' });
      const world1 = createLocalWorld({ dataDir: testDir, tag: 'vitest-1' });
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

      // Tag 1 data should still exist
      const runsDir = path.join(testDir, 'runs');
      const remaining = await fs.readdir(runsDir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toContain('vitest-1');

      const fetched = await world1.runs.get(run1.runId);
      expect(fetched.workflowName).toBe('wf-1');

      await world0.close?.();
      await world1.close?.();
    });

    it('should clear events, steps, hooks, and waits', async () => {
      const { createLocalWorld } = await import('./index.js');

      const world = createLocalWorld({ dataDir: testDir, tag: 'vitest-0' });
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

      // Verify files exist
      const runsDir = path.join(testDir, 'runs');
      const eventsDir = path.join(testDir, 'events');
      const stepsDir = path.join(testDir, 'steps');
      expect((await fs.readdir(runsDir)).length).toBeGreaterThan(0);
      expect((await fs.readdir(eventsDir)).length).toBeGreaterThan(0);
      expect((await fs.readdir(stepsDir)).length).toBeGreaterThan(0);

      await world.clear();

      // All tagged files should be gone
      expect(await fs.readdir(runsDir)).toHaveLength(0);
      expect(await fs.readdir(eventsDir)).toHaveLength(0);
      expect(await fs.readdir(stepsDir)).toHaveLength(0);

      await world.close?.();
    });

    it('should clear hook token constraint files', async () => {
      const { createLocalWorld } = await import('./index.js');

      const world = createLocalWorld({ dataDir: testDir, tag: 'vitest-0' });
      await world.start?.();

      const run = await createRun(world, {
        deploymentId: 'dep-1',
        workflowName: 'hook-wf',
        input: new Uint8Array(),
      });
      await updateRun(world, run.runId, 'run_started');
      await createHook(world, run.runId, {
        hookId: 'hook_0',
        token: 'my-unique-token',
      });

      // Verify constraint file was created
      const tokensDir = path.join(testDir, 'hooks', 'tokens');
      const constraintsBefore = await fs.readdir(tokensDir);
      expect(constraintsBefore).toHaveLength(1);

      // Verify hook file was created with tag
      const hooksDir = path.join(testDir, 'hooks');
      const hookFiles = (await fs.readdir(hooksDir)).filter((f) =>
        f.endsWith('.json')
      );
      expect(hookFiles).toHaveLength(1);
      expect(hookFiles[0]).toMatch(/\.vitest-0\.json$/);

      await world.clear();

      // Both the tagged hook file and the untagged constraint file should be gone
      const hookFilesAfter = (await fs.readdir(hooksDir)).filter((f) =>
        f.endsWith('.json')
      );
      expect(hookFilesAfter).toHaveLength(0);

      const constraintsAfter = await fs.readdir(tokensDir);
      expect(constraintsAfter).toHaveLength(0);

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

      // Verify all files are tagged
      const runsDir = path.join(testDir, 'runs');
      const eventsDir = path.join(testDir, 'events');
      const stepsDir = path.join(testDir, 'steps');
      for (const dir of [runsDir, eventsDir, stepsDir]) {
        const files = await fs.readdir(dir);
        for (const file of files) {
          expect(file).toMatch(/\.vitest-0\.json$/);
        }
      }
    });
  });

  describe('listJSONFiles with tagged files', () => {
    it('should return fileIds including tag for correct path construction', async () => {
      const dir = path.join(testDir, 'runs');
      await fs.mkdir(dir, { recursive: true });

      // Write tagged and untagged files
      await fs.writeFile(
        path.join(dir, 'wrun_ABC.json'),
        JSON.stringify({ id: 'wrun_ABC' })
      );
      await fs.writeFile(
        path.join(dir, 'wrun_DEF.vitest-0.json'),
        JSON.stringify({ id: 'wrun_DEF' })
      );

      const fileIds = await listJSONFiles(dir);
      expect(fileIds).toHaveLength(2);
      // fileIds include the tag so paginatedFileSystemQuery can construct correct paths
      expect(fileIds.sort()).toEqual(['wrun_ABC', 'wrun_DEF.vitest-0']);
    });
  });
});
