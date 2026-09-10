import {
  CorruptedEventLogError,
  EntityConflictError,
  RunExpiredError,
} from '@workflow/errors';
import type { WorkflowRun, World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { type CryptoKey, importKey } from '../encryption.js';
import { WorkflowSuspension } from '../global.js';
import {
  dehydrateStepArguments,
  hydrateStepArguments,
} from '../serialization.js';
import { handleSuspension } from './suspension-handler.js';
import {
  isUnserializableStepInputPlaceholder,
  UNSERIALIZABLE_STEP_INPUT_MARKER,
  unserializableStepInputPlaceholder,
} from './unserializable-step.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

const run: WorkflowRun = {
  runId: 'wrun_123',
  workflowName: 'test-workflow',
  status: 'running',
  input: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  startedAt: new Date(),
  deploymentId: 'test-deployment',
};

function createWorld(eventsCreate: ReturnType<typeof vi.fn>): World {
  return {
    events: {
      create: eventsCreate,
    },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_123' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;
}

describe('handleSuspension', () => {
  it('schedules an immediate continuation for hook.getConflict()-awaited creations', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: {
        eventType: 'hook_created',
      },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'hook_awaited',
        {
          type: 'hook' as const,
          correlationId: 'hook_awaited',
          token: 'claim-token',
          hasConflictAwaiter: true,
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'hook_created',
        correlationId: 'hook_awaited',
      }),
      expect.anything()
    );
    expect(result.timeoutSeconds).toBe(0);
  });

  it('still queues pending steps when an awaited hook is created with a step', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: {
        eventType: 'hook_created',
      },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'step_parallel',
        {
          type: 'step' as const,
          correlationId: 'step_parallel',
          stepName: 'parallelStep',
          args: [],
        },
      ],
      [
        'hook_awaited',
        {
          type: 'hook' as const,
          correlationId: 'hook_awaited',
          token: 'claim-token',
          hasConflictAwaiter: true,
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'step_created',
        correlationId: 'step_parallel',
      }),
      expect.anything()
    );
    expect(world.queue).toHaveBeenCalledWith(
      '__wkf_step_parallelStep',
      expect.objectContaining({ stepId: 'step_parallel' }),
      expect.anything()
    );
    expect(result.timeoutSeconds).toBe(0);
  });

  it('does not immediately continue after creating a hook without a getConflict awaiter', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: {
        eventType: 'hook_created',
      },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        'hook_payload',
        {
          type: 'hook' as const,
          correlationId: 'hook_payload',
          token: 'payload-token',
        },
      ],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(result.timeoutSeconds).toBeUndefined();
  });
});

