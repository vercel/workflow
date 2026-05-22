import {
  EntityConflictError,
  FatalError,
  WorkflowRunFailedError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';
import type { Event, World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { registerSerializationClass } from '../class-serialization.js';
import {
  dehydrateRunError,
  dehydrateStepReturnValue,
  hydrateStepReturnValue,
} from '../serialization.js';
import { Run } from './run.js';
import { wakeUpRun } from './runs.js';
import { setWorld } from './world.js';

function createMockWorld(
  overrides: {
    run?: Partial<
      ReturnType<World['runs']['get']> extends Promise<infer T> ? T : never
    >;
    events?: Event[];
    createError?: Error;
  } = {}
): World {
  const run = {
    runId: 'wrun_123',
    workflowName: 'test-workflow',
    status: 'running' as const,
    specVersion: 2,
    input: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
    deploymentId: 'test-deployment',
    ...overrides.run,
  };

  const events = overrides.events ?? [];

  return {
    runs: {
      get: vi.fn().mockResolvedValue(run),
    },
    events: {
      list: vi.fn().mockResolvedValue({
        data: events,
        hasMore: false,
        cursor: null,
      }),
      create: overrides.createError
        ? vi.fn().mockRejectedValue(overrides.createError)
        : vi.fn().mockResolvedValue({ event: {} }),
    },
    queue: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;
}

describe('wakeUpRun', () => {
  it('should count 409 conflict as a successful stop', async () => {
    const events: Event[] = [
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_abc',
        eventData: { resumeAt: new Date('2024-01-01T00:00:01.000Z') },
        createdAt: new Date(),
      },
    ];

    const conflict = new EntityConflictError('Wait already completed');

    const world = createMockWorld({ events, createError: conflict });
    const result = await wakeUpRun(world, 'wrun_123');

    expect(result.stoppedCount).toBe(1);
    expect(world.queue).toHaveBeenCalled();
  });

  it('should throw for non-409 errors', async () => {
    const events: Event[] = [
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_abc',
        eventData: { resumeAt: new Date('2024-01-01T00:00:01.000Z') },
        createdAt: new Date(),
      },
    ];

    const serverError = new WorkflowWorldError('Internal server error', {
      status: 500,
    });

    const world = createMockWorld({ events, createError: serverError });

    await expect(wakeUpRun(world, 'wrun_123')).rejects.toThrow(AggregateError);
  });
});

describe('Run.exists', () => {
  afterEach(() => {
    setWorld(undefined as unknown as World);
  });

  it('should return true when the run exists', async () => {
    const world = createMockWorld();
    setWorld(world);

    const run = new Run('wrun_123');
    const result = await run.exists;

    expect(result).toBe(true);
  });

  it('should return false when the run does not exist', async () => {
    const world = createMockWorld();
    (world.runs.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new WorkflowRunNotFoundError('wrun_nonexistent')
    );
    setWorld(world);

    const run = new Run('wrun_nonexistent');
    const result = await run.exists;

    expect(result).toBe(false);
  });

  it('should re-throw non-WorkflowRunNotFoundError errors', async () => {
    const world = createMockWorld();
    (world.runs.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Internal server error')
    );
    setWorld(world);

    const run = new Run('wrun_123');
    await expect(run.exists).rejects.toThrow('Internal server error');
  });
});

describe('Run.wakeUp', () => {
  afterEach(() => {
    setWorld(undefined as unknown as World);
  });

  it('should delegate to wakeUpRun with default options', async () => {
    const events: Event[] = [
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_abc',
        eventData: { resumeAt: new Date('2024-01-01T00:00:01.000Z') },
        createdAt: new Date(),
      },
    ];

    const world = createMockWorld({ events });
    setWorld(world);

    const run = new Run('wrun_123');
    const result = await run.wakeUp();

    expect(result.stoppedCount).toBe(1);
    expect(world.queue).toHaveBeenCalled();
    expect(world.events.create).toHaveBeenCalledWith(
      'wrun_123',
      expect.objectContaining({
        eventType: 'wait_completed',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        correlationId: 'wait_abc',
      }),
      expect.anything()
    );
  });

  it('should pass correlationIds option through', async () => {
    const events: Event[] = [
      {
        eventId: 'evnt_0',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_abc',
        eventData: { resumeAt: new Date('2024-01-01T00:00:01.000Z') },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_1',
        runId: 'wrun_123',
        eventType: 'wait_created',
        correlationId: 'wait_def',
        eventData: { resumeAt: new Date('2024-01-01T00:00:02.000Z') },
        createdAt: new Date(),
      },
    ];

    const world = createMockWorld({ events });
    setWorld(world);

    const run = new Run('wrun_123');
    const result = await run.wakeUp({ correlationIds: ['wait_abc'] });

    expect(result.stoppedCount).toBe(1);
    // Should only complete wait_abc, not wait_def
    expect(world.events.create).toHaveBeenCalledTimes(1);
    expect(world.events.create).toHaveBeenCalledWith(
      'wrun_123',
      expect.objectContaining({
        eventType: 'wait_completed',
        eventData: {
          resumeAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        correlationId: 'wait_abc',
      }),
      expect.anything()
    );
  });

  it('should return stoppedCount of 0 when no pending waits', async () => {
    const world = createMockWorld({ events: [] });
    setWorld(world);

    const run = new Run('wrun_123');
    const result = await run.wakeUp();

    expect(result.stoppedCount).toBe(0);
    // Should not re-enqueue when nothing was stopped
    expect(world.queue).not.toHaveBeenCalled();
  });
});

describe('Run custom serialization', () => {
  // In production builds, the SWC plugin auto-registers the class via an
  // inline IIFE. In tests (no SWC), we register manually.
  registerSerializationClass('Run', Run);

  afterEach(() => {
    setWorld(undefined as unknown as World);
  });

  it('should expose WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE methods', () => {
    const run = new Run('wrun_serialize');
    const serialized = Run[WORKFLOW_SERIALIZE](run);
    const deserialized = Run[WORKFLOW_DESERIALIZE]({
      runId: 'wrun_deserialize',
    });

    expect(serialized).toEqual({
      runId: 'wrun_serialize',
      resilientStart: false,
    });
    expect(deserialized).toBeInstanceOf(Run);
    expect(deserialized.runId).toBe('wrun_deserialize');
  });

  it('should roundtrip through step serialization boundary', async () => {
    const run = new Run('wrun_roundtrip');
    const dehydrated = await dehydrateStepReturnValue(
      run,
      'wrun_parent',
      undefined
    );

    const hydrated = await hydrateStepReturnValue(
      dehydrated,
      'wrun_parent',
      undefined
    );

    expect(hydrated).toBeInstanceOf(Run);
    expect((hydrated as Run<unknown>).runId).toBe('wrun_roundtrip');
  });
});

describe('Run.returnValue when run.status === "failed"', () => {
  // Register the FatalError class so the run-error serialization pipeline
  // can find it during hydration (the SWC plugin does this in production).
  registerSerializationClass('@workflow/errors//FatalError', FatalError);

  afterEach(() => {
    setWorld(undefined as unknown as World);
  });

  function makeFailedRunWorld(error: Uint8Array, errorCode?: string): World {
    return {
      runs: {
        get: vi.fn().mockResolvedValue({
          runId: 'wrun_failed',
          workflowName: 'failing-workflow',
          status: 'failed',
          specVersion: 2,
          input: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          startedAt: new Date(),
          completedAt: new Date(),
          deploymentId: 'test-deployment',
          error,
          errorCode,
        }),
      },
      events: {
        list: vi.fn().mockResolvedValue({
          data: [],
          hasMore: false,
          cursor: null,
        }),
        create: vi.fn(),
      },
      queue: vi.fn().mockResolvedValue(undefined),
    } as unknown as World;
  }

  it('should throw WorkflowRunFailedError with the original FatalError as cause', async () => {
    const original = new FatalError('boom');
    const serialized = await dehydrateRunError(
      original,
      'wrun_failed',
      undefined
    );
    setWorld(makeFailedRunWorld(serialized, 'USER_ERROR'));

    const run = new Run('wrun_failed');
    let caught: WorkflowRunFailedError | undefined;
    try {
      await run.returnValue;
    } catch (err) {
      caught = err as WorkflowRunFailedError;
    }

    expect(caught).toBeInstanceOf(WorkflowRunFailedError);
    expect(caught?.runId).toBe('wrun_failed');
    expect(caught?.errorCode).toBe('USER_ERROR');

    // The original thrown value flows through verbatim — preserving the
    // FatalError class identity, message, and the `fatal` marker.
    const cause = caught?.cause;
    expect(FatalError.is(cause)).toBe(true);
    expect(cause).toBeInstanceOf(FatalError);
    expect((cause as FatalError).message).toBe('boom');
    expect((cause as FatalError).fatal).toBe(true);
  });

  it('should preserve a plain Error cause through hydration', async () => {
    const original = new Error('unexpected');
    original.stack = 'Error: unexpected\n    at someFn (a.js:1:1)';
    const serialized = await dehydrateRunError(
      original,
      'wrun_failed',
      undefined
    );
    setWorld(makeFailedRunWorld(serialized, 'RUNTIME_ERROR'));

    const run = new Run('wrun_failed');
    let caught: WorkflowRunFailedError | undefined;
    try {
      await run.returnValue;
    } catch (err) {
      caught = err as WorkflowRunFailedError;
    }

    expect(caught).toBeInstanceOf(WorkflowRunFailedError);
    expect(caught?.errorCode).toBe('RUNTIME_ERROR');
    expect(caught?.cause).toBeInstanceOf(Error);
    expect((caught?.cause as Error).message).toBe('unexpected');
    expect((caught?.cause as Error).stack).toBe(original.stack);
  });

  it('should preserve a non-Error thrown value (string) as cause', async () => {
    const serialized = await dehydrateRunError(
      'thrown string',
      'wrun_failed',
      undefined
    );
    setWorld(makeFailedRunWorld(serialized));

    const run = new Run('wrun_failed');
    let caught: WorkflowRunFailedError | undefined;
    try {
      await run.returnValue;
    } catch (err) {
      caught = err as WorkflowRunFailedError;
    }

    expect(caught).toBeInstanceOf(WorkflowRunFailedError);
    expect(caught?.cause).toBe('thrown string');
    // Message should be derived from the thrown string itself.
    expect(caught?.message).toContain('thrown string');
  });

  it('should preserve an Error cause chain across hydration', async () => {
    const root = new TypeError('bad input');
    const wrapped = new FatalError('outer');
    (wrapped as Error).cause = root;
    const serialized = await dehydrateRunError(
      wrapped,
      'wrun_failed',
      undefined
    );
    setWorld(makeFailedRunWorld(serialized, 'USER_ERROR'));

    const run = new Run('wrun_failed');
    let caught: WorkflowRunFailedError | undefined;
    try {
      await run.returnValue;
    } catch (err) {
      caught = err as WorkflowRunFailedError;
    }

    expect(caught).toBeInstanceOf(WorkflowRunFailedError);
    const cause = caught?.cause;
    expect(FatalError.is(cause)).toBe(true);
    expect((cause as FatalError).message).toBe('outer');
    const nested = (cause as Error).cause;
    expect(nested).toBeInstanceOf(TypeError);
    expect((nested as TypeError).message).toBe('bad input');
  });

  it('should fall back to a generic Error when hydration fails', async () => {
    // Pass a corrupted payload (random bytes that are not a valid prefix)
    // to force hydrateRunError to throw inside Run.returnValue, exercising
    // the catch branch that surfaces a generic fallback.
    const corrupt = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00]);
    setWorld(makeFailedRunWorld(corrupt, 'RUNTIME_ERROR'));

    const run = new Run('wrun_failed');
    let caught: WorkflowRunFailedError | undefined;
    try {
      await run.returnValue;
    } catch (err) {
      caught = err as WorkflowRunFailedError;
    }

    expect(caught).toBeInstanceOf(WorkflowRunFailedError);
    // Even on hydration failure, errorCode is still surfaced from the run.
    expect(caught?.errorCode).toBe('RUNTIME_ERROR');
    expect(caught?.cause).toBeInstanceOf(Error);
    expect((caught?.cause as Error).message).toContain(
      'Failed to hydrate workflow run error'
    );
  });
});
