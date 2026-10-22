import {
  EntityConflictError,
  FatalError,
  HookConflictError,
  RUN_ERROR_CODES,
  START_HOOK_ADMISSION_REJECTED,
  ThrottleError,
  WorkflowError,
  WorkflowRunNotFoundError,
  WorkflowRuntimeError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateStepArguments } from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import { DYNAMIC_WORKFLOWS_ENV } from './constants.js';
import { getWorkflowQueueName, healthCheck } from './helpers.js';
import {
  DEFAULT_START_HOOK_RETENTION_MS,
  normalizeStartHook,
  START_HOOK_CONFIRM_DELAYS_MS,
  start,
} from './start.js';
import {
  START_HOOK_HOLDER_WAKE_AFTER_MS,
  START_HOOK_HOLDER_WAKE_WINDOW_MS,
  startHookHolderWakeKey,
} from './start-hook-holder.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry.js')>()),
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
  getActiveSpan: vi.fn().mockResolvedValue(undefined),
}));

// The cross-deployment capability probe, answered directly.
vi.mock('./helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers.js')>()),
  healthCheck: vi.fn(),
}));

const workflow = { workflowId: 'workflow//./test//orders' };
const TOKEN = 'order:123';

let eventsCreate: ReturnType<typeof vi.fn>;
let queue: ReturnType<typeof vi.fn>;
let calls: string[];

/** A World that admits start Hooks, echoing the reservation. */
function admittingWorld(overrides: Record<string, unknown> = {}) {
  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
    capabilities: {
      atomicStartHook: { active: true },
      hookRetention: { active: true },
    },
    events: { create: eventsCreate },
    queue,
    ...overrides,
  } as any;
  setWorld(world);
  return world;
}

const accept = async (runId: string, event: any) => {
  calls.push('create');
  return {
    run: { runId, status: 'pending', startHook: event.eventData.startHook },
  };
};

beforeEach(() => {
  calls = [];
  eventsCreate = vi.fn(accept);
  queue = vi.fn(async () => {
    calls.push('queue');
  });
});

afterEach(() => {
  setWorld(undefined);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected start() to throw');
    },
    (error: unknown) => error
  );
}

describe('normalizeStartHook', () => {
  it.each([
    [''],
    [42],
    [undefined],
    [null],
  ])('rejects the token %j', (token) => {
    expect(() => normalizeStartHook({ token } as any)).toThrow(
      WorkflowRuntimeError
    );
  });

  it('resolves a duration to an absolute retention', () => {
    const before = Date.now();
    const { tokenRetentionUntil } = normalizeStartHook({
      token: TOKEN,
      experimental_minRetention: '1h',
    });
    expect(tokenRetentionUntil!.getTime()).toBeGreaterThanOrEqual(
      before + 3_600_000
    );
  });

  it('rejects a retention that is not in the future', () => {
    expect(() =>
      normalizeStartHook({
        token: TOKEN,
        experimental_minRetention: new Date(Date.now() - 1000),
      })
    ).toThrow(/future time/);
  });
});