describe('step-argument serialization failure', () => {
  // A value the workflow serializer cannot dehydrate: a class instance with
  // no registered serde model. Mirrors serialization.test.ts's unsupported
  // type coverage — dehydrateStepArguments throws.
  class Unserializable {
    secret = 'not-a-pojo';
  }

  function stepItem(id: string, args: unknown[] = []) {
    return {
      type: 'step' as const,
      correlationId: id,
      stepName: id,
      args,
    };
  }

  it('finalizes the step as step_created + step_failed instead of rejecting the suspension', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    // The suspension itself resolves — the failure is scoped to the step.
    expect(eventsCreate).toHaveBeenCalledTimes(2);
    const [createdCall, failedCall] = eventsCreate.mock.calls;
    expect(createdCall[1]).toMatchObject({
      eventType: 'step_created',
      correlationId: 's_bad',
      eventData: expect.objectContaining({
        stepName: 's_bad',
        workflowName: run.workflowName,
      }),
    });
    expect(failedCall[1]).toMatchObject({
      eventType: 'step_failed',
      correlationId: 's_bad',
      eventData: expect.objectContaining({
        stepName: 's_bad',
        error: expect.stringContaining('Failed to serialize step arguments'),
      }),
    });
    expect([...(result.failedStepCorrelationIds ?? [])]).toEqual(['s_bad']);
    // The step never runs, so no execution message is dispatched — the
    // handler instead schedules the immediate replay that observes the
    // step_failed event.
    expect(world.queue).not.toHaveBeenCalled();
    expect(result.timeoutSeconds).toBe(0);
  });

  it('writes a recoverable placeholder input, not a genuine-looking empty input', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    const createdEvent = eventsCreate.mock.calls[0][1];
    expect(createdEvent.eventType).toBe('step_created');
    const hydrated = await hydrateStepArguments(
      createdEvent.eventData.input,
      run.runId,
      undefined,
      []
    );
    expect(isUnserializableStepInputPlaceholder(hydrated)).toBe(true);
    expect((hydrated as { args: unknown[] }).args).toEqual([
      UNSERIALIZABLE_STEP_INPUT_MARKER,
    ]);
  });

  it('finalizes the bad step while healthy siblings are still queued', async () => {
    const eventsCreate = vi.fn().mockImplementation(async (_runId, event) => ({
      event,
    }));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
      ['s_good', stepItem('s_good', ['fine'])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect([...(result.failedStepCorrelationIds ?? [])]).toEqual(['s_bad']);
    expect(
      eventsCreate.mock.calls.map(([, event]) => [
        event.eventType,
        event.correlationId,
      ])
    ).toEqual(
      expect.arrayContaining([
        ['step_created', 's_bad'],
        ['step_failed', 's_bad'],
        ['step_created', 's_good'],
      ])
    );
    expect(world.queue).toHaveBeenCalledTimes(1);
    expect(world.queue).toHaveBeenCalledWith(
      '__wkf_step_s_good',
      expect.objectContaining({ stepId: 's_good' }),
      expect.anything()
    );
  });

  it('tolerates a concurrent handler having already finalized the step', async () => {
    // Both writes conflict: a concurrent replay hit the same deterministic
    // serialization failure and wrote step_created + step_failed first.
    const eventsCreate = vi
      .fn()
      .mockRejectedValue(new EntityConflictError('already exists'));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect([...(result.failedStepCorrelationIds ?? [])]).toEqual(['s_bad']);
  });

  it('skips finalization when the run has already finished', async () => {
    const eventsCreate = vi
      .fn()
      .mockRejectedValue(new RunExpiredError('run is gone'));
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    // Nothing to observe the failure — no replay is forced.
    expect(result.failedStepCorrelationIds?.size ?? 0).toBe(0);
    expect(result.timeoutSeconds).toBeUndefined();
  });

  it('rejects the suspension when step_failed cannot be written after step_created landed', async () => {
    // The two finalization writes are separate durable writes. If the second
    // fails transiently, the suspension must reject so the message
    // redelivers — leaving a lone placeholder step_created behind. Recovery
    // for that window lives in the step handler: the placeholder carries a
    // structural flag (see unserializable-step.ts) that the handler
    // completes as the intended step_failed instead of running user code
    // with placeholder arguments.
    const writeError = new Error('storage unavailable');
    const eventsCreate = vi
      .fn()
      .mockImplementationOnce(async (_runId, event) => ({ event }))
      .mockRejectedValueOnce(writeError);
    const world = createWorld(eventsCreate);
    const pending = new Map([
      ['s_bad', stepItem('s_bad', [new Unserializable()])],
    ]);

    await expect(
      handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
      })
    ).rejects.toBe(writeError);

    // The lone step_created that redelivery will find carries the
    // recoverable placeholder.
    expect(eventsCreate).toHaveBeenCalledTimes(2);
    const createdEvent = eventsCreate.mock.calls[0][1];
    expect(createdEvent.eventType).toBe('step_created');
    const hydrated = await hydrateStepArguments(
      createdEvent.eventData.input,
      run.runId,
      undefined,
      []
    );
    expect(isUnserializableStepInputPlaceholder(hydrated)).toBe(true);
  });
});

