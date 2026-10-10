import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FatalError } from '@workflow/errors';
import type { Event, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCK_POLL_INTERVAL_MS } from '../flushable-stream.js';
import { runtimeLogger } from '../logger.js';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments, hydrateStepError } from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import { getWritable } from '../step/writable-stream.js';
import { STREAM_NAME_SYMBOL, STREAM_SERVER_RUN_ID_SYMBOL } from '../symbols.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { executeStep } from './step-executor.js';
import {
  UNSERIALIZABLE_STEP_INPUT_MARKER,
  unserializableStepInputPlaceholder,
} from './unserializable-step.js';
import { setWorld } from './world.js';

// The retry ceiling (`authoritativeAttempt`) is what bounds a step that keeps
// timing out: a timeout hard-kills the body without writing any error, so the
// error-based guards never fire. These tests assert the ceiling is enforced
// BEFORE the body runs, and only once the attempt number actually exceeds
// maxRetries + 1.

const MAX_RETRIES = 3; // maxRetries + 1 = 4 total attempts allowed

let counter = 0;
function uniqueStepName(): string {
  counter += 1;
  return `step//./step-executor-test//timeoutStep${counter}`;
}

async function setupRunningStep(opts: {
  world: World;
  stepName: string;
  onBody: () => void;
  register?: boolean;
  createStep?: boolean;
  stepArgs?: unknown[];
}): Promise<{ runId: string; stepId: string }> {
  const {
    world,
    stepName,
    onBody,
    register = true,
    createStep = true,
    stepArgs = [],
  } = opts;
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
  const runId = created.run!.runId;
  await world.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {},
  } as never);

  const stepId = 'step_timeout_1';
  if (createStep) {
    const stepInput = await dehydrateStepArguments(
      { args: stepArgs, closureVars: undefined, thisVal: undefined },
      runId,
      undefined
    );
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName, input: stepInput },
    });
  }

  const stepFn = Object.assign(
    async () => {
      onBody();
      return 'ok';
    },
    { maxRetries: MAX_RETRIES }
  );
  if (register) {
    registerStepFunction(stepName, stepFn);
  }

  return { runId, stepId };
}

function makeWorld(): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-step-executor-'));
  return createWorld({ dataDir, tag: `t${counter}` });
}

async function runWritableStep(options: {
  releaseLock: boolean;
  awaitWrite?: boolean;
  delayBeforeWriterMs?: number;
  closeAfterRelease?: boolean;
  writeImpl?: () => Promise<void>;
  session?: ReturnType<NonNullable<World['streams']['createWriteSession']>>;
  throwAfterRelease?: boolean;
}): Promise<{
  execution: Promise<Awaited<ReturnType<typeof executeStep>>>;
  world: World;
  runId: string;
  stepId: string;
}> {
  const world = makeWorld();
  setWorld(world);
  if (options.session)
    world.streams.createWriteSession = () => options.session!;
  if (options.writeImpl) {
    world.streams.write = vi.fn(
      options.writeImpl
    ) as typeof world.streams.write;
  }

  const stepName = uniqueStepName();
  const { runId, stepId } = await setupRunningStep({
    world,
    stepName,
    onBody: () => {},
    register: false,
  });
  registerStepFunction(stepName, async () => {
    const writable = getWritable<string>();
    if (options.delayBeforeWriterMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.delayBeforeWriterMs)
      );
    }
    const writer = writable.getWriter();
    const write = writer.write('snapshot');
    if (options.awaitWrite !== false) await write;
    if (options.releaseLock) writer.releaseLock();
    if (options.closeAfterRelease) await writable.close();
    if (options.throwAfterRelease) throw new Error('step failed after release');
    return 'ok';
  });

  return {
    execution: executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    }),
    world,
    runId,
    stepId,
  };
}

async function eventsFor(
  world: World,
  runId: string,
  stepId: string,
  eventType: Event['eventType']
): Promise<Event[]> {
  const { data } = await world.events.list({ runId });
  return data.filter(
    (e) => e.eventType === eventType && e.correlationId === stepId
  );
}

