import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __builtin_set_attributes } from './builtins.js';

const STEP_CONTEXT_STORAGE = Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE');
const WORLD_CACHE = Symbol.for('@workflow/world//cache');
const UNSUPPORTED_WORLD_WARNED = Symbol.for(
  '@workflow/setAttributes//unsupportedWorldWarned'
);

const globals = globalThis as Record<symbol, unknown>;

function setStepAttempt(attempt: number) {
  globals[STEP_CONTEXT_STORAGE] = {
    getStore: () => ({
      stepMetadata: { attempt },
      workflowMetadata: { workflowRunId: 'run_123' },
    }),
  };
}

describe('__builtin_set_attributes', () => {
  let originalContextStorage: unknown;
  let originalWorld: unknown;
  let originalUnsupportedWorldWarned: unknown;

  beforeEach(() => {
    originalContextStorage = globals[STEP_CONTEXT_STORAGE];
    originalWorld = globals[WORLD_CACHE];
    originalUnsupportedWorldWarned = globals[UNSUPPORTED_WORLD_WARNED];
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalContextStorage === undefined) {
      delete globals[STEP_CONTEXT_STORAGE];
    } else {
      globals[STEP_CONTEXT_STORAGE] = originalContextStorage;
    }

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

  it('rethrows attribute write failures before the third attempt', async () => {
    const error = new Error('world unavailable');
    const experimentalSetAttributes = vi.fn().mockRejectedValue(error);
    globals[WORLD_CACHE] = {
      runs: { experimentalSetAttributes },
    };

    for (const attempt of [1, 2]) {
      setStepAttempt(attempt);

      await expect(
        __builtin_set_attributes([{ key: '$tag.kind', value: 'agent' }], {
          allowReservedAttributes: true,
        })
      ).rejects.toBe(error);
    }

    expect(experimentalSetAttributes).toHaveBeenCalledTimes(2);
  });

  it('logs and completes after the third failed attempt', async () => {
    const experimentalSetAttributes = vi
      .fn()
      .mockRejectedValue(new Error('world unavailable'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    globals[WORLD_CACHE] = {
      runs: { experimentalSetAttributes },
    };
    setStepAttempt(3);

    await expect(
      __builtin_set_attributes([{ key: '$tag.kind', value: 'agent' }], {
        allowReservedAttributes: true,
      })
    ).resolves.toBeUndefined();

    expect(experimentalSetAttributes).toHaveBeenCalledWith(
      'run_123',
      [{ key: '$tag.kind', value: 'agent' }],
      { allowReservedAttributes: true }
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain(
      'failed to post tags after 3 attempts'
    );
    expect(
      (
        __builtin_set_attributes as typeof __builtin_set_attributes & {
          maxRetries: number;
        }
      ).maxRetries
    ).toBe(2);
  });
});
