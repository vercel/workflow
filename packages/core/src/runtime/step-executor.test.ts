import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EntityConflictError,
  FatalError,
  RetryableError,
} from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  World,
} from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_POLL_INTERVAL_MS } from '../flushable-stream.js';
import { runtimeLogger } from '../logger.js';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments, hydrateStepError } from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import { getWritable } from '../step/writable-stream.js';
import { STREAM_NAME_SYMBOL, STREAM_SERVER_RUN_ID_SYMBOL } from '../symbols.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import {
  executeStep,
  failStepForExhaustedRetries,
  type StepEventWriter,
} from './step-executor.js';
import {
  UNSERIALIZABLE_STEP_INPUT_MARKER,
  unserializableStepInputPlaceholder,
} from './unserializable-step.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const RUN = 'wrun_executor';

registerStepFunction('exec_ok', async (n: number) => n * 2);
registerStepFunction('exec_retry', async () => {
  throw new RetryableError('later', {
    retryAfter: new Date(Date.now() + 60_000),
  });
});

function recordingWriter(failOn?: string) {
  const written: CreateEventRequest[] = [];
  const createEvent: StepEventWriter = async (data) => {
    if (data.eventType === failOn) {
      throw new EntityConflictError('refused');
    }
    written.push(data);
    return {
      event: {
        ...data,
        runId: RUN,
        eventId: `evnt_${written.length}`,
        createdAt: new Date(),
      } as Event,
    };
  };
  return { written, createEvent };
}

const world = {
  getEncryptionKeyForRun: async () => undefined,
} as unknown as World;

async function input(args: unknown[]) {
  return (await dehydrateStepArguments({ args }, RUN, undefined)) as Uint8Array;
}

const base = {
  world,
  workflowRunId: RUN,
  workflowName: 'workflow',
  workflowStartedAt: Date.now(),
  stepId: 'step_a',
};

describe('executeStep', () => {
  it('writes stepName, attempt and startReason on step_started and the outcome', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_ok',
      attempt: 2,
      startReason: 'redelivery',
      input: await input([21]),
    });
    expect(result.type).toBe('completed');
    expect(written.map((e) => e.eventType)).toEqual([
      'step_started',
      'step_completed',
    ]);
    expect(written[0]).toMatchObject({
      eventData: { stepName: 'exec_ok', attempt: 2, startReason: 'redelivery' },
    });
    expect(written[1]).toMatchObject({ eventData: { stepName: 'exec_ok' } });
  });

  it('writes no start of its own when the caller already started the attempt', async () => {
    const { written, createEvent } = recordingWriter();
    await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_ok',
      attempt: 1,
      startReason: 'first',
      input: await input([1]),
      started: { startedAt: new Date() },
    });
    expect(written.map((e) => e.eventType)).toEqual(['step_completed']);
  });

  it('writes step_retrying with the attempt and retryAfter, and asks for the delay', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_retry',
      attempt: 1,
      startReason: 'first',
      input: await input([]),
    });
    expect(result.type).toBe('retry');
    expect(written[1]).toMatchObject({
      eventType: 'step_retrying',
      eventData: {
        stepName: 'exec_retry',
        attempt: 1,
        retryAfter: expect.any(Date),
      },
    });
    if (result.type === 'retry') {
      expect(result.timeoutSeconds).toBeGreaterThan(50);
    }
  });

  it('fails the step instead of retrying past its message retention', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_retry',
      attempt: 1,
      startReason: 'first',
      input: await input([]),
      retryOutlivesMessage: () => true,
    });
    expect(result.type).toBe('failed');
    expect(written.map((e) => e.eventType)).toEqual([
      'step_started',
      'step_failed',
    ]);
    expect(written[1]).toMatchObject({ eventData: { attempt: 1 } });
  });

  it('never reads a refusal as "someone else ran it"', async () => {
    const { createEvent } = recordingWriter('step_started');
    await expect(
      executeStep({
        ...base,
        createEvent,
        stepName: 'exec_ok',
        attempt: 1,
        startReason: 'first',
        input: await input([1]),
      })
    ).rejects.toThrow(EntityConflictError);
  });

  it('does not run the body when beforeBody throws', async () => {
    const { written, createEvent } = recordingWriter();
    const body = vi.fn();
    registerStepFunction('exec_guarded', body);
    await expect(
      executeStep({
        ...base,
        createEvent,
        stepName: 'exec_guarded',
        attempt: 1,
        startReason: 'first',
        input: await input([]),
        beforeBody: () => {
          throw new Error('superseded');
        },
      })
    ).rejects.toThrow('superseded');
    expect(body).not.toHaveBeenCalled();
    expect(written.map((e) => e.eventType)).toEqual(['step_started']);
  });

  it('fails a step for exhausted retries without running it', async () => {
    const { written, createEvent } = recordingWriter();
    const result = await failStepForExhaustedRetries({
      createEvent,
      workflowRunId: RUN,
      stepId: 'step_a',
      stepName: 'exec_ok',
      attempt: 2,
      maxRetries: 0,
      encryptionKey: undefined,
    });
    expect(result.type).toBe('failed');
    expect(written).toEqual([
      expect.objectContaining({
        eventType: 'step_failed',
        eventData: expect.objectContaining({ attempt: 2 }),
      }),
    ]);
  });
});