describe('executeStep — stream durability barrier', () => {
  afterEach(() => {
    setWorld(undefined);
    delete process.env.WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS;
    counter += 1;
  });

  it.each([
    false,
    true,
  ])('releases stateful writers when the step ends (throws: %s)', async (throwAfterRelease) => {
    const session = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
    const { execution } = await runWritableStep({
      releaseLock: true,
      session,
      throwAfterRelease,
    });
    await execution;
    expect(session.write).toHaveBeenCalledTimes(1);
    expect(session.release).toHaveBeenCalledTimes(1);
    expect(session.close).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('writes step_completed only after a released writer drains', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      writeImpl: () => writeGate,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);

    releaseWrite();
    await expect(execution).resolves.toMatchObject({
      type: 'completed',
      hasPendingOps: false,
    });
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(1);
  });

  it('does not durably block a step that keeps its writer lock', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { execution } = await runWritableStep({
      releaseLock: false,
      awaitWrite: false,
      writeImpl: () => writeGate,
    });

    await expect(execution).resolves.toMatchObject({
      type: 'completed',
      hasPendingOps: true,
    });
    releaseWrite();
  });

  it('does not settle before the step acquires and releases its writer', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      delayBeforeWriterMs: LOCK_POLL_INTERVAL_MS * 3,
      writeImpl: () => writeGate,
    });

    await new Promise((resolve) =>
      setTimeout(resolve, LOCK_POLL_INTERVAL_MS * 5)
    );
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);

    releaseWrite();
    await expect(execution).resolves.toMatchObject({ type: 'completed' });
  });

  it('orders unsettled writes before the release checkpoint', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      awaitWrite: false,
      writeImpl: () => writeGate,
    });

    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);

    releaseWrite();
    await expect(execution).resolves.toMatchObject({ type: 'completed' });
  });

  it.each([
    'chunk',
    'empty close',
  ] as const)('orders a turbo writable argument %s after durable run creation', async (operation) => {
    const world = makeWorld();
    setWorld(world);
    vi.stubEnv('WORKFLOW_OPTIMISTIC_INLINE_START', '1');
    const runId = `wrun_${ulid()}`;
    const stepId = `step_${ulid()}`;
    const stepName = uniqueStepName();
    const streamId = `strm_${runId.slice(5)}_user`;
    const argument = new WritableStream<string>();
    Object.defineProperty(argument, STREAM_NAME_SYMBOL, { value: streamId });
    const input = await dehydrateStepArguments(
      { args: [argument] },
      runId,
      undefined
    );
    const runInput = await dehydrateStepArguments([], runId, undefined);
    const createGate = Promise.withResolvers<void>();
    const bodyEntered = Promise.withResolvers<void>();
    // Use real world-local run/event/stream persistence. Its stream store
    // accepts orphan writes, so add the server's run-existence precondition
    // to reproduce the HTTP PUT failure rather than silently accepting it.
    const write = world.streams.write.bind(world.streams);
    const close = world.streams.close.bind(world.streams);
    const writeSpy = vi
      .spyOn(world.streams, 'write')
      .mockImplementation(async (...args) => {
        await world.runs.get(args[0]);
        return write(...args);
      });
    const closeSpy = vi
      .spyOn(world.streams, 'close')
      .mockImplementation(async (...args) => {
        await world.runs.get(args[0]);
        return close(...args);
      });
    const runReadyBarrier = createGate.promise.then(async () => {
      await world.events.create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'dpl_test',
          workflowName: 'wf',
          input: runInput,
        },
      });
    });
    registerStepFunction(stepName, async (writable: WritableStream<string>) => {
      bodyEntered.resolve();
      const writer = writable.getWriter();
      if (operation === 'chunk') await writer.write('first chunk');
      await writer.close();
      return 'ok';
    });
    const execution = executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      lazyStepInput: input,
      forceOptimisticStart: true,
      runReadyBarrier,
      authoritativeAttempt: 1,
    });
    try {
      await bodyEntered.promise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(world.runs.get(runId)).rejects.toThrow();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      createGate.resolve();
      await execution;
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
    await expect(execution).resolves.toMatchObject({ type: 'completed' });
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(1);
    const reader = (await world.streams.get(runId, streamId)).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toHaveLength(operation === 'chunk' ? 1 : 0);
  });

  it('drains a revived forwarded writable argument before completion', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const world = makeWorld();
    setWorld(world);
    world.streams.write = vi.fn(() => writeGate) as typeof world.streams.write;

    const forwarded = new WritableStream<string>();
    Object.defineProperty(forwarded, STREAM_NAME_SYMBOL, {
      value: 'strm_forwarded',
    });
    Object.defineProperty(forwarded, STREAM_SERVER_RUN_ID_SYMBOL, {
      value: 'wrun_forwarded_owner',
    });
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
      stepArgs: [forwarded],
    });
    registerStepFunction(stepName, async (writable: WritableStream<string>) => {
      const writer = writable.getWriter();
      await writer.write('forwarded snapshot');
      writer.releaseLock();
      return 'ok';
    });

    const execution = executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);

    releaseWrite();
    await expect(execution).resolves.toMatchObject({
      type: 'completed',
      hasPendingOps: false,
    });
  });

  it('allows a released writable to close normally before step end', async () => {
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      closeAfterRelease: true,
    });

    await expect(execution).resolves.toMatchObject({
      type: 'completed',
      hasPendingOps: false,
    });
    expect(await eventsFor(world, runId, stepId, 'step_retrying')).toHaveLength(
      0
    );
    expect(await eventsFor(world, runId, stepId, 'step_failed')).toHaveLength(
      0
    );
  });

  it.each([
    false,
    true,
  ])('reports remaining ops after a slow released writable close drains (background op: %s)', async (hasBackgroundOp) => {
    const world = makeWorld();
    setWorld(world);
    const backgroundOp = Promise.withResolvers<void>();
    const closeGate = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const settlementStarted = Promise.withResolvers<void>();
    const close = world.streams.close.bind(world.streams);
    world.streams.close = vi.fn(async (...args) => {
      closeStarted.resolve();
      await closeGate.promise;
      return close(...args);
    });
    const createEvent = vi.spyOn(world.events, 'create');
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
    });
    registerStepFunction(stepName, async () => {
      const writable = getWritable<string>();
      const writer = writable.getWriter();
      await writer.write('snapshot');
      writer.releaseLock();
      await writable.close();

      // The public transform is closed, but its downstream pipe can still be
      // waiting for the World close. Observe the executor entering that wait.
      const ctx = contextStorage.getStore()!;
      if (hasBackgroundOp) ctx.ops.push(backgroundOp.promise);
      const state = ctx.streamStates![0];
      const settle = state.settleReleasedWrites!;
      vi.spyOn(state, 'settleReleasedWrites').mockImplementation(() => {
        settlementStarted.resolve();
        return settle();
      });
      return 'ok';
    });

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const execution = executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });
    try {
      await Promise.all([closeStarted.promise, settlementStarted.promise]);
      // Expire the inline-loop heuristic while the durability barrier is held.
      await vi.advanceTimersByTimeAsync(500);
      expect(
        createEvent.mock.calls.some(
          ([, event]) => event.eventType === 'step_completed'
        )
      ).toBe(false);
      closeGate.resolve();
      await expect(execution).resolves.toMatchObject({
        type: 'completed',
        hasPendingOps: hasBackgroundOp,
      });
      expect(
        await eventsFor(world, runId, stepId, 'step_completed')
      ).toHaveLength(1);
    } finally {
      closeGate.resolve();
      backgroundOp.resolve();
      await execution;
      vi.useRealTimers();
    }
  });

  it('bounds a throwing step drain and preserves the user error on retry', async () => {
    process.env.WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS = '400';
    const world = makeWorld();
    setWorld(world);
    const writeGate = Promise.withResolvers<void>();
    const settlementStarted = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    world.streams.createWriteSession = () => ({
      write: () => writeGate.promise,
      close: async () => {},
      release: () => released.resolve(),
    });
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
    });
    registerStepFunction(stepName, async () => {
      const writer = getWritable<string>().getWriter();
      await writer.write('accepted prefix');
      writer.releaseLock();
      const state = contextStorage.getStore()!.streamStates![0];
      const settle = state.settleReleasedWrites!;
      vi.spyOn(state, 'settleReleasedWrites').mockImplementation(() => {
        settlementStarted.resolve();
        return settle();
      });
      throw new Error('original step failure');
    });
    const warn = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    const createEvent = vi.spyOn(world.events, 'create');
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const execution = executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });
    try {
      await settlementStarted.promise;
      await vi.advanceTimersByTimeAsync(399);
      expect(
        createEvent.mock.calls.some(
          ([, event]) => event.eventType === 'step_retrying'
        )
      ).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(execution).resolves.toMatchObject({ type: 'retry' });
      expect(warn).toHaveBeenCalledWith(
        'Failed to drain released streams after step error',
        {
          workflowRunId: runId,
          stepId,
          error: 'Timed out draining step stream writes after 400ms',
        }
      );
      const retrying = await eventsFor(world, runId, stepId, 'step_retrying');
      expect(retrying).toHaveLength(1);
      const error = (await hydrateStepError(
        (retrying[0].eventData as { error: unknown }).error,
        runId,
        undefined
      )) as Error;
      expect(error.message).toBe('original step failure');
    } finally {
      writeGate.resolve();
      await released.promise;
      await execution;
      vi.useRealTimers();
      warn.mockRestore();
      createEvent.mockRestore();
    }
  });

  it('does not complete successfully when the drain times out', async () => {
    process.env.WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS = '10';
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      writeImpl: () => new Promise<void>(() => {}),
    });

    await expect(execution).resolves.toMatchObject({ type: 'retry' });
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);
  });

  it('does not complete successfully when the drain fails', async () => {
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      writeImpl: async () => {
        throw new Error('stream write failed');
      },
    });

    await expect(execution).resolves.toMatchObject({ type: 'retry' });
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);
  });

  it('an aborted stream does not bypass another stream drain', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const world = makeWorld();
    setWorld(world);
    world.streams.write = vi.fn(async (_runId, name) => {
      if (name.endsWith('_aborted')) {
        throw Object.assign(new Error('client disconnected'), {
          name: 'AbortError',
        });
      }
      await writeGate;
    }) as typeof world.streams.write;

    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
    });
    registerStepFunction(stepName, async () => {
      const aborted = getWritable<string>({ namespace: 'aborted' }).getWriter();
      const durable = getWritable<string>({ namespace: 'durable' }).getWriter();
      await aborted.write('a');
      await durable.write('b');
      aborted.releaseLock();
      durable.releaseLock();
      return 'ok';
    });

    const execution = executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);

    releaseWrite();
    await expect(execution).resolves.toMatchObject({ type: 'completed' });
  });

  it.each([
    'AbortError',
    'ResponseAborted',
  ])('tolerates a client disconnect named %s during drain', async (name) => {
    const { execution } = await runWritableStep({
      releaseLock: true,
      writeImpl: async () => {
        throw Object.assign(new Error('client disconnected'), { name });
      },
    });

    await expect(execution).resolves.toMatchObject({ type: 'completed' });
  });
});

