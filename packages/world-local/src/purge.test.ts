import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type LocalWorld } from './index.js';
import {
  createHook,
  createRun,
  createStep,
  updateRun,
  updateStep,
} from './test-helpers.js';

describe('purgeRunTree', () => {
  let dataDir: string;
  let world: LocalWorld;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-purge-'));
    world = createWorld({ dataDir, recoverActiveRuns: false });
  });

  afterEach(async () => {
    await world.close();
    await fs.rm(dataDir, { force: true, recursive: true });
  });

  it('purges terminal root and descendant entities while preserving unrelated runs', async () => {
    const root = await createRun(world, {
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    const child = await createRun(world, {
      attributes: { lineageRoot: root.runId },
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    const unrelated = await createRun(world, {
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    await createHook(world, child.runId, {
      hookId: 'hook_child',
      token: 'child-token',
    });
    await createStep(world, child.runId, {
      input: new Uint8Array(),
      stepId: 'step_child',
      stepName: 'child',
    });
    await updateStep(world, child.runId, 'step_child', 'step_completed', {
      result: new Uint8Array(),
    });
    await world.streams.write(child.runId, 'stream_child', 'secret');
    await world.streams.close(child.runId, 'stream_child');
    await updateRun(world, child.runId, 'run_completed', {
      output: new Uint8Array(),
    });
    await updateRun(world, root.runId, 'run_completed', {
      output: new Uint8Array(),
    });

    await expect(
      world.purgeRunTree?.(root.runId, {
        descendantAttribute: { key: 'lineageRoot', value: root.runId },
      })
    ).resolves.toEqual({ purgedRunCount: 2, status: 'purged' });
    await expect(world.runs.get(root.runId)).rejects.toThrow();
    await expect(world.runs.get(child.runId)).rejects.toThrow();
    await expect(world.hooks.getByToken('child-token')).rejects.toThrow();
    await expect(world.runs.get(unrelated.runId)).resolves.toMatchObject({
      runId: unrelated.runId,
    });
  });

  it('is idempotent for an absent root', async () => {
    await expect(world.purgeRunTree?.('wrun_absent')).resolves.toEqual({
      purgedRunCount: 0,
      status: 'absent',
    });
  });

  it('rejects an active tree without deleting it', async () => {
    const root = await createRun(world, {
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });

    await expect(world.purgeRunTree?.(root.runId)).rejects.toThrow(
      'still active'
    );
    await expect(world.runs.get(root.runId)).resolves.toMatchObject({
      runId: root.runId,
    });
  });

  it('fences concurrent and later writes to a purged tree', async () => {
    const root = await createRun(world, {
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    await updateRun(world, root.runId, 'run_completed', {
      output: new Uint8Array(),
    });

    const purge = world.purgeRunTree?.(root.runId, {
      descendantAttribute: { key: 'lineageRoot', value: root.runId },
    });
    const lateEvent = world.events.create(root.runId, {
      eventType: 'run_cancelled',
      eventData: { cancelReason: 'late' },
    });

    await expect(purge).resolves.toMatchObject({ status: 'purged' });
    await expect(lateEvent).rejects.toThrow('was purged');
    await expect(
      createRun(world, {
        attributes: { lineageRoot: root.runId },
        deploymentId: 'deployment',
        input: new Uint8Array(),
        workflowName: 'workflow',
      })
    ).rejects.toThrow('was purged');
  });

  it('rejects re-associating a surviving run with a purged tree', async () => {
    const root = await createRun(world, {
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    const survivor = await createRun(world, {
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    await updateRun(world, root.runId, 'run_completed', {
      output: new Uint8Array(),
    });
    await world.purgeRunTree?.(root.runId, {
      descendantAttribute: { key: 'lineageRoot', value: root.runId },
    });

    await expect(
      world.runs.experimentalSetAttributes?.(survivor.runId, [
        { key: 'lineageRoot', value: root.runId },
      ])
    ).rejects.toThrow('was purged');
    await expect(
      world.runs.experimentalSetAttributes?.(survivor.runId, [
        { key: 'lineageRoot', value: 'another-root' },
      ])
    ).resolves.toEqual({
      attributes: { lineageRoot: 'another-root' },
    });
  });

  it('resumes a partial purge from its durable manifest after restart', async () => {
    const root = await createRun(world, {
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    const child = await createRun(world, {
      attributes: { lineageRoot: root.runId },
      deploymentId: 'deployment',
      input: new Uint8Array(),
      workflowName: 'workflow',
    });
    await updateRun(world, child.runId, 'run_completed', {
      output: new Uint8Array(),
    });
    await updateRun(world, root.runId, 'run_completed', {
      output: new Uint8Array(),
    });

    await fs.mkdir(path.join(dataDir, 'purged-trees'), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'purged-trees', `${root.runId}.json`),
      JSON.stringify({
        rootRunId: root.runId,
        runIds: [root.runId, child.runId],
        descendantAttribute: { key: 'lineageRoot', value: root.runId },
      })
    );
    await fs.rm(path.join(dataDir, 'runs', `${root.runId}.json`));

    await world.close();
    world = createWorld({ dataDir, recoverActiveRuns: false });
    await expect(world.purgeRunTree?.(root.runId)).resolves.toEqual({
      purgedRunCount: 2,
      status: 'purged',
    });
    await expect(world.runs.get(child.runId)).rejects.toThrow();
    await expect(
      createRun(world, {
        attributes: { lineageRoot: root.runId },
        deploymentId: 'deployment',
        input: new Uint8Array(),
        workflowName: 'workflow',
      })
    ).rejects.toThrow('was purged');
  });
});
