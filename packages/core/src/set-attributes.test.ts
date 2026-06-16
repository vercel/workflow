import { FatalError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_setAttributes } from './set-attributes.js';
import { contextStorage, type StepContext } from './step/context-storage.js';

const WORLD_CACHE = Symbol.for('@workflow/world//cache');
const globals = globalThis as Record<symbol, unknown>;

function stepContext(runId = 'run_123'): StepContext {
  return {
    stepMetadata: {
      stepName: 'setAttributesStep',
      stepId: 'step',
      stepStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      attempt: 1,
    },
    workflowMetadata: {
      workflowName: 'workflow',
      workflowRunId: runId,
      workflowStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      url: 'http://localhost/.well-known/workflow/v1/flow',
      features: { encryption: false },
    },
    ops: [],
  };
}

async function runInStepContext<T>(
  callback: () => Promise<T>,
  runId?: string
): Promise<T> {
  return contextStorage.run(stepContext(runId), callback);
}

describe('experimental_setAttributes (host-side)', () => {
  let originalWorld: unknown;

  beforeEach(() => {
    originalWorld = globals[WORLD_CACHE];
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalWorld === undefined) {
      delete globals[WORLD_CACHE];
    } else {
      globals[WORLD_CACHE] = originalWorld;
    }
  });

  it('throws FatalError when called from plain host code', async () => {
    await expect(
      experimental_setAttributes({ phase: 'init' })
    ).rejects.toBeInstanceOf(FatalError);
    await expect(experimental_setAttributes({ phase: 'init' })).rejects.toThrow(
      /workflow.*step.*function/i
    );
  });

  it('posts normalized changes as a native event when called from a step', async () => {
    const create = vi.fn().mockResolvedValue({});
    globals[WORLD_CACHE] = {
      name: 'test-world',
      events: { create },
    };

    await runInStepContext(() =>
      experimental_setAttributes({ phase: 'ready', stale: undefined })
    );

    expect(create).toHaveBeenCalledWith(
      'run_123',
      expect.objectContaining({
        eventType: 'attr_set',
        eventData: {
          changes: [
            { key: 'phase', value: 'ready' },
            { key: 'stale', value: null },
          ],
          writer: { type: 'step', stepId: 'step', attempt: 1 },
        },
      })
    );
  });

  it('forwards allowReservedAttributes for step-side reserved namespace writes', async () => {
    const create = vi.fn().mockResolvedValue({});
    globals[WORLD_CACHE] = {
      events: { create },
    };

    await runInStepContext(() =>
      experimental_setAttributes(
        { '$agent.kind': 'durable-agent' },
        { allowReservedAttributes: true }
      )
    );

    expect(create).toHaveBeenCalledWith(
      'run_123',
      expect.objectContaining({
        eventType: 'attr_set',
        eventData: {
          changes: [{ key: '$agent.kind', value: 'durable-agent' }],
          writer: { type: 'step', stepId: 'step', attempt: 1 },
          allowReservedAttributes: true,
        },
      })
    );
  });

  it('rejects validation errors before posting from a step', async () => {
    const create = vi.fn();
    globals[WORLD_CACHE] = {
      events: { create },
    };

    await expect(
      runInStepContext(() => experimental_setAttributes({ $sys: 'x' }))
    ).rejects.toBeInstanceOf(FatalError);
    expect(create).not.toHaveBeenCalled();
  });
});