describe('executeStep — retry ceiling (authoritativeAttempt)', () => {
  afterEach(() => {
    counter += 1;
  });

  it('fails the step WITHOUT running the body once the attempt exceeds maxRetries + 1', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      // Attempt maxRetries + 2 — one past the last allowed retry. This is the
      // delivery a timed-out step would land on with nothing left to try.
      authoritativeAttempt: MAX_RETRIES + 2,
    });

    expect(result.type).toBe('failed');
    // The body must NOT run — retries are already exhausted.
    expect(bodyRuns).toBe(0);

    // The ceiling fires BEFORE the start block, so no new step_started is
    // written for the rejected attempt; the step goes straight to failed.
    const started = await eventsFor(world, runId, stepId, 'step_started');
    expect(started).toHaveLength(0);
    const failures = await eventsFor(world, runId, stepId, 'step_failed');
    expect(failures).toHaveLength(1);
  });

  it('permits (does not pre-empt) the final allowed attempt (maxRetries + 1)', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      // maxRetries + 1 is the last permitted attempt: the ceiling must let it
      // proceed into normal execution rather than pre-emptively failing it.
      authoritativeAttempt: MAX_RETRIES + 1,
    });

    // It got past the ceiling: the step was started (entered normal execution)
    // and was NOT failed by the retry ceiling.
    void bodyRuns;
    expect(result.type).not.toBe('failed');
    const started = await eventsFor(world, runId, stepId, 'step_started');
    expect(started).toHaveLength(1);
    const ceilingFailures = await eventsFor(
      world,
      runId,
      stepId,
      'step_failed'
    );
    expect(ceilingFailures).toHaveLength(0);
  });
});