// --- Executor behavior against a World with streams (world-local) ---------
//
// The executor's writes go through the caller's writer; here a plain
// out-of-band writer over world-local, as a background step's handler uses.

const MAX_RETRIES = 3; // maxRetries + 1 = 4 attempts allowed

let counter = 0;
function uniqueStepName(): string {
  counter += 1;
  return `step//./step-executor-test//localStep${counter}`;
}

function makeLocalWorld(): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-step-executor-'));
  return createWorld({ dataDir, tag: `t${counter}` });
}

/**
 * Writes run_created, run_started and the step's step_created, and returns
 * what `executeStep` needs to run that step.
 */
async function setupStep(
  world: World,
  stepName: string,
  options: { input?: unknown } = {}
) {
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: 'wf',
      input: await dehydrateStepArguments([], 'run', undefined),
    },
  });
  const runId = created.run!.runId;
  await world.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {},
  } as never);
  const stepId = `step_local_${counter}`;
  const stepInput = (await dehydrateStepArguments(
    options.input ?? { args: [], closureVars: undefined, thisVal: undefined },
    runId,
    undefined
  )) as Uint8Array;
  await world.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: { stepName, input: stepInput },
  });
  const createEvent: StepEventWriter = (data, params) =>
    world.events.create(runId, data, params);
  return {
    runId,
    stepId,
    params: {
      world,
      createEvent,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      attempt: 1,
      startReason: 'first' as const,
      input: stepInput,
    },
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

async function runWritableStep(options: {
  releaseLock: boolean;
  awaitWrite?: boolean;
  delayBeforeWriterMs?: number;
  closeAfterRelease?: boolean;
  writeImpl?: () => Promise<void>;
  session?: ReturnType<NonNullable<World['streams']['createWriteSession']>>;
  throwAfterRelease?: boolean;
}) {
  const world = makeLocalWorld();
  setWorld(world);
  if (options.session)
    world.streams.createWriteSession = () => options.session!;
  if (options.writeImpl) {
    world.streams.write = vi.fn(
      options.writeImpl
    ) as typeof world.streams.write;
  }
  const stepName = uniqueStepName();
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
  const { runId, stepId, params } = await setupStep(world, stepName);
  return { execution: executeStep(params), world, runId, stepId };
}

describe('executeStep — stream durability barrier', () => {
  afterEach(() => {
    setWorld(undefined);
    delete process.env.WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS;
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    const writeGate = withResolvers<void>();
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      writeImpl: () => writeGate.promise,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);
    writeGate.resolve();
    await expect(execution).resolves.toMatchObject({
      type: 'completed',
      hasPendingOps: false,
    });
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(1);
  });

  it('does not durably block a step that keeps its writer lock', async () => {
    const writeGate = withResolvers<void>();
    const { execution } = await runWritableStep({
      releaseLock: false,
      awaitWrite: false,
      writeImpl: () => writeGate.promise,
    });
    await expect(execution).resolves.toMatchObject({
      type: 'completed',
      hasPendingOps: true,
    });
    writeGate.resolve();
  });

  it('does not settle before the step acquires and releases its writer', async () => {
    const writeGate = withResolvers<void>();
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      delayBeforeWriterMs: LOCK_POLL_INTERVAL_MS * 3,
      writeImpl: () => writeGate.promise,
    });
    await new Promise((resolve) =>
      setTimeout(resolve, LOCK_POLL_INTERVAL_MS * 5)
    );
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);
    writeGate.resolve();
    await expect(execution).resolves.toMatchObject({ type: 'completed' });
  });

  it('orders unsettled writes before the release checkpoint', async () => {
    const writeGate = withResolvers<void>();
    const { execution, world, runId, stepId } = await runWritableStep({
      releaseLock: true,
      awaitWrite: false,
      writeImpl: () => writeGate.promise,
    });
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);
    writeGate.resolve();
    await expect(execution).resolves.toMatchObject({ type: 'completed' });
  });

  it('drains a revived forwarded writable argument before completion', async () => {
    const writeGate = withResolvers<void>();
    const world = makeLocalWorld();
    setWorld(world);
    world.streams.write = vi.fn(
      () => writeGate.promise
    ) as typeof world.streams.write;
    const forwarded = new WritableStream<string>();
    Object.defineProperty(forwarded, STREAM_NAME_SYMBOL, {
      value: 'strm_forwarded',
    });
    Object.defineProperty(forwarded, STREAM_SERVER_RUN_ID_SYMBOL, {
      value: 'wrun_forwarded_owner',
    });
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async (writable: WritableStream<string>) => {
      const writer = writable.getWriter();
      await writer.write('forwarded snapshot');
      writer.releaseLock();
      return 'ok';
    });
    const { runId, stepId, params } = await setupStep(world, stepName, {
      input: { args: [forwarded], closureVars: undefined, thisVal: undefined },
    });
    const execution = executeStep(params);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);
    writeGate.resolve();
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
    const world = makeLocalWorld();
    setWorld(world);
    const backgroundOp = withResolvers<void>();
    const closeGate = withResolvers<void>();
    const closeStarted = withResolvers<void>();
    const settlementStarted = withResolvers<void>();
    const close = world.streams.close.bind(world.streams);
    world.streams.close = vi.fn(async (...args: Parameters<typeof close>) => {
      closeStarted.resolve();
      await closeGate.promise;
      return close(...args);
    });
    const stepName = uniqueStepName();
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
    const { runId, stepId, params } = await setupStep(world, stepName);
    const written: string[] = [];
    const createEvent: StepEventWriter = (data, p) => {
      written.push(data.eventType);
      return params.createEvent(data, p);
    };
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const execution = executeStep({ ...params, createEvent });
    try {
      await Promise.all([closeStarted.promise, settlementStarted.promise]);
      // Expire the 500ms ops heuristic while the durability barrier is held.
      await vi.advanceTimersByTimeAsync(500);
      expect(written).not.toContain('step_completed');
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
    }
  });

  it('bounds a throwing step drain and preserves the user error on retry', async () => {
    process.env.WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS = '400';
    const world = makeLocalWorld();
    setWorld(world);
    const writeGate = withResolvers<void>();
    const settlementStarted = withResolvers<void>();
    const released = withResolvers<void>();
    world.streams.createWriteSession = () => ({
      write: () => writeGate.promise,
      close: async () => {},
      release: () => released.resolve(),
    });
    const stepName = uniqueStepName();
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
    const { runId, stepId, params } = await setupStep(world, stepName);
    const written: string[] = [];
    const createEvent: StepEventWriter = (data, p) => {
      written.push(data.eventType);
      return params.createEvent(data, p);
    };
    const warn = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const execution = executeStep({ ...params, createEvent });
    try {
      await settlementStarted.promise;
      await vi.advanceTimersByTimeAsync(399);
      expect(written).not.toContain('step_retrying');
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
    const writeGate = withResolvers<void>();
    const world = makeLocalWorld();
    setWorld(world);
    world.streams.write = vi.fn(async (_runId, name) => {
      if (name.endsWith('_aborted')) {
        throw Object.assign(new Error('client disconnected'), {
          name: 'AbortError',
        });
      }
      await writeGate.promise;
    }) as typeof world.streams.write;
    const stepName = uniqueStepName();
    registerStepFunction(stepName, async () => {
      const aborted = getWritable<string>({ namespace: 'aborted' }).getWriter();
      const durable = getWritable<string>({ namespace: 'durable' }).getWriter();
      await aborted.write('a');
      await durable.write('b');
      aborted.releaseLock();
      durable.releaseLock();
      return 'ok';
    });
    const { runId, stepId, params } = await setupStep(world, stepName);
    const execution = executeStep(params);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await eventsFor(world, runId, stepId, 'step_completed')
    ).toHaveLength(0);
    writeGate.resolve();
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

describe('executeStep — the last allowed attempt', () => {
  let bodyRuns = 0;
  function registerFailing(): string {
    const stepName = uniqueStepName();
    registerStepFunction(
      stepName,
      Object.assign(
        async () => {
          bodyRuns++;
          throw new Error('still broken');
        },
        { maxRetries: MAX_RETRIES }
      )
    );
    return stepName;
  }

  beforeEach(() => {
    bodyRuns = 0;
  });

  it('runs attempt maxRetries + 1 and fails the step when it throws', async () => {
    const world = makeLocalWorld();
    const stepName = registerFailing();
    const { runId, stepId, params } = await setupStep(world, stepName);
    const result = await executeStep({
      ...params,
      attempt: MAX_RETRIES + 1,
      startReason: 'retry',
    });
    expect(result.type).toBe('failed');
    expect(bodyRuns).toBe(1);
    expect(await eventsFor(world, runId, stepId, 'step_started')).toHaveLength(
      1
    );
    expect(await eventsFor(world, runId, stepId, 'step_retrying')).toHaveLength(
      0
    );
    const [failed] = await eventsFor(world, runId, stepId, 'step_failed');
    const error = (await hydrateStepError(
      (failed.eventData as { error: unknown }).error,
      runId,
      undefined
    )) as Error;
    expect(error.message).toContain(`failed after ${MAX_RETRIES} retries`);
    expect(error.message).toContain('still broken');
  });

  it('retries attempt maxRetries when it throws', async () => {
    const world = makeLocalWorld();
    const stepName = registerFailing();
    const { runId, stepId, params } = await setupStep(world, stepName);
    const result = await executeStep({
      ...params,
      attempt: MAX_RETRIES,
      startReason: 'retry',
    });
    expect(result.type).toBe('retry');
    expect(bodyRuns).toBe(1);
    expect(await eventsFor(world, runId, stepId, 'step_failed')).toHaveLength(
      0
    );
  });
});

describe('executeStep — request and compute provenance', () => {
  function capture() {
    const calls: Array<{
      data: CreateEventRequest;
      params?: CreateEventParams;
    }> = [];
    const createEvent: StepEventWriter = async (data, params) => {
      calls.push({ data, params });
      return {
        event: {
          ...data,
          runId: RUN,
          eventId: `evnt_${calls.length}`,
          createdAt: new Date(),
        } as Event,
      };
    };
    return { calls, createEvent };
  }

  it('stamps request and compute provenance on step_started', async () => {
    const { calls, createEvent } = capture();
    await executeStep({
      ...base,
      createEvent,
      requestId: 'req_step_executor',
      stepName: 'exec_ok',
      attempt: 1,
      startReason: 'first',
      input: await input([1]),
    });
    const started = calls.find((c) => c.data.eventType === 'step_started');
    expect(started?.params).toMatchObject({
      requestId: 'req_step_executor',
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
  });

  it.each([
    ['empty', ''],
    ['unavailable', undefined],
  ])('omits a requestId that is %s', async (_label, requestId) => {
    const { calls, createEvent } = capture();
    await executeStep({
      ...base,
      createEvent,
      requestId,
      stepName: 'exec_ok',
      attempt: 1,
      startReason: 'first',
      input: await input([1]),
    });
    const started = calls.find((c) => c.data.eventType === 'step_started');
    expect(started?.params).toMatchObject({
      computeInstanceId: COMPUTE_INSTANCE_ID,
    });
    expect(started?.params).not.toHaveProperty('requestId');
  });

  it('names no log position on any of its own writes', async () => {
    // A position (`eventCount`) asks the World for a skipped-slot report. The
    // executor has no loaded log to merge one into; only the orchestrator's
    // in-band writer names positions, through the params it passes in.
    const { calls, createEvent } = capture();
    await executeStep({
      ...base,
      createEvent,
      stepName: 'exec_ok',
      attempt: 1,
      startReason: 'first',
      input: await input([1]),
    });
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.params?.eventCount === undefined)).toBe(true);
  });

  it('fails an unregistered step with only a step_failed, never running a start', async () => {
    const { calls, createEvent } = capture();
    const result = await executeStep({
      ...base,
      createEvent,
      stepName: 'step//./step-executor-test//neverRegistered',
      attempt: 2,
      startReason: 'retry',
      input: await input([]),
    });
    expect(result.type).toBe('failed');
    expect(calls.map((c) => c.data.eventType)).toEqual(['step_failed']);
    expect(calls[0]?.data).toMatchObject({ eventData: { attempt: 2 } });
  });
});

describe('executeStep — unserializable-argument placeholder guard', () => {
  it('fails the step without running the body when the stored input is the finalization placeholder', async () => {
    // A crash between the placeholder step_created and its step_failed leaves
    // the placeholder as the step's input. The executor completes the
    // intended failure instead of running user code with it.
    const world = makeLocalWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    registerStepFunction(stepName, async () => {
      bodyRuns++;
      return 'ok';
    });
    const { runId, stepId, params } = await setupStep(world, stepName, {
      input: unserializableStepInputPlaceholder(),
    });
    const result = await executeStep(params);
    expect(result.type).toBe('failed');
    expect(bodyRuns).toBe(0);
    expect(await eventsFor(world, runId, stepId, 'step_retrying')).toHaveLength(
      0
    );
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
    const world = makeLocalWorld();
    const stepName = uniqueStepName();
    let bodyRuns = 0;
    registerStepFunction(stepName, async () => {
      bodyRuns++;
      return 'ok';
    });
    const { params } = await setupStep(world, stepName, {
      input: {
        args: [UNSERIALIZABLE_STEP_INPUT_MARKER],
        closureVars: [],
        thisVal: undefined,
      },
    });
    const result = await executeStep(params);
    expect(result.type).toBe('completed');
    expect(bodyRuns).toBe(1);
  });
});

describe('executeStep — thrown errors with a read-only stack', () => {
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
    const world = makeLocalWorld();
    const stepName = uniqueStepName();
    registerStepFunction(
      stepName,
      Object.assign(
        async () => {
          throw makeError();
        },
        { maxRetries: MAX_RETRIES }
      )
    );
    const { runId, stepId, params } = await setupStep(world, stepName);
    const result = await executeStep(params);
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
