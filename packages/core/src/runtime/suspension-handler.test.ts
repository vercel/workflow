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
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;
}

describe('handleSuspension', () => {
  it('marks hook.getConflict()-awaited creations without converting them into wait timeouts', async () => {
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
    expect(result.hasAwaitedHookCreation).toBe(true);
    expect(result.timeoutSeconds).toBeUndefined();
  });

  it('still returns owned pending steps when an awaited hook is created with a step', async () => {
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

    expect(result.hasAwaitedHookCreation).toBe(true);
    expect(result.timeoutSeconds).toBeUndefined();
    expect(result.pendingSteps).toHaveLength(1);
    expect(result.createdStepCorrelationIds).toContain('step_parallel');
  });

  it('defers up to getMaxInlineSteps() uncreated steps and eagerly creates the rest', async () => {
    // Default getMaxInlineSteps() is 3. With 4 uncreated parallel steps, the
    // first 3 are deferred for lazy inline start (no step_created written) and
    // the 4th keeps its eager step_created and is owned for queuing.
    const eventsCreate = vi.fn().mockResolvedValue({
      event: { eventType: 'step_created' },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map(
      ['s1', 's2', 's3', 's4'].map((id) => [
        id,
        { type: 'step' as const, correlationId: id, stepName: id, args: [] },
      ])
    );

    const result = await handleSuspension({
      suspension: new WorkflowSuspension(pending, globalThis),
      world,
      run,
    });

    expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
      's1',
      's2',
      's3',
    ]);
    // Only the non-deferred step writes a step_created and is owned.
    expect(eventsCreate).toHaveBeenCalledTimes(1);
    expect(eventsCreate).toHaveBeenCalledWith(
      run.runId,
      expect.objectContaining({
        eventType: 'step_created',
        correlationId: 's4',
      }),
      expect.anything()
    );
    expect([...result.createdStepCorrelationIds]).toEqual(['s4']);
  });

  it('honors WORKFLOW_MAX_INLINE_STEPS as the inline cap', async () => {
    const prev = process.env.WORKFLOW_MAX_INLINE_STEPS;
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    try {
      const eventsCreate = vi.fn().mockResolvedValue({
        event: { eventType: 'step_created' },
      });
      const world = createWorld(eventsCreate);
      const pending = new Map(
        ['s1', 's2', 's3'].map((id) => [
          id,
          { type: 'step' as const, correlationId: id, stepName: id, args: [] },
        ])
      );

      const result = await handleSuspension({
        suspension: new WorkflowSuspension(pending, globalThis),
        world,
        run,
      });

      // Cap of 1: only the first step is deferred; s2 and s3 are eager-created.
      expect(result.lazyInlineSteps.map((s) => s.correlationId)).toEqual([
        's1',
      ]);
      expect(eventsCreate).toHaveBeenCalledTimes(2);
      expect([...result.createdStepCorrelationIds].sort()).toEqual([
        's2',
        's3',
      ]);
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_MAX_INLINE_STEPS;
      else process.env.WORKFLOW_MAX_INLINE_STEPS = prev;
    }
  });

  it('defers no inline steps when a hook.getConflict() awaiter is present', async () => {
    const eventsCreate = vi.fn().mockResolvedValue({
      event: { eventType: 'hook_created' },
    });
    const world = createWorld(eventsCreate);
    const pending = new Map([
      [
        's1',
        {
          type: 'step' as const,
          correlationId: 's1',
          stepName: 's1',
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

    // Nothing runs inline: the step keeps its eager step_created (owned) and is
    // queued; the caller re-invokes immediately to resolve the awaiter.
    expect(result.lazyInlineSteps).toEqual([]);
    expect(result.createdStepCorrelationIds).toContain('s1');
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

    expect(result.hasAwaitedHookCreation).toBe(false);
    expect(result.timeoutSeconds).toBeUndefined();
  });
});