describe('start({ hook })', () => {
  it('publishes the candidate first, then admits it, both carrying the reservation', async () => {
    admittingWorld();

    const run = await start(workflow, ['a'], { hook: { token: TOKEN } });

    expect(calls).toEqual(['queue', 'create']);
    const [runId, event] = eventsCreate.mock.calls[0];
    expect(run.runId).toBe(runId);
    expect(event.eventData.startHook.token).toBe(TOKEN);
    const payload = queue.mock.calls[0][1];
    expect(payload.runId).toBe(runId);
    expect(payload.runInput.startHook).toEqual(event.eventData.startHook);
  });

  describe('default retention', () => {
    it('keeps the token for 24 hours from start() by default', async () => {
      admittingWorld();
      const before = Date.now();

      await start(workflow, [], { hook: { token: TOKEN } });

      const { tokenRetentionUntil } =
        eventsCreate.mock.calls[0][1].eventData.startHook;
      expect(tokenRetentionUntil.getTime()).toBeGreaterThanOrEqual(
        before + DEFAULT_START_HOOK_RETENTION_MS
      );
      expect(tokenRetentionUntil.getTime()).toBeLessThanOrEqual(
        Date.now() + DEFAULT_START_HOOK_RETENTION_MS
      );
    });

    it('opts out with experimental_minRetention: 0', async () => {
      admittingWorld();

      await start(workflow, [], {
        hook: { token: TOKEN, experimental_minRetention: 0 },
      });

      expect(eventsCreate.mock.calls[0][1].eventData.startHook).toEqual({
        token: TOKEN,
      });
    });

    it('is skipped, not refused, on a World without Hook retention', async () => {
      admittingWorld({ capabilities: { atomicStartHook: { active: true } } });

      await start(workflow, [], { hook: { token: TOKEN } });

      expect(eventsCreate.mock.calls[0][1].eventData.startHook).toEqual({
        token: TOKEN,
      });
    });
  });

  it('serializes hook.metadata like createHook metadata', async () => {
    admittingWorld();

    await start(workflow, [], {
      hook: { token: TOKEN, metadata: { sessionId: 's_1' } },
    });

    const [runId, event] = eventsCreate.mock.calls[0];
    const { metadata } = event.eventData.startHook;
    expect(metadata).toBeInstanceOf(Uint8Array);
    expect(await hydrateStepArguments(metadata, runId, undefined)).toEqual({
      sessionId: 's_1',
    });
    expect(queue.mock.calls[0][1].runInput.startHook.metadata).toBe(metadata);
  });

  describe('inside a workflow step', () => {
    const inStep = <T>(fn: () => Promise<T>) =>
      contextStorage.run(
        {
          stepMetadata: {
            stepName: 'start',
            stepId: 'step_1',
            stepStartedAt: new Date(),
            attempt: 1,
          },
          workflowMetadata: {
            workflowName: 'parent',
            workflowRunId: 'wrun_parent',
            workflowStartedAt: new Date(),
            url: 'http://localhost:3000',
            features: { encryption: false },
          },
          ops: [],
        } as any,
        fn
      );

    it('makes a refusal final for the step, keeping its type', async () => {
      admittingWorld();
      eventsCreate.mockRejectedValue(
        new HookConflictError(TOKEN, 'wrun_owner')
      );

      const error = await rejection(
        inStep(() => start(workflow, [], { hook: { token: TOKEN } }))
      );

      expect(HookConflictError.is(error)).toBe(true);
      expect(FatalError.is(error)).toBe(true);
    });

    it('makes a permanent rejection final for the step', async () => {
      admittingWorld();
      eventsCreate.mockRejectedValue(
        new WorkflowWorldError('no', {
          status: 400,
          code: START_HOOK_ADMISSION_REJECTED,
        })
      );

      const error = await rejection(
        inStep(() => start(workflow, [], { hook: { token: TOKEN } }))
      );

      expect(FatalError.is(error)).toBe(true);
    });

    it('leaves an uncertain start retryable', async () => {
      admittingWorld();
      eventsCreate.mockRejectedValue(
        new WorkflowWorldError('down', { status: 503 })
      );

      const error = await rejection(
        inStep(() => start(workflow, [], { hook: { token: TOKEN } }))
      );

      expect(WorkflowStartError.is(error)).toBe(true);
      expect(FatalError.is(error)).toBe(false);
    });

    it('does not mark a refusal outside a workflow', async () => {
      admittingWorld();
      eventsCreate.mockRejectedValue(
        new HookConflictError(TOKEN, 'wrun_owner')
      );

      const error = await rejection(
        start(workflow, [], { hook: { token: TOKEN } })
      );

      expect(FatalError.is(error)).toBe(false);
    });
  });

  it('carries the retention as an absolute time', async () => {
    admittingWorld();
    const until = new Date(Date.now() + 60_000);

    await start(workflow, [], {
      hook: { token: TOKEN, experimental_minRetention: until },
    });

    expect(eventsCreate.mock.calls[0][1].eventData.startHook).toEqual({
      token: TOKEN,
      tokenRetentionUntil: until,
    });
  });

  it('refuses a World without the capability before writing anything', async () => {
    admittingWorld({ capabilities: { hookRetention: { active: true } } });

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(WorkflowWorldError.is(error)).toBe(true);
    expect(error).toMatchObject({ code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR });
    expect(queue).not.toHaveBeenCalled();
    expect(eventsCreate).not.toHaveBeenCalled();
  });

  it('refuses a retention on a World without Hook retention', async () => {
    admittingWorld({ capabilities: { atomicStartHook: { active: true } } });

    const error = await rejection(
      start(workflow, [], {
        hook: { token: TOKEN, experimental_minRetention: '1h' },
      })
    );

    expect(error).toMatchObject({ code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR });
    expect(queue).not.toHaveBeenCalled();
  });

  it('refuses a dynamic workflow', async () => {
    vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, '1');
    admittingWorld();

    const error = await rejection(
      start('async function w() { "use workflow"; }', [], {
        experimental_dynamic: { steps: {} },
        hook: { token: TOKEN },
      } as any)
    );

    expect((error as Error).message).toMatch(/not supported for dynamic/);
    expect(queue).not.toHaveBeenCalled();
  });

  it('throws the owner HookConflictError for a refused candidate', async () => {
    admittingWorld();
    eventsCreate.mockRejectedValue(new HookConflictError(TOKEN, 'wrun_owner'));

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(HookConflictError.is(error)).toBe(true);
    expect(error).toMatchObject({
      token: TOKEN,
      conflictingRunId: 'wrun_owner',
    });
  });

  describe('a refusal naming a holder', () => {
    const holderRun = (status: string, ageMs: number) => ({
      runId: 'wrun_owner',
      status,
      workflowName: 'workflow//./test//orders',
      deploymentId: 'dpl_owner',
      specVersion: 8,
      executionContext: { queueNamespace: 'eve' },
      createdAt: new Date(Date.now() - ageMs),
      updatedAt: new Date(),
    });

    function refusingWorld(get: ReturnType<typeof vi.fn>) {
      admittingWorld({ runs: { get } });
      eventsCreate.mockRejectedValue(
        new HookConflictError(TOKEN, 'wrun_owner')
      );
    }

    it('re-publishes a holder stuck pending, once per window, and still throws the conflict', async () => {
      const get = vi
        .fn()
        .mockResolvedValue(
          holderRun('pending', START_HOOK_HOLDER_WAKE_AFTER_MS + 1_000)
        );
      refusingWorld(get);

      const error = await rejection(
        start(workflow, [], { hook: { token: TOKEN } })
      );

      expect(HookConflictError.is(error)).toBe(true);
      expect(error).toMatchObject({ conflictingRunId: 'wrun_owner' });
      expect(get).toHaveBeenCalledWith('wrun_owner', { resolveData: 'none' });
      // The candidate's own publish, then the holder's wake.
      expect(queue).toHaveBeenCalledTimes(2);
      const [queueName, payload, opts] = queue.mock.calls[1];
      expect(queueName).toBe(
        getWorkflowQueueName('workflow//./test//orders', 'eve')
      );
      expect(queueName).toMatch(/^__eve_wkf_workflow_/);
      expect(payload).toEqual({ runId: 'wrun_owner', traceCarrier: {} });
      expect(payload).not.toHaveProperty('runInput');
      expect(opts).toEqual({
        deploymentId: 'dpl_owner',
        specVersion: 8,
        idempotencyKey: startHookHolderWakeKey('wrun_owner', Date.now()),
      });
    });

    it.each([
      ['running', 'running', START_HOOK_HOLDER_WAKE_AFTER_MS * 10],
      ['pending but starting normally', 'pending', 1_000],
      ['finished', 'completed', START_HOOK_HOLDER_WAKE_AFTER_MS * 10],
    ])('does not re-publish a holder that is %s', async (_label, status, age) => {
      refusingWorld(vi.fn().mockResolvedValue(holderRun(status, age)));

      const error = await rejection(
        start(workflow, [], { hook: { token: TOKEN } })
      );

      expect(HookConflictError.is(error)).toBe(true);
      expect(queue).toHaveBeenCalledTimes(1);
    });

    it('does not re-publish a holder that is not a run (an accepted orphan)', async () => {
      refusingWorld(
        vi.fn().mockRejectedValue(new WorkflowRunNotFoundError('wrun_owner'))
      );

      const error = await rejection(
        start(workflow, [], { hook: { token: TOKEN } })
      );

      expect(HookConflictError.is(error)).toBe(true);
      expect(queue).toHaveBeenCalledTimes(1);
    });

    it('keeps the conflict when the wake fails', async () => {
      refusingWorld(
        vi
          .fn()
          .mockResolvedValue(
            holderRun('pending', START_HOOK_HOLDER_WAKE_AFTER_MS + 1_000)
          )
      );
      queue.mockImplementation(async () => {
        calls.push('queue');
        if (calls.filter((c) => c === 'queue').length > 1) {
          throw new Error('queue down');
        }
      });

      const error = await rejection(
        start(workflow, [], { hook: { token: TOKEN } })
      );

      expect(HookConflictError.is(error)).toBe(true);
      expect(error).toMatchObject({ conflictingRunId: 'wrun_owner' });
    });

    it('buckets the wake key so concurrent refusals coalesce, and a later window wakes again', () => {
      const t = 1_800_000_000_000;
      expect(startHookHolderWakeKey('wrun_a', t)).toBe(
        startHookHolderWakeKey('wrun_a', t + 1)
      );
      expect(startHookHolderWakeKey('wrun_a', t)).not.toBe(
        startHookHolderWakeKey('wrun_a', t + START_HOOK_HOLDER_WAKE_WINDOW_MS)
      );
      // Never the original start message's key.
      expect(startHookHolderWakeKey('wrun_a', t)).not.toBe('start-wrun_a');
    });
  });

  it('calls a refusal without an owner a contract error', async () => {
    admittingWorld();
    eventsCreate.mockRejectedValue(new HookConflictError(TOKEN));

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(error).toMatchObject({ code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR });
  });

  it('calls EntityConflictError a contract error: admission must replay its decision', async () => {
    admittingWorld();
    eventsCreate.mockRejectedValue(new EntityConflictError('exists'));

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(error).toMatchObject({ code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR });
  });

  it.each([
    ['a 5xx', new WorkflowWorldError('down', { status: 503 })],
    [
      'a transport failure',
      new WorkflowWorldError('reset', { code: 'TRANSPORT' }),
    ],
    ['a non-World error', new Error('socket hang up')],
  ])('reports an uncertain queue on %s, without admitting', async (_label, cause) => {
    admittingWorld();
    queue.mockRejectedValue(cause);

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(WorkflowStartError.is(error)).toBe(true);
    expect(error).toMatchObject({ stage: 'queue', cause });
    expect((error as WorkflowStartError).runId).toMatch(/^wrun_/);
    expect(eventsCreate).not.toHaveBeenCalled();
  });

  it('is a WorkflowError, never a World error a caller would call permanent', async () => {
    admittingWorld();
    queue.mockRejectedValue(new WorkflowWorldError('down', { status: 503 }));

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(WorkflowStartError.is(error)).toBe(true);
    expect(error).toBeInstanceOf(WorkflowError);
    expect(error).not.toBeInstanceOf(WorkflowWorldError);
    expect(WorkflowWorldError.is(error)).toBe(false);
  });

  it.each([
    ['queue', 'a 5xx', () => new WorkflowWorldError('down', { status: 503 })],
    ['queue', 'a non-World error', () => new Error('socket hang up')],
    [
      'run_created',
      'a 5xx',
      () => new WorkflowWorldError('down', { status: 500 }),
    ],
    [
      'run_created',
      'a timeout',
      () => new WorkflowWorldError('slow', { code: 'TIMEOUT' }),
    ],
  ])('never throws it from a start without a hook (%s fails with %s)', async (failing, _label, makeError) => {
    admittingWorld();
    if (failing === 'queue') queue.mockRejectedValue(makeError());
    else eventsCreate.mockRejectedValue(makeError());

    const outcome = await start(workflow, []).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(WorkflowStartError.is(outcome)).toBe(false);
  });

  it('rethrows a permanent queue refusal as-is', async () => {
    admittingWorld();
    const cause = new WorkflowWorldError('bad', { status: 400 });
    queue.mockRejectedValue(cause);

    expect(
      await rejection(start(workflow, [], { hook: { token: TOKEN } }))
    ).toBe(cause);
  });

  it.each([
    ['a 5xx', new WorkflowWorldError('down', { status: 500 })],
    ['contention', new ThrottleError('busy')],
    ['a timeout', new WorkflowWorldError('slow', { code: 'TIMEOUT' })],
  ])('reports an uncertain admission on %s', async (_label, cause) => {
    admittingWorld();
    eventsCreate.mockRejectedValue(cause);

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(WorkflowStartError.is(error)).toBe(true);
    expect(error).toMatchObject({ stage: 'admission' });
    expect((error as WorkflowStartError).runId).toBe(
      queue.mock.calls[0][1].runId
    );
  });

  it('rethrows a permanent admission rejection as-is', async () => {
    admittingWorld();
    const cause = new WorkflowWorldError('disabled', {
      status: 400,
      code: START_HOOK_ADMISSION_REJECTED,
    });
    eventsCreate.mockRejectedValue(cause);

    expect(
      await rejection(start(workflow, [], { hook: { token: TOKEN } }))
    ).toBe(cause);
  });

  it('refuses to report success when the World did not echo the reservation', async () => {
    admittingWorld();
    eventsCreate.mockImplementation(async (runId: string) => ({
      run: { runId, status: 'pending' },
    }));

    const error = await rejection(
      start(workflow, [], { hook: { token: TOKEN } })
    );

    expect(error).toMatchObject({ code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR });
    expect((error as Error).message).toMatch(/did not confirm reserving/);
  });

  describe('stream arguments', () => {
    /** A one-shot source that records whether it was ever read. */
    function oneShotSource() {
      const reads = { count: 0 };
      const stream = new ReadableStream<string>(
        {
          pull(controller) {
            reads.count++;
            controller.enqueue('webhook body');
            controller.close();
          },
        },
        { highWaterMark: 0 }
      );
      return { stream, reads };
    }

    function streamWorld() {
      const streams = {
        write: vi.fn().mockResolvedValue(undefined),
        writeMulti: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
      };
      admittingWorld({ streams });
      return streams;
    }

    it.each([
      ['refused', () => new HookConflictError(TOKEN, 'wrun_owner')],
      ['uncertain', () => new WorkflowWorldError('down', { status: 503 })],
    ])('never reads a %s candidate stream argument', async (_label, error) => {
      const streams = streamWorld();
      eventsCreate.mockRejectedValue(error());
      const { stream, reads } = oneShotSource();

      await start(workflow, [stream], { hook: { token: TOKEN } }).catch(
        () => {}
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(reads.count).toBe(0);
      expect(stream.locked).toBe(false);
      expect(streams.write).not.toHaveBeenCalled();
      expect(streams.close).not.toHaveBeenCalled();
    });

    it('never opens the readback into a refused candidate writable argument', async () => {
      const streams = streamWorld();
      eventsCreate.mockRejectedValue(
        new HookConflictError(TOKEN, 'wrun_owner')
      );
      const sink = new WritableStream<string>();

      await start(workflow, [sink], { hook: { token: TOKEN } }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sink.locked).toBe(false);
      expect(streams.get).not.toHaveBeenCalled();
    });

    it('confirms an admission whose response was lost in place, then pipes the stream', async () => {
      const streams = streamWorld();
      // The first run_created commits, but its answer never arrives; the
      // re-post replays the acceptance.
      eventsCreate
        .mockRejectedValueOnce(
          new WorkflowWorldError('reset', { code: 'TRANSPORT' })
        )
        .mockImplementation(accept);
      const { stream, reads } = oneShotSource();

      const run = await start(workflow, [stream], { hook: { token: TOKEN } });

      expect(run.runId).toBe(queue.mock.calls[0][1].runId);
      expect(eventsCreate).toHaveBeenCalledTimes(2);
      expect(eventsCreate.mock.calls[1][0]).toBe(run.runId);
      await vi.waitFor(() => expect(reads.count).toBe(1));
      await vi.waitFor(() => expect(streams.close).toHaveBeenCalled());
    });

    it('learns a refusal on the in-place re-post and never reads the stream', async () => {
      const streams = streamWorld();
      eventsCreate
        .mockRejectedValueOnce(new WorkflowWorldError('down', { status: 503 }))
        .mockRejectedValue(new HookConflictError(TOKEN, 'wrun_owner'));
      const { stream, reads } = oneShotSource();

      const error = await rejection(
        start(workflow, [stream], { hook: { token: TOKEN } })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(HookConflictError.is(error)).toBe(true);
      expect(reads.count).toBe(0);
      expect(streams.write).not.toHaveBeenCalled();
    });

    it('decides a streamed candidate whose queue publish was uncertain, and publishes it again', async () => {
      const streams = streamWorld();
      queue
        .mockRejectedValueOnce(
          new WorkflowWorldError('reset', { code: 'TRANSPORT' })
        )
        .mockResolvedValue(undefined);
      const { stream, reads } = oneShotSource();

      const run = await start(workflow, [stream], { hook: { token: TOKEN } });

      expect(queue).toHaveBeenCalledTimes(2);
      expect(queue.mock.calls[1][1].runId).toBe(run.runId);
      await vi.waitFor(() => expect(reads.count).toBe(1));
      await vi.waitFor(() => expect(streams.close).toHaveBeenCalled());
    });

    it('throws WorkflowStartError once the re-posts stay uncertain', async () => {
      streamWorld();
      eventsCreate.mockRejectedValue(
        new WorkflowWorldError('down', { status: 503 })
      );
      const { stream } = oneShotSource();

      const error = await rejection(
        start(workflow, [stream], { hook: { token: TOKEN } })
      );

      expect(WorkflowStartError.is(error)).toBe(true);
      expect(error).toMatchObject({ stage: 'admission' });
      expect(eventsCreate).toHaveBeenCalledTimes(
        START_HOOK_CONFIRM_DELAYS_MS.length + 1
      );
    });

    it('pipes the stream only once the candidate is admitted', async () => {
      const streams = streamWorld();
      let admit!: () => void;
      eventsCreate.mockImplementation(
        (runId: string, event: any) =>
          new Promise((resolve) => {
            admit = () => resolve(accept(runId, event));
          })
      );
      const { stream, reads } = oneShotSource();

      const pending = start(workflow, [stream], { hook: { token: TOKEN } });
      await vi.waitFor(() => expect(eventsCreate).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reads.count).toBe(0);

      admit();
      await pending;
      await vi.waitFor(() => expect(reads.count).toBe(1));
      await vi.waitFor(() => expect(streams.close).toHaveBeenCalled());
    });
  });

  describe('cross-deployment', () => {
    it('refuses without probing when the World has no probe channel', async () => {
      admittingWorld();

      const startedAt = Date.now();
      const error = await rejection(
        start(workflow, [], {
          deploymentId: 'dpl_other',
          hook: { token: TOKEN },
        })
      );

      expect(error).toMatchObject({
        code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
      expect(healthCheck).not.toHaveBeenCalled();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(queue).not.toHaveBeenCalled();
    });

    it('keeps an ordinary start to a World with no probe channel synchronous', async () => {
      admittingWorld();
      eventsCreate.mockImplementation(async (runId: string) => ({
        run: { runId, status: 'pending' },
      }));

      await start(workflow, [], { deploymentId: 'dpl_other' });

      expect(healthCheck).not.toHaveBeenCalled();
    });

    const probedWorld = () =>
      admittingWorld({ streams: { get: vi.fn(), write: vi.fn() } });

    it('refuses a target whose probe answered without the capability', async () => {
      probedWorld();
      vi.mocked(healthCheck).mockResolvedValue({
        healthy: true,
        format: 'json',
        specVersion: SPEC_VERSION_CURRENT,
        capabilities: { hookRetention: { active: true } },
      });

      const error = await rejection(
        start(workflow, [], {
          deploymentId: 'dpl_other',
          hook: { token: TOKEN },
        })
      );

      expect(error).toMatchObject({
        code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
      expect((error as Error).message).toMatch(/dpl_other/);
      expect(eventsCreate).not.toHaveBeenCalled();
    });

    it('reports a probe that did not answer as retryable, not as a contract error', async () => {
      probedWorld();
      vi.mocked(healthCheck).mockResolvedValue({
        healthy: false,
        error: 'Health check timed out after 10000ms',
      });

      const error = await rejection(
        start(workflow, [], {
          deploymentId: 'dpl_other',
          hook: { token: TOKEN },
        })
      );

      expect(WorkflowWorldError.is(error)).toBe(true);
      expect(error).toMatchObject({ code: 'TIMEOUT' });
      expect(queue).not.toHaveBeenCalled();
    });

    it('admits on a target that advertises the capability', async () => {
      probedWorld();
      vi.mocked(healthCheck).mockResolvedValue({
        healthy: true,
        format: 'json',
        specVersion: SPEC_VERSION_CURRENT,
        capabilities: { atomicStartHook: { active: true } },
      });

      await start(workflow, [], {
        deploymentId: 'dpl_other',
        hook: { token: TOKEN },
      });

      expect(calls).toEqual(['queue', 'create']);
    });
  });
});
