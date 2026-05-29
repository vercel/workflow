import { FatalError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_setAttributes } from './set-attributes.js';
import { contextStorage, type StepContext } from './step/context-storage.js';

const WORLD_CACHE = Symbol.for('@workflow/world//cache');
const UNSUPPORTED_WORLD_WARNED = Symbol.for(
  '@workflow/setAttributes//unsupportedWorldWarned'
);
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
  let originalUnsupportedWorldWarned: unknown;

  beforeEach(() => {
    originalWorld = globals[WORLD_CACHE];
    originalUnsupportedWorldWarned = globals[UNSUPPORTED_WORLD_WARNED];
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalWorld === undefined) {
      delete globals[WORLD_CACHE];
    } else {
      globals[WORLD_CACHE] = originalWorld;
    }

    if (originalUnsupportedWorldWarned === undefined) {
      delete globals[UNSUPPORTED_WORLD_WARNED];
    } else {
      globals[UNSUPPORTED_WORLD_WARNED] = originalUnsupportedWorldWarned;
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

  it('posts normalized changes directly to the world when called from a step', async () => {
    const experimentalSetAttributes = vi.fn().mockResolvedValue({
      attributes: { phase: 'ready' },
    });
    globals[WORLD_CACHE] = {
      name: 'test-world',
      runs: { experimentalSetAttributes },
    };

    await runInStepContext(() =>
      experimental_setAttributes({ phase: 'ready', stale: undefined })
    );

    expect(experimentalSetAttributes).toHaveBeenCalledWith(
      'run_123',
      [
        { key: 'phase', value: 'ready' },
        { key: 'stale', value: null },
      ],
      {}
    );
  });

  it('forwards allowReservedAttributes for step-side reserved namespace writes', async () => {
    const experimentalSetAttributes = vi.fn().mockResolvedValue({
      attributes: { '$agent.kind': 'durable-agent' },
    });
    globals[WORLD_CACHE] = {
      runs: { experimentalSetAttributes },
    };

    await runInStepContext(() =>
      experimental_setAttributes(
        { '$agent.kind': 'durable-agent' },
        { allowReservedAttributes: true }
      )
    );

    expect(experimentalSetAttributes).toHaveBeenCalledWith(
      'run_123',
      [{ key: '$agent.kind', value: 'durable-agent' }],
      { allowReservedAttributes: true }
    );
  });

  it('rejects validation errors before posting from a step', async () => {
    const experimentalSetAttributes = vi.fn();
    globals[WORLD_CACHE] = {
      runs: { experimentalSetAttributes },
    };

    await expect(
      runInStepContext(() => experimental_setAttributes({ $sys: 'x' }))
    ).rejects.toBeInstanceOf(FatalError);
    expect(experimentalSetAttributes).not.toHaveBeenCalled();
  });

  it('warns once and no-ops in a step when the world does not support attributes', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globals[WORLD_CACHE] = {
      name: 'legacy-world',
      runs: {},
    };

    await runInStepContext(() =>
      experimental_setAttributes({ phase: 'ignored' })
    );
    await runInStepContext(() =>
      experimental_setAttributes({ phase: 'ignored-again' })
    );

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0]?.[0]).toContain('legacy-world');
  });
});
