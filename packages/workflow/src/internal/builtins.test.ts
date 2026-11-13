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
    const setAttributes = vi.fn().mockRejectedValue(error);
    globals[WORLD_CACHE] = {
      runs: { setAttributes },
    };

    for (const attempt of [1, 2]) {
      setStepAttempt(attempt);

      await expect(
        __builtin_set_attributes([{ key: '$tag.kind', value: 'agent' }], {
          allowReservedAttributes: true,
        })
      ).rejects.toBe(error);
    }

    expect(setAttributes).toHaveBeenCalledTimes(2);
  });

  it('logs and completes after the third failed attempt', async () => {
    const setAttributes = vi
      .fn()
      .mockRejectedValue(new Error('world unavailable'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    globals[WORLD_CACHE] = {
      runs: { setAttributes },
    };
    setStepAttempt(3);

    await expect(
      __builtin_set_attributes([{ key: '$tag.kind', value: 'agent' }], {
        allowReservedAttributes: true,
      })
    ).resolves.toBeUndefined();

    expect(setAttributes).toHaveBeenCalledWith(
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
  it('prefers runs.setAttributes over the deprecated name', async () => {
    const setAttributes = vi.fn().mockResolvedValue({ attributes: {} });
    const experimentalSetAttributes = vi.fn();
    globals[WORLD_CACHE] = {
      runs: { setAttributes, experimentalSetAttributes },
    };
    setStepAttempt(1);

    await __builtin_set_attributes([{ key: 'phase', value: 'init' }]);

    expect(setAttributes).toHaveBeenCalledWith(
      'run_123',
      [{ key: 'phase', value: 'init' }],
      undefined
    );
    expect(experimentalSetAttributes).not.toHaveBeenCalled();
  });

  it('falls back to runs.experimentalSetAttributes for older Worlds', async () => {
    const runs = {
      calls: [] as unknown[][],
      // Uses `this` to check the fallback is still invoked as a method.
      async experimentalSetAttributes(...args: unknown[]) {
        this.calls.push(args);
        return { attributes: {} };
      },
    };
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globals[WORLD_CACHE] = { runs };
    setStepAttempt(1);

    await __builtin_set_attributes([{ key: '$tag.kind', value: 'agent' }], {
      allowReservedAttributes: true,
    });

    expect(runs.calls).toEqual([
      [
        'run_123',
        [{ key: '$tag.kind', value: 'agent' }],
        { allowReservedAttributes: true },
      ],
    ]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('warns once and no-ops when the World implements neither name', async () => {
    delete globals[UNSUPPORTED_WORLD_WARNED];
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globals[WORLD_CACHE] = { name: 'community', runs: {} };
    setStepAttempt(1);

    await expect(
      __builtin_set_attributes([{ key: 'phase', value: 'init' }])
    ).resolves.toBeUndefined();
    await __builtin_set_attributes([{ key: 'phase', value: 'done' }]);

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0]?.[0]).toContain(
      'does not implement runs.setAttributes'
    );
  });
});
