import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FatalError, RetryableError } from '@workflow/errors';
import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments } from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import { getWritable } from '../step/writable-stream.js';
import { executeStep } from './step-executor.js';
import { setWorld } from './world.js';

/**
 * The step executor's hold mode (`holdTerminal`), the first half of the
 * piggyback commit: everything the terminal write waits for still happens,
 * then nothing is written and the caller gets the event plus a `flushAlone()`
 * that is exactly today's write.
 */

let counter = 0;
const uniqueStepName = () => {
  counter += 1;
  return `step//./step-executor-hold-test//holdStep${counter}`;
};

function makeWorld(): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-step-executor-hold-'));
  return createWorld({ dataDir, tag: `hold${counter}` });
}

async function setupStep(world: World, stepName: string) {
  const runInput = await dehydrateStepArguments([], 'run', undefined);
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: 'wf',
      input: runInput,
    },
  });
  const runId = created.run?.runId as string;
  await world.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {},
  } as never);
  const stepId = `step_hold_${counter}`;
  await world.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: {
      stepName,
      input: await dehydrateStepArguments(
        { args: [], closureVars: undefined, thisVal: undefined },
        runId,
        undefined
      ),
    },
  });
  return { runId, stepId };
}

async function typesFor(world: World, runId: string, stepId: string) {
  const { data } = await world.events.list({
    runId,
    pagination: { sortOrder: 'asc' },
  });
  return data
    .filter((event) => event.correlationId === stepId)
    .map((event) => event.eventType);
}

function exec(world: World, runId: string, stepId: string, stepName: string) {
  return executeStep({
    world,
    workflowRunId: runId,
    workflowName: 'wf',
    workflowStartedAt: Date.now(),
    stepId,
    stepName,
    authoritativeAttempt: 1,
    holdTerminal: true,
  });
}

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
  delete process.env.WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS;
});

describe('executeStep holdTerminal', () => {
  it('writes nothing terminal, and flushAlone writes exactly once', async () => {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => 'result-value');
    const { runId, stepId } = await setupStep(world, stepName);

    const result = await exec(world, runId, stepId, stepName);
    expect(result.type).toBe('held');
    if (result.type !== 'held') throw new Error('unreachable');
    expect(result.held.eventType).toBe('step_completed');
    expect(result.held.correlationId).toBe(stepId);
    expect(result.held.eventData.result).toBeInstanceOf(Uint8Array);
    expect(result.held.occurredAt).toBeInstanceOf(Date);
    // Held: the step is started but not completed.
    expect(await typesFor(world, runId, stepId)).toEqual([
      'step_created',
      'step_started',
    ]);

    const create = vi.spyOn(world.events, 'create');
    const flushed = await result.flushAlone();
    // The same result shape an unheld execution returns.
    expect(flushed).toMatchObject({ type: 'completed', hasPendingOps: false });
    // Once: a second flush returns the same outcome without writing again.
    await result.flushAlone();
    expect(
      create.mock.calls.filter(
        ([, data]) => data.eventType === 'step_completed'
      )
    ).toHaveLength(1);
    // Exactly today's write: same event data the executor would have sent.
    expect(create.mock.calls[0][1]).toMatchObject({
      eventType: 'step_completed',
      correlationId: stepId,
      eventData: result.held.eventData,
    });
    expect(await typesFor(world, runId, stepId)).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
  });

  it('flushAlone maps a step that already finished to skipped', async () => {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => 1);
    const { runId, stepId } = await setupStep(world, stepName);
    const result = await exec(world, runId, stepId, stepName);
    if (result.type !== 'held') throw new Error('expected a hold');
    // A duplicate delivery completed the step meanwhile (e.g. the commit
    // landed but its answer was lost).
    await world.events.create(runId, {
      eventType: 'step_completed',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName, result: result.held.eventData.result },
    } as never);
    await expect(result.flushAlone()).resolves.toEqual({ type: 'skipped' });
  });

  it('holds a fatal step failure, and flushes it as step_failed', async () => {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => {
      throw new FatalError('nope');
    });
    const { runId, stepId } = await setupStep(world, stepName);
    const result = await exec(world, runId, stepId, stepName);
    expect(result.type).toBe('held');
    if (result.type !== 'held') throw new Error('unreachable');
    expect(result.held.eventType).toBe('step_failed');
    expect(result.held.eventData.error).toBeDefined();
    await expect(result.flushAlone()).resolves.toEqual({ type: 'failed' });
    expect(await typesFor(world, runId, stepId)).toContain('step_failed');
  });

  it('never holds step_retrying', async () => {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => {
      throw new RetryableError('again', { retryAfter: 1000 });
    });
    const { runId, stepId } = await setupStep(world, stepName);
    const result = await exec(world, runId, stepId, stepName);
    expect(result.type).toBe('retry');
    expect(await typesFor(world, runId, stepId)).toContain('step_retrying');
  });

  it('does not hold when the body queued preCompletionOps', async () => {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    const committed: string[] = [];
    registerStepFunction(stepName, async () => {
      const ctx = contextStorage.getStore() as NonNullable<
        ReturnType<typeof contextStorage.getStore>
      >;
      // Stand-in for a step-initiated abort's hook_received: a real event the
      // replay would never consume, so a commit after it is fenced for sure.
      ctx.preCompletionOps.push(
        Promise.resolve().then(() => {
          committed.push('pre');
        })
      );
      return 'x';
    });
    const { runId, stepId } = await setupStep(world, stepName);
    const result = await exec(world, runId, stepId, stepName);
    expect(result.type).toBe('completed');
    expect(committed).toEqual(['pre']);
    expect(await typesFor(world, runId, stepId)).toContain('step_completed');
  });

  it('does not hold when background ops are still pending', async () => {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => {
      const ctx = contextStorage.getStore() as NonNullable<
        ReturnType<typeof contextStorage.getStore>
      >;
      ctx.ops.push(new Promise<void>(() => {}));
      return 'x';
    });
    const { runId, stepId } = await setupStep(world, stepName);
    const result = await exec(world, runId, stepId, stepName);
    expect(result).toMatchObject({ type: 'completed', hasPendingOps: true });
  });

  it('holds only after the stream drain barrier', async () => {
    const world = makeWorld();
    setWorld(world);
    const closeGate = Promise.withResolvers<void>();
    const close = world.streams.close.bind(world.streams);
    let closed = false;
    world.streams.close = vi.fn(async (...args) => {
      await closeGate.promise;
      const out = await close(...args);
      closed = true;
      return out;
    });
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => {
      const writable = getWritable<string>();
      const writer = writable.getWriter();
      await writer.write('chunk');
      writer.releaseLock();
      await writable.close();
      return 'x';
    });
    const { runId, stepId } = await setupStep(world, stepName);
    const execution = exec(world, runId, stepId, stepName);
    let settled = false;
    void execution.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    closeGate.resolve();
    const result = await execution;
    expect(closed).toBe(true);
    expect(result.type).toBe('held');
  });

  it('does not hold on the optimistic start path', async () => {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => 'x');
    const runInput = await dehydrateStepArguments([], 'run', undefined);
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'wf',
        input: runInput,
      },
    });
    const runId = created.run?.runId as string;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as never);
    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId: 'step_opt',
      stepName,
      authoritativeAttempt: 1,
      lazyStepInput: await dehydrateStepArguments(
        { args: [], closureVars: undefined, thisVal: undefined },
        runId,
        undefined
      ),
      forceOptimisticStart: true,
      holdTerminal: true,
    });
    expect(result.type).toBe('completed');
  });
});
