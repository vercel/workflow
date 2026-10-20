import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Event, Storage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld, type LocalWorld } from './index.js';
import { ORPHANED_STEP_ERROR_MESSAGE } from './orphaned-steps.js';
import {
  createRun,
  createStep,
  updateRun,
  updateStep,
} from './test-helpers.js';

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const input = new Uint8Array([1]);

async function startRun(world: Storage) {
  const run = await createRun(world, {
    deploymentId: 'dpl_1',
    workflowName: 'myWorkflow',
    input,
  });
  await updateRun(world, run.runId, 'run_started');
  return run.runId;
}

/** A step whose body a queue message of this process is running inline. */
async function startInlineStep(world: Storage, runId: string, stepId: string) {
  await createStep(world, runId, { stepId, stepName: 'myStep', input });
  await updateStep(world, runId, stepId, 'step_started', {
    ownerMessageId: 'msg_previous_process',
  });
}

async function stepEvents(world: Storage, runId: string, stepId: string) {
  const { data } = await world.events.list({
    runId,
    pagination: { sortOrder: 'asc' },
  });
  return data.filter((e) => e.correlationId === stepId);
}

const types = (events: Event[]) => events.map((e) => e.eventType);

/** Restart on `dataDir` and resolve with the step events seen at delivery. */
async function restart(
  config: Parameters<typeof createWorld>[0],
  observe: { runId: string; stepId: string }
): Promise<{ world: LocalWorld; atDelivery: string[] }> {
  const world = createWorld(config);
  let atDelivery: string[] | undefined;
  world.registerHandler('__wkf_workflow_', async (req) => {
    const { runId } = await req.json();
    if (runId === observe.runId) {
      atDelivery = types(await stepEvents(world, runId, observe.stepId));
    }
    return Response.json({ ok: true });
  });
  await world.start();
  return {
    world,
    atDelivery: await vi.waitFor(() => {
      if (!atDelivery) throw new Error('run not delivered yet');
      return atDelivery;
    }),
  };
}

describe('orphaned inline steps on restart', () => {
  let dataDir: string;

  beforeEach(() => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
    dataDir = path.join(os.tmpdir(), `wf-orphaned-steps-${Date.now()}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes step_retrying for an inline step before re-enqueueing its run', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await startInlineStep(previous, runId, 'step_inline');
    await previous.close();

    const { world, atDelivery } = await restart(
      { dataDir },
      { runId, stepId: 'step_inline' }
    );

    expect(atDelivery).toEqual([
      'step_created',
      'step_started',
      'step_retrying',
    ]);
    const retrying = (await stepEvents(world, runId, 'step_inline')).at(-1);
    expect(retrying?.eventData).toMatchObject({ stepName: 'myStep' });
    const step = await world.steps.get(runId, 'step_inline');
    // The dead attempt counts; the next start makes it attempt 2.
    expect(step).toMatchObject({ status: 'pending', attempt: 1 });
    const error = new TextDecoder().decode(step.error as Uint8Array);
    expect(error.slice(0, 4)).toBe('devl');
    expect(JSON.parse(error.slice(4))).toEqual([
      ['Error', 1],
      { name: 2, message: 3 },
      'Error',
      ORPHANED_STEP_ERROR_MESSAGE,
    ]);
    await world.close();
  });

  it('leaves queue-owned and finished steps alone', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    // Started by a queued step message: no owner stamp.
    await createStep(previous, runId, {
      stepId: 'step_queued',
      stepName: 'myStep',
      input,
    });
    await updateStep(previous, runId, 'step_queued', 'step_started');
    await startInlineStep(previous, runId, 'step_completed');
    await updateStep(previous, runId, 'step_completed', 'step_completed', {
      result: input,
    });
    await startInlineStep(previous, runId, 'step_failed');
    await updateStep(previous, runId, 'step_failed', 'step_failed', {
      error: input,
    });
    // Retried once already, so core no longer honors the later stamp.
    await startInlineStep(previous, runId, 'step_retried');
    await updateStep(previous, runId, 'step_retried', 'step_retrying', {
      error: input,
    });
    await updateStep(previous, runId, 'step_retried', 'step_started', {
      ownerMessageId: 'msg_previous_process',
    });
    await previous.close();

    const { world } = await restart(
      { dataDir },
      { runId, stepId: 'step_queued' }
    );

    expect(types(await stepEvents(world, runId, 'step_queued'))).toEqual([
      'step_created',
      'step_started',
    ]);
    expect(types(await stepEvents(world, runId, 'step_completed'))).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
    expect(types(await stepEvents(world, runId, 'step_failed'))).toEqual([
      'step_created',
      'step_started',
      'step_failed',
    ]);
    expect(types(await stepEvents(world, runId, 'step_retried'))).toEqual([
      'step_created',
      'step_started',
      'step_retrying',
      'step_started',
    ]);
    await world.close();
  });

  it("releases only the restarting world's tag", async () => {
    const tagged = createWorld({ dataDir, tag: 'vitest-0' });
    const taggedRunId = await startRun(tagged);
    await startInlineStep(tagged, taggedRunId, 'step_inline');
    const otherTag = createWorld({ dataDir, tag: 'vitest-1' });
    const otherTagRunId = await startRun(otherTag);
    await startInlineStep(otherTag, otherTagRunId, 'step_inline');
    const untagged = createWorld({ dataDir });
    const untaggedRunId = await startRun(untagged);
    await startInlineStep(untagged, untaggedRunId, 'step_inline');
    await Promise.all([tagged.close(), otherTag.close(), untagged.close()]);

    const { world, atDelivery } = await restart(
      { dataDir, tag: 'vitest-0' },
      { runId: taggedRunId, stepId: 'step_inline' }
    );

    expect(atDelivery).toContain('step_retrying');
    for (const [config, runId] of [
      [{ dataDir, tag: 'vitest-1' }, otherTagRunId],
      [{ dataDir }, untaggedRunId],
    ] as const) {
      const reader = createWorld(config);
      expect(types(await stepEvents(reader, runId, 'step_inline'))).toEqual([
        'step_created',
        'step_started',
      ]);
      await reader.close();
    }
    await world.close();
  });

  it('leaves recovery to the embedder when recoverActiveRuns is false', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await startInlineStep(previous, runId, 'step_inline');
    await previous.close();

    const world = createWorld({ dataDir, recoverActiveRuns: false });
    await world.start();
    expect(types(await stepEvents(world, runId, 'step_inline'))).toEqual([
      'step_created',
      'step_started',
    ]);

    await world.releaseOrphanedSteps(runId);
    // Released steps are queue-owned from here on, so a second call is a no-op.
    await world.releaseOrphanedSteps(runId);

    expect(types(await stepEvents(world, runId, 'step_inline'))).toEqual([
      'step_created',
      'step_started',
      'step_retrying',
    ]);
    await world.close();
  });
});
