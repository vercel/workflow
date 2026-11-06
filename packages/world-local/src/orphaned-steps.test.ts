import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type Storage,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEntityDir } from './fs.js';
import { createWorld, type LocalWorld } from './index.js';
import {
  ORPHANED_STEP_ERROR_MESSAGE,
  RELEASE_CONCURRENCY,
  realmBoot,
} from './orphaned-steps.js';
import { lockOwner } from './storage/fence-lock.js';
import {
  createRun,
  createStep,
  createWait,
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

/**
 * Model the restarting process loading world-local after everything written
 * so far: the worlds below share this test's realm, and so its boot time.
 */
async function bootNewRealm() {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
  realmBoot.bootedAt = Date.now();
}

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
  await bootNewRealm();
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

  beforeEach(async () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wf-orphaned-steps-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    await bootNewRealm();
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

  it('leaves a step started since this realm booted alone', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await startInlineStep(previous, runId, 'step_dead');
    await previous.close();

    const world = createWorld({ dataDir, recoverActiveRuns: false });
    await bootNewRealm();
    await world.start();
    // A delivery in this realm (a run recovered earlier waking this one, or a
    // webhook) starts another inline step before the run is released.
    await startInlineStep(world, runId, 'step_live');

    await world.releaseOrphanedSteps(runId);

    expect(types(await stepEvents(world, runId, 'step_dead'))).toEqual([
      'step_created',
      'step_started',
      'step_retrying',
    ]);
    expect(types(await stepEvents(world, runId, 'step_live'))).toEqual([
      'step_created',
      'step_started',
    ]);
    await world.close();
  });

  it('leaves the steps of a finished run alone', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await startInlineStep(previous, runId, 'step_inline');
    await updateRun(previous, runId, 'run_cancelled');
    await previous.close();

    const world = createWorld({ dataDir, recoverActiveRuns: false });
    await bootNewRealm();
    await world.start();
    await world.releaseOrphanedSteps(runId);

    expect(types(await stepEvents(world, runId, 'step_inline'))).toEqual([
      'step_created',
      'step_started',
    ]);
    expect(await world.steps.get(runId, 'step_inline')).toMatchObject({
      status: 'running',
    });
    await world.close();
  });

  it('releases several runs at once, each before its own delivery', async () => {
    const previous = createWorld({ dataDir });
    const runIds: string[] = [];
    for (let i = 0; i < 3 * RELEASE_CONCURRENCY; i++) {
      const runId = await startRun(previous);
      await startInlineStep(previous, runId, 'step_inline');
      runIds.push(runId);
    }
    await previous.close();

    const world = createWorld({ dataDir });
    const list = world.steps.list.bind(world.steps);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(world.steps, 'list').mockImplementation(async (params) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
        return await list(params);
      } finally {
        inFlight--;
      }
    });
    const atDelivery = new Map<string, string[]>();
    world.registerHandler('__wkf_workflow_', async (req) => {
      const { runId } = await req.json();
      atDelivery.set(
        runId,
        types(await stepEvents(world, runId, 'step_inline'))
      );
      return Response.json({ ok: true });
    });
    await bootNewRealm();
    await world.start();

    await vi.waitFor(() => expect(atDelivery.size).toBe(runIds.length));
    for (const runId of runIds) {
      expect(atDelivery.get(runId)).toEqual([
        'step_created',
        'step_started',
        'step_retrying',
      ]);
    }
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(RELEASE_CONCURRENCY);
    await world.close();
  });

  it('still re-enqueues a run whose steps could not be released', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await startInlineStep(previous, runId, 'step_inline');
    await previous.close();

    const world = createWorld({ dataDir });
    vi.spyOn(world.steps, 'list').mockRejectedValue(new Error('disk hiccup'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const delivered: string[] = [];
    world.registerHandler('__wkf_workflow_', async (req) => {
      delivered.push((await req.json()).runId);
      return Response.json({ ok: true });
    });
    await bootNewRealm();
    await world.start();

    await vi.waitFor(() => expect(delivered).toEqual([runId]));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to release orphaned steps of run ${runId}`
      )
    );
    expect(types(await stepEvents(world, runId, 'step_inline'))).toEqual([
      'step_created',
      'step_started',
    ]);
    await world.close();
  });
});

describe('finished steps and waits whose event a crash cut short', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wf-unlogged-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * Leave the state of a process that died between saving the record as
   * finished and logging its event: the event file is gone, and the claim
   * names a writer the fence lock's rules can't check (this pid with another
   * token, like a container restart that reuses the pid).
   */
  async function cutShort(
    runId: string,
    correlationId: string,
    eventType: string,
    claim: string,
    // When the claim was written: by default 10 s ago, so before the next
    // realm boots yet short of the 30 s age rule.
    writtenAt = new Date(Date.now() - 10_000)
  ) {
    const dir = path.join(dataDir, runEntityDir('events', runId));
    for (const file of await readdir(dir)) {
      const event = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      if (
        event.eventType === eventType &&
        event.correlationId === correlationId
      ) {
        await unlink(path.join(dir, file));
      }
    }
    const claimPath = path.join(dataDir, '.locks', claim);
    await writeFile(claimPath, JSON.stringify(lockOwner('previous-process')));
    await utimes(claimPath, writtenAt, writtenAt);
  }

  async function finishStep(world: Storage, runId: string, stepId: string) {
    await createStep(world, runId, { stepId, stepName: 'myStep', input });
    await updateStep(world, runId, stepId, 'step_started');
    await updateStep(world, runId, stepId, 'step_completed', {
      result: new Uint8Array([7]),
    });
  }

  it('writes the missing step_completed from the saved step before re-enqueueing its run', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await finishStep(previous, runId, 'step_done');
    await previous.close();
    await cutShort(
      runId,
      'step_done',
      'step_completed',
      `steps/${runId}-step_done.terminal`
    );

    const { world, atDelivery } = await restart(
      { dataDir },
      { runId, stepId: 'step_done' }
    );

    expect(atDelivery).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
    const completed = (await stepEvents(world, runId, 'step_done')).find(
      (e) => e.eventType === 'step_completed'
    );
    if (!completed) throw new Error('step_completed was not repaired');
    const full = await world.events.get(runId, completed.eventId, {
      resolveData: 'all',
    });
    expect(full.eventData).toMatchObject({ result: new Uint8Array([7]) });
    await world.close();
  });

  it('writes the missing wait_completed of a wait saved as completed', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await createWait(previous, runId, {
      waitId: 'wait_1',
      resumeAt: new Date(0),
    });
    await previous.events.create(runId, {
      eventType: 'wait_completed',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'wait_1',
    });
    await previous.close();
    await cutShort(
      runId,
      'wait_1',
      'wait_completed',
      `waits/${runId}-wait_1.completed`
    );

    const { world, atDelivery } = await restart(
      { dataDir },
      { runId, stepId: 'wait_1' }
    );

    expect(atDelivery).toEqual(['wait_created', 'wait_completed']);
    await world.close();
  });

  it.each([
    ['since this realm booted', 0],
    // File mtimes can lag the clock: within 2 s of the boot, a claim may be
    // this realm's own.
    ['less than 2 s before this realm booted', -1_000],
  ])('leaves a claim written %s to its writer', async (_, offsetMs) => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await finishStep(previous, runId, 'step_done');
    await previous.close();

    const world = createWorld({ dataDir, recoverActiveRuns: false });
    await bootNewRealm();
    await world.start();
    // Another instance of this process (this pid, another token) took the
    // claim, and may still be about to log the event.
    await cutShort(
      runId,
      'step_done',
      'step_completed',
      `steps/${runId}-step_done.terminal`,
      new Date(realmBoot.bootedAt + offsetMs)
    );
    await world.releaseOrphanedSteps(runId);

    expect(types(await stepEvents(world, runId, 'step_done'))).toEqual([
      'step_created',
      'step_started',
    ]);
    await world.close();
  });

  it('lets every later write take over a claim from before this realm booted', async () => {
    // A container restart: the previous process took the step's terminal
    // claim and died before saving the step, so the step is still `running`
    // and startup repair has nothing to write. Its claim names a writer that
    // can't be checked from here (this pid, another token).
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await createStep(previous, runId, {
      stepId: 'step_running',
      stepName: 'myStep',
      input,
    });
    await updateStep(previous, runId, 'step_running', 'step_started');
    await previous.close();
    const claimPath = path.join(
      dataDir,
      '.locks',
      'steps',
      `${runId}-step_running.terminal`
    );
    await writeFile(claimPath, JSON.stringify(lockOwner('previous-process')));
    const writtenAt = new Date(Date.now() - 10_000);
    await utimes(claimPath, writtenAt, writtenAt);

    const world = createWorld({ dataDir, recoverActiveRuns: false });
    await bootNewRealm();
    await world.start();
    // Before startup recovery, the claim is only 10 s old: refused.
    await expect(
      updateStep(world, runId, 'step_running', 'step_completed', {
        result: new Uint8Array([1]),
      })
    ).rejects.toThrow('terminal state');

    await world.releaseOrphanedSteps(runId);
    await updateStep(world, runId, 'step_running', 'step_completed', {
      result: new Uint8Array([1]),
    });
    expect(types(await stepEvents(world, runId, 'step_running'))).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
    await world.close();
  });

  it('leaves a finished run alone', async () => {
    const previous = createWorld({ dataDir });
    const runId = await startRun(previous);
    await finishStep(previous, runId, 'step_done');
    await updateRun(previous, runId, 'run_cancelled');
    await previous.close();
    await cutShort(
      runId,
      'step_done',
      'step_completed',
      `steps/${runId}-step_done.terminal`
    );

    const world = createWorld({ dataDir, recoverActiveRuns: false });
    await bootNewRealm();
    await world.start();
    await world.releaseOrphanedSteps(runId);

    expect(types(await stepEvents(world, runId, 'step_done'))).toEqual([
      'step_created',
      'step_started',
    ]);
    await world.close();
  });
});
