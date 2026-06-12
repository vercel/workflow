import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import {
  _resetEventCacheWarnCacheForTests,
  _resetReplayTimeoutWarnCacheForTests,
  EVENT_CACHE_MAX_BYTES,
  EVENT_CACHE_MAX_ENTRIES,
  getEventCacheMaxBytes,
  getEventCacheMaxEntries,
  getReplayTimeoutMs,
  isEventCacheEnabled,
  MAX_REPLAY_TIMEOUT_MS,
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

describe('event cache config', () => {
  const originalEnv = {
    disabled: process.env.WORKFLOW_DISABLE_EVENT_CACHE,
    maxBytes: process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES,
    maxEntries: process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES,
  };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.WORKFLOW_DISABLE_EVENT_CACHE;
    delete process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES;
    delete process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES;
    _resetEventCacheWarnCacheForTests();
    warnSpy = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv.disabled === undefined) {
      delete process.env.WORKFLOW_DISABLE_EVENT_CACHE;
    } else {
      process.env.WORKFLOW_DISABLE_EVENT_CACHE = originalEnv.disabled;
    }
    if (originalEnv.maxBytes === undefined) {
      delete process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES;
    } else {
      process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES = originalEnv.maxBytes;
    }
    if (originalEnv.maxEntries === undefined) {
      delete process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES;
    } else {
      process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES = originalEnv.maxEntries;
    }
    warnSpy.mockRestore();
  });

  it('uses defaults when overrides are unset', () => {
    expect(getEventCacheMaxBytes()).toBe(EVENT_CACHE_MAX_BYTES);
    expect(getEventCacheMaxEntries()).toBe(EVENT_CACHE_MAX_ENTRIES);
    expect(isEventCacheEnabled()).toBe(true);
  });

  it('honors configured bounds', () => {
    process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES = '8192';
    process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES = '5';

    expect(getEventCacheMaxBytes()).toBe(8192);
    expect(getEventCacheMaxEntries()).toBe(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back from invalid configured bounds', () => {
    process.env.WORKFLOW_EVENT_CACHE_MAX_BYTES = 'not-a-number';
    process.env.WORKFLOW_EVENT_CACHE_MAX_ENTRIES = '0';

    expect(getEventCacheMaxBytes()).toBe(EVENT_CACHE_MAX_BYTES);
    expect(getEventCacheMaxEntries()).toBe(EVENT_CACHE_MAX_ENTRIES);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('disables the cache only for the explicit kill-switch value', () => {
    process.env.WORKFLOW_DISABLE_EVENT_CACHE = '1';
    expect(isEventCacheEnabled()).toBe(false);

    process.env.WORKFLOW_DISABLE_EVENT_CACHE = 'true';
    expect(isEventCacheEnabled()).toBe(true);
  });
});