describe('executeStep — lazy start input source', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    counter += 1;
  });

  async function dehydrateArgs(runId: string, args: unknown[]) {
    return dehydrateStepArguments(
      { args, closureVars: undefined, thisVal: undefined },
      runId,
      undefined
    );
  }

  function registerArgsRecorder(stepName: string): unknown[][] {
    const seen: unknown[][] = [];
    registerStepFunction(stepName, async (...args: unknown[]) => {
      seen.push(args);
      return 'ok';
    });
    return seen;
  }

  it('hydrates the bytes it sent when its awaited lazy start created the step', async () => {
    // The awaited branch: optimistic start is off.
    vi.stubEnv('WORKFLOW_OPTIMISTIC_INLINE_START', '0');
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
      createStep: false,
    });
    const seen = registerArgsRecorder(stepName);
    const input = await dehydrateArgs(runId, ['local', 42]);

    // A World that does not echo the input it was just sent (world-vercel
    // asks for lazy refs on this write), but does say it created the step.
    const create = world.events.create.bind(world.events);
    vi.spyOn(world.events, 'create').mockImplementation(async (...args) => {
      const result = await create(...args);
      if (args[1].eventType !== 'step_started' || !result.step) return result;
      expect(result.stepCreated).toBe(true);
      return { ...result, step: { ...result.step, input: undefined } };
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      lazyStepInput: input,
      authoritativeAttempt: 1,
    });

    expect(result.type).toBe('completed');
    expect(seen).toEqual([['local', 42]]);
  });

  it("keeps the World's input when the lazy start does not report creating the step", async () => {
    vi.stubEnv('WORKFLOW_OPTIMISTIC_INLINE_START', '0');
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
      createStep: false,
    });
    const seen = registerArgsRecorder(stepName);
    const stored = await dehydrateArgs(runId, ['stored']);

    // A World that accepted the lazy start without saying it created the
    // step (every bundled World 409s instead, but the contract leaves
    // `stepCreated` optional): its stored input stays the authority.
    const create = world.events.create.bind(world.events);
    vi.spyOn(world.events, 'create').mockImplementation(async (...args) => {
      const result = await create(...args);
      if (args[1].eventType !== 'step_started' || !result.step) return result;
      const { stepCreated: _, ...rest } = result;
      return { ...rest, step: { ...result.step, input: stored } };
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      lazyStepInput: await dehydrateArgs(runId, ['local']),
      authoritativeAttempt: 1,
    });

    expect(result.type).toBe('completed');
    expect(seen).toEqual([['stored']]);
  });

  it("hydrates the World's input on a bare start", async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
      stepArgs: ['stored'],
    });
    const seen = registerArgsRecorder(stepName);

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });

    expect(result.type).toBe('completed');
    expect(seen).toEqual([['stored']]);
  });
});

