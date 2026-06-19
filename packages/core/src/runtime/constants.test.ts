import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import {
  _resetReplayTimeoutWarnCacheForTests,
  getMaxInlineSteps,
  getReplayTimeoutMs,
  isOptimisticInlineStartEnabled,
  MAX_INLINE_STEPS,
  MAX_MAX_INLINE_STEPS,
  MAX_REPLAY_TIMEOUT_MS,
  MIN_MAX_INLINE_STEPS,
  MIN_REPLAY_TIMEOUT_MS,
  REPLAY_TIMEOUT_MS,
} from './constants.js';

describe('getReplayTimeoutMs', () => {
  const originalEnv = process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
    _resetReplayTimeoutWarnCacheForTests();
    warnSpy = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
    } else {
      process.env.WORKFLOW_REPLAY_TIMEOUT_MS = originalEnv;
    }
    warnSpy.mockRestore();
  });

  it('returns the default when the env var is unset', () => {
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the default when the env var is empty', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the default and warns when the env var is non-numeric', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = 'not-a-number';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('not a positive finite number');
  });

  it('returns the default and warns when the env var is zero', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '0';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the default and warns when the env var is negative', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '-100';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('clamps to MIN_REPLAY_TIMEOUT_MS and warns when below floor', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '5000';
    expect(getReplayTimeoutMs()).toBe(MIN_REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('below minimum');
  });

  it('clamps to MAX_REPLAY_TIMEOUT_MS and warns when above ceiling', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '9999999';
    expect(getReplayTimeoutMs()).toBe(MAX_REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('above maximum');
  });

  it('honors an in-range override without warning', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '600000';
    expect(getReplayTimeoutMs()).toBe(600_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts the lower-bound value exactly without warning', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = String(MIN_REPLAY_TIMEOUT_MS);
    expect(getReplayTimeoutMs()).toBe(MIN_REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts the upper-bound value exactly without warning', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = String(MAX_REPLAY_TIMEOUT_MS);
    expect(getReplayTimeoutMs()).toBe(MAX_REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects Infinity and falls back to the default', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = 'Infinity';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects NaN and falls back to the default', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = 'NaN';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('only warns once per distinct raw env var value', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '5000';
    getReplayTimeoutMs();
    getReplayTimeoutMs();
    getReplayTimeoutMs();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getMaxInlineSteps', () => {
  const originalEnv = process.env.WORKFLOW_MAX_INLINE_STEPS;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.WORKFLOW_MAX_INLINE_STEPS;
    warnSpy = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_MAX_INLINE_STEPS;
    } else {
      process.env.WORKFLOW_MAX_INLINE_STEPS = originalEnv;
    }
    warnSpy.mockRestore();
  });

  it('returns the default when the env var is unset', () => {
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns a valid in-range override', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '5';
    expect(getMaxInlineSteps()).toBe(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('clamps to the minimum (1 = single inline step)', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    expect(getMaxInlineSteps()).toBe(MIN_MAX_INLINE_STEPS);
  });

  it('clamps values above the maximum and warns', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = String(MAX_MAX_INLINE_STEPS + 100);
    expect(getMaxInlineSteps()).toBe(MAX_MAX_INLINE_STEPS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default on a non-integer and warns', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '2.5';
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default on a non-numeric value and warns', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = 'lots';
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default on a non-positive value', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '0';
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
  });
});

describe('isOptimisticInlineStartEnabled', () => {
  const originalEnv = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    } else {
      process.env.WORKFLOW_OPTIMISTIC_INLINE_START = originalEnv;
    }
  });

  it('defaults to disabled when unset', () => {
    delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    expect(isOptimisticInlineStartEnabled()).toBe(false);
  });

  it('is enabled by an explicit "1"', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '1';
    expect(isOptimisticInlineStartEnabled()).toBe(true);
  });

  it('is enabled by "true" (case-insensitive)', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = 'TRUE';
    expect(isOptimisticInlineStartEnabled()).toBe(true);
  });

  it('stays disabled for any other value', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = 'yes';
    expect(isOptimisticInlineStartEnabled()).toBe(false);
  });
});
