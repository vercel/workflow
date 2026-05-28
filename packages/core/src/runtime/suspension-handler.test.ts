import { EntityConflictError } from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  WorkflowRun,
  World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from '../global.js';
import { handleSuspension } from './suspension-handler.js';

describe('handleSuspension', () => {
  it('chains the local event-log fence across writes from the same suspension', async () => {
    const runId = 'wrun_test_fence_chain';
    let serverTip = 'evnt_000';
    let sequence = 0;
    const writes: Array<{
      eventType: string;
      correlationId?: string;
      lastKnownEventId?: string;
    }> = [];

    const world = {
      getEncryptionKeyForRun: vi.fn(async () => undefined),
      events: {
        create: vi.fn(
          async (
            _runId: string,
            event: CreateEventRequest,
            params?: CreateEventParams
          ) => {
            if (
              params?.lastKnownEventId !== undefined &&
              params.lastKnownEventId !== serverTip
            ) {
              throw new EntityConflictError(
                `fence conflict: expected ${params.lastKnownEventId}, current ${serverTip}`
              );
            }

            const eventId = `evnt_${String(++sequence).padStart(3, '0')}`;
            writes.push({
              eventType: event.eventType,
              correlationId: event.correlationId,
              lastKnownEventId: params?.lastKnownEventId,
            });
            serverTip = eventId;

            return {
              event: {
                ...event,
                eventId,
                createdAt: new Date(),
              } as Event,
            };
          }
        ),
      },
      streams: {
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    } as unknown as World;

    const suspension = new WorkflowSuspension(
      new Map([
        [
          'hook-user',
          {
            type: 'hook',
            correlationId: 'hook_user',
            token: 'user-token',
          },
        ],
        [
          'hook-abort',
          {
            type: 'hook',
            correlationId: 'hook_abort',
            token: 'abrt_abort',
            isSystem: true,
            abortRequested: true,
            abortReason: 'cancelled',
          },
        ],
        [
          'step',
          {
            type: 'step',
            correlationId: 'step_1',
            stepName: 'do work',
            args: [],
          },
        ],
        [
          'wait',
          {
            type: 'wait',
            correlationId: 'wait_1',
            resumeAt: new Date(Date.now() + 10_000),
          },
        ],
      ]),
      globalThis
    );

    await handleSuspension({
      suspension,
      world,
      run: { runId } as WorkflowRun,
      fenceEventId: 'evnt_000',
    });

    expect(writes).toEqual([
      {
        eventType: 'hook_created',
        correlationId: 'hook_user',
        lastKnownEventId: 'evnt_000',
      },
      {
        eventType: 'hook_created',
        correlationId: 'hook_abort',
        lastKnownEventId: 'evnt_001',
      },
      {
        eventType: 'hook_received',
        correlationId: 'hook_abort',
        lastKnownEventId: undefined,
      },
      {
        eventType: 'step_created',
        correlationId: 'step_1',
        lastKnownEventId: 'evnt_003',
      },
      {
        eventType: 'wait_created',
        correlationId: 'wait_1',
        lastKnownEventId: 'evnt_004',
      },
    ]);
  });
});