describe('executeStep — compute instance stamping', () => {
  afterEach(() => {
    counter += 1;
  });

  it('stamps request and compute provenance on step_started without displacing the slot snapshot', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });

    // computeInstanceId rides in CreateEventParams, which world-local does not
    // persist — so observe the call itself rather than the stored event.
    const createSpy = vi.spyOn(world.events, 'create');

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      requestId: 'req_step_executor',
      stepId,
      stepName,
    });

    const started = createSpy.mock.calls.filter(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.[2]).toMatchObject({
      requestId: 'req_step_executor',
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
    // An executor write names no log position: it has no log to merge a
    // skipped-slot report into, so it must not ask the World to read one.
    expect(started[0]?.[2]?.eventCount).toBeUndefined();
  });

  it('stamps provenance when a lazy unregistered step is materialized', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
      createStep: false,
    });
    const input = await dehydrateStepArguments([], runId, undefined);
    const createSpy = vi.spyOn(world.events, 'create');

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      requestId: 'req_unregistered',
      stepId,
      stepName,
      lazyStepInput: input,
    });

    expect(result.type).toBe('failed');
    const started = createSpy.mock.calls.find(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started?.[2]).toMatchObject({
      requestId: 'req_unregistered',
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
  });

  it('omits an empty requestId from step_started', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });
    const createSpy = vi.spyOn(world.events, 'create');

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      requestId: '',
      stepId,
      stepName,
    });

    const started = createSpy.mock.calls.find(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started?.[2]?.requestId).toBeUndefined();
  });

  it('omits requestId from step_started when unavailable', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });
    const createSpy = vi.spyOn(world.events, 'create');

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
    });

    const started = createSpy.mock.calls.find(
      ([, data]) => data.eventType === 'step_started'
    );
    expect(started?.[2]).toMatchObject({
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
    expect(started?.[2]?.requestId).toBeUndefined();
  });

  it('sends no slot snapshot on any of its writes', async () => {
    // The only thing a World does with `eventCount` is bump-and-report: read
    // the events between the named position and the committed one and hand
    // them back. The executor has no loaded log to merge that page into, so
    // naming a position would make the World read a page nobody consumes, on
    // every contended step_started.
    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
    });

    const createSpy = vi.spyOn(world.events, 'create');

    await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
    });

    const counts = createSpy.mock.calls.map((call) => call[2]?.eventCount);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts.every((count) => count === undefined)).toBe(true);
  });
});