describe('duplicate step_created verification', () => {
  // Two replays that assign one correlation id to different `useStep` calls
  // race on the same `step_created`; the World keeps the first. The loser
  // must notice when the persisted step is not the invocation it is holding,
  // or its branch silently receives another call's result.
  const RUN_ID = run.runId;

  function stepItem(correlationId: string, stepName: string, args: unknown[]) {
    return { type: 'step' as const, correlationId, stepName, args };
  }

  async function persistedInput(
    args: unknown[],
    key?: CryptoKey,
    extra: Record<string, unknown> = {}
  ) {
    return dehydrateStepArguments(
      { args, closureVars: undefined, thisVal: undefined, ...extra },
      RUN_ID,
      key,
      globalThis
    );
  }

  function conflictingWorld(
    persisted: { stepName: string; input?: unknown } | Error,
    rawKey?: Uint8Array
  ) {
    const eventsCreate = vi
      .fn()
      .mockRejectedValue(new EntityConflictError('already exists'));
    const stepsGet =
      persisted instanceof Error
        ? vi.fn().mockRejectedValue(persisted)
        : vi.fn().mockResolvedValue({
            runId: RUN_ID,
            stepId: 's_1',
            status: 'pending',
            attempt: 0,
            ...persisted,
          });
    const world = {
      events: { create: eventsCreate },
      steps: { get: stepsGet },
      queue: vi.fn().mockResolvedValue({ messageId: 'msg_123' }),
      getEncryptionKeyForRun: vi.fn().mockResolvedValue(rawKey),
    } as unknown as World;
    return { world, eventsCreate, stepsGet };
  }

  async function suspend(world: World, item = stepItem('s_1', 'update', [42])) {
    return handleSuspension({
      suspension: new WorkflowSuspension(
        new Map([[item.correlationId, item]]),
        globalThis
      ),
      world,
      run,
    });
  }

  it('continues when the persisted step is the same invocation', async () => {
    const { world, stepsGet } = conflictingWorld({
      stepName: 'update',
      input: await persistedInput([42]),
    });

    await expect(suspend(world)).resolves.toBeDefined();

    expect(stepsGet).toHaveBeenCalledWith(RUN_ID, 's_1');
    // The step message still goes out: the winner's step is this step.
    expect(world.queue).toHaveBeenCalledWith(
      '__wkf_step_update',
      expect.objectContaining({ stepId: 's_1' }),
      expect.anything()
    );
  });

  it('fails the run when the persisted step has different arguments', async () => {
    const { world } = conflictingWorld({
      stepName: 'update',
      input: await persistedInput([43]),
    });

    await expect(suspend(world)).rejects.toThrow(CorruptedEventLogError);
    await expect(suspend(world)).rejects.toThrow(
      /s_1 \("update"\) was already created with different arguments/
    );
  });

  it('fails the run when the persisted step is a different step function', async () => {
    const { world } = conflictingWorld({
      stepName: 'somethingElse',
      input: await persistedInput([42]),
    });

    await expect(suspend(world)).rejects.toThrow(CorruptedEventLogError);
    await expect(suspend(world)).rejects.toThrow(
      /already created as "somethingElse", but this replay invoked "update"/
    );
  });

  it('compares encrypted inputs by plaintext, not ciphertext', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importKey(rawKey);
    // A separate encryption of the same arguments: different nonce, so
    // the stored bytes differ even though the input is identical.
    const { world } = conflictingWorld(
      { stepName: 'update', input: await persistedInput([42], key) },
      rawKey
    );

    await expect(suspend(world)).resolves.toBeDefined();

    const { world: mismatched } = conflictingWorld(
      { stepName: 'update', input: await persistedInput([43], key) },
      rawKey
    );
    await expect(suspend(mismatched)).rejects.toThrow(CorruptedEventLogError);
  });

  it('continues when the persisted step cannot be read', async () => {
    const { world } = conflictingWorld(new Error('steps.get unavailable'));

    await expect(suspend(world)).resolves.toBeDefined();
    expect(world.queue).toHaveBeenCalled();
  });

  it('continues when the persisted step has no input to compare', async () => {
    const { world } = conflictingWorld({ stepName: 'update' });

    await expect(suspend(world)).resolves.toBeDefined();
  });

  it('leaves a concurrent serialization failure to its own step_failed', async () => {
    // The winner could not serialize its arguments and recorded the
    // placeholder; that branch fails the step with the real error.
    const { world } = conflictingWorld({
      stepName: 'update',
      input: await dehydrateStepArguments(
        unserializableStepInputPlaceholder(),
        RUN_ID,
        undefined,
        globalThis
      ),
    });

    await expect(suspend(world)).resolves.toBeDefined();
  });
});
