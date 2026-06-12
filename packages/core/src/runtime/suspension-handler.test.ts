import type { WorkflowRun, World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from '../global.js';
import { handleSuspension } from './suspension-handler.js';

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