// Pre-claimed inline starts: the suspension handler's batched fan-out already
// committed (or lost) the step's step_created + step_started pair, so the
// executor must run the body straight off that verdict — no start write of
// its own on the owned path, no write AT ALL on the lost path.
describe('executeStep — pre-claimed inline start', () => {
  afterEach(() => {
    counter += 1;
  });

  it('runs the body without sending a step_started of its own when owned', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;

    // Commit the pair the suspension batch would have committed.
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
    const runId = created.run!.runId;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as never);
    const stepId = 'step_preclaimed_1';
    // The shape the suspension handler dehydrates for a pair's created row —
    // the body's hydration reads `.args` off it.
    const stepInput = await dehydrateStepArguments(
      { args: [], closureVars: undefined, thisVal: undefined },
      runId,
      undefined
    );
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName, input: stepInput },
    });
    const startResult = await world.events.create(runId, {
      eventType: 'step_started',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: { stepName },
    });
    registerStepFunction(stepName, async () => {
      bodyRuns += 1;
      return 'ok';
    });

    const createSpy = vi.spyOn(world.events, 'create');
    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
      preclaimedStart: {
        owned: true,
        step: { ...startResult.step!, input: stepInput },
        batchPostSentAtMs: Date.now() - 5,
        claimCompletedAtMs: Date.now(),
      },
    });

    expect(result.type).toBe('completed');
    expect(bodyRuns).toBe(1);
    // The executor wrote ONLY the terminal event — the claim was the batch's.
    const eventTypesWritten = createSpy.mock.calls.map(
      (call) => (call[1] as { eventType: string }).eventType
    );
    expect(eventTypesWritten).not.toContain('step_started');
    expect(eventTypesWritten).toContain('step_completed');
    expect(await eventsFor(world, runId, stepId, 'step_started')).toHaveLength(
      1
    );
  });

  it('skips without any write when the pair lost its claim', async () => {
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    registerStepFunction(stepName, async () => {
      bodyRuns += 1;
      return 'ok';
    });

    const createSpy = vi.spyOn(world.events, 'create');
    const result = await executeStep({
      world,
      workflowRunId: 'wrun_never_used',
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId: 'step_lost_claim',
      stepName,
      authoritativeAttempt: 1,
      preclaimedStart: { owned: false },
    });

    expect(result).toEqual({ type: 'skipped' });
    expect(bodyRuns).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('skips before the unregistered-step fallback when the claim was lost', async () => {
    const world = makeWorld();
    const createSpy = vi.spyOn(world.events, 'create');

    const result = await executeStep({
      world,
      workflowRunId: 'wrun_never_used',
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId: 'step_lost_unregistered',
      // Never registered: the owned path would write step_failed here, but a
      // lost claim is not this handler's to fail.
      stepName: 'step//./step-executor-test//neverRegistered',
      preclaimedStart: { owned: false },
    });

    expect(result).toEqual({ type: 'skipped' });
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('executeStep — turbo run-ready barrier on the awaited start', () => {
  afterEach(() => {
    counter += 1;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Turbo backgrounds `run_started` and forces optimistic start, but an
  // explicit opt-out sends the lazy `step_started` on the awaited branch. That
  // write must still wait for the run to be started, or a world that requires
  // a running run rejects the step's first start.
  it.each([
    { name: 'explicit opt-out under turbo', env: '0', force: true },
    { name: 'optimistic start left off', env: undefined, force: false },
  ])('holds the lazy step_started until run_started lands ($name)', async ({
    env,
    force,
  }) => {
    const world = makeWorld();
    if (env !== undefined) vi.stubEnv('WORKFLOW_OPTIMISTIC_INLINE_START', env);
    const stepName = uniqueStepName();
    const stepId = `step_${ulid()}`;
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
    const runId = created.run!.runId;
    const input = await dehydrateStepArguments(
      { args: [], closureVars: undefined, thisVal: undefined },
      runId,
      undefined
    );
    let bodyRuns = 0;
    registerStepFunction(stepName, async () => {
      bodyRuns += 1;
      return 'ok';
    });

    // The run's status at the moment each step_started is sent.
    const runStatusAtStart: string[] = [];
    const create = world.events.create.bind(world.events);
    vi.spyOn(world.events, 'create').mockImplementation(async (...args) => {
      const [targetRunId, event] = args;
      if (targetRunId && event.eventType === 'step_started') {
        runStatusAtStart.push((await world.runs.get(targetRunId)).status);
      }
      return create(...args);
    });

    const startGate = Promise.withResolvers<void>();
    const runReadyBarrier = startGate.promise.then(() =>
      create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {},
      } as never)
    );

    const execution = executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      lazyStepInput: input,
      forceOptimisticStart: force,
      runReadyBarrier,
      authoritativeAttempt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runStatusAtStart).toEqual([]);
    expect(bodyRuns).toBe(0);

    startGate.resolve();
    await expect(execution).resolves.toMatchObject({ type: 'completed' });
    expect(runStatusAtStart).toEqual(['running']);
    expect(bodyRuns).toBe(1);
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(1);
  });
});

describe('executeStep — unserializable-argument placeholder guard', () => {
  afterEach(() => {
    counter += 1;
  });

  it('fails the step without running the body when the stored input is the finalization placeholder', async () => {
    // Simulates the crash window in finalizeUnserializableStep: the
    // step_created (placeholder input) landed but the process died before
    // step_failed. Redelivery dispatches the step through normal crash
    // recovery — the executor must complete the intended failure, not run
    // user code with placeholder arguments.
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
      createStep: false,
    });
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: {
        stepName,
        input: (await dehydrateStepArguments(
          unserializableStepInputPlaceholder(),
          runId,
          undefined
        )) as Uint8Array,
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });

    expect(result.type).toBe('failed');
    expect(bodyRuns).toBe(0);

    // Fatal — one attempt, no step_retrying, straight to step_failed.
    const retrying = await eventsFor(world, runId, stepId, 'step_retrying');
    expect(retrying).toHaveLength(0);
    const failures = await eventsFor(world, runId, stepId, 'step_failed');
    expect(failures).toHaveLength(1);
    const hydrated = (await hydrateStepError(
      (failures[0].eventData as { error: unknown }).error,
      runId,
      undefined
    )) as Error;
    expect(hydrated.name).toBe('SerializationError');
    expect(hydrated.message).toContain('Failed to serialize step arguments');
  });

  it('does not trip on a genuine input that merely contains the marker string', async () => {
    // The structural flag lives on the triple's top level, which user code
    // never controls — an argument that happens to equal the display marker
    // must execute normally.
    const world = makeWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {
        bodyRuns += 1;
      },
      createStep: false,
    });
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: stepId,
      eventData: {
        stepName,
        input: (await dehydrateStepArguments(
          {
            args: [UNSERIALIZABLE_STEP_INPUT_MARKER],
            closureVars: [],
            thisVal: undefined,
          },
          runId,
          undefined
        )) as Uint8Array,
      },
    });

    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });

    expect(result.type).toBe('completed');
    expect(bodyRuns).toBe(1);
  });
});

