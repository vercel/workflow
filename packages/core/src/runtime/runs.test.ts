import { WorkflowAPIError } from '@workflow/errors';
import type { Event, World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { wakeUpRun } from './runs.js';
import { Run } from './run.js';
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

    const conflict = new WorkflowAPIError('Wait already completed', {
      status: 409,
    });

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

    const serverError = new WorkflowAPIError('Internal server error', {
      status: 500,
    });

    const world = createMockWorld({ events, createError: serverError });

    await expect(wakeUpRun(world, 'wrun_123')).rejects.toThrow(AggregateError);
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
