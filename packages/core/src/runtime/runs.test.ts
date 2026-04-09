import {
  EntityConflictError,
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
