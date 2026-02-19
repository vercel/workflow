import { WorkflowAPIError } from '@workflow/errors';
import type { Event, World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';

// Mock version module to avoid missing generated file
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

import { wakeUpRun } from './runs.js';

describe('wakeUpRun', () => {
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