describe('executeStep — thrown errors with a read-only stack', () => {
  afterEach(() => {
    counter += 1;
  });

  // postgres.js decorates query errors this way: `Object.defineProperties`
  // with only `value` turns `stack` into a non-writable data property, so
  // assigning to it throws in strict mode.
  function readOnlyStackError<T extends Error>(error: T): T {
    Object.defineProperties(error, {
      stack: { value: `${error.stack}\n    at query (db.js:1:1)` },
    });
    return error;
  }

  async function runThrowingStep(makeError: () => Error) {
    const world = makeWorld();
    setWorld(world);
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      onBody: () => {},
      register: false,
    });
    registerStepFunction(
      stepName,
      Object.assign(
        async () => {
          throw makeError();
        },
        { maxRetries: MAX_RETRIES }
      )
    );
    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });
    return { world, runId, stepId, result };
  }

  async function hydratedErrorOf(
    world: World,
    runId: string,
    stepId: string,
    eventType: 'step_retrying' | 'step_failed'
  ): Promise<Error> {
    const events = await eventsFor(world, runId, stepId, eventType);
    expect(events).toHaveLength(1);
    return (await hydrateStepError(
      (events[0].eventData as { error: unknown }).error,
      runId,
      undefined
    )) as Error;
  }

  it('records a retry with the original error', async () => {
    const { world, runId, stepId, result } = await runThrowingStep(() =>
      readOnlyStackError(new Error('relation "embeddings" does not exist'))
    );

    expect(result.type).toBe('retry');
    const hydrated = await hydratedErrorOf(
      world,
      runId,
      stepId,
      'step_retrying'
    );
    expect(hydrated.message).toBe('relation "embeddings" does not exist');
  });

  it('records a fatal failure with the original error', async () => {
    const { world, runId, stepId, result } = await runThrowingStep(() =>
      readOnlyStackError(new FatalError('constraint violated'))
    );

    expect(result.type).toBe('failed');
    expect(await eventsFor(world, runId, stepId, 'step_retrying')).toHaveLength(
      0
    );
    const hydrated = await hydratedErrorOf(world, runId, stepId, 'step_failed');
    expect(hydrated.message).toBe('constraint violated');
  });
});
