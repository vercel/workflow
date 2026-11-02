import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetGlobalSingletonForTest } from './global-singleton.js';
import {
  createLogLimiter,
  getQueueAuthKey,
  isQueueAuthKey,
  isQueueAuthRefusal,
  QUEUE_AUTH_REFUSED_HEADER,
} from './queue-auth.js';

describe('queue auth key', () => {
  afterEach(() => {
    resetGlobalSingletonForTest('@workflow/utils//queueAuthKey', 1);
  });

  it('is a 32-byte random base64url value, stable for the process', () => {
    const key = getQueueAuthKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getQueueAuthKey()).toBe(key);
  });

  it('is shared by every module copy through globalThis', () => {
    const key = getQueueAuthKey();
    const state = (globalThis as Record<symbol, { key?: string }>)[
      Symbol.for('@workflow/utils//queueAuthKey/v1')
    ];
    expect(state?.key).toBe(key);
  });

  it('is generated afresh per process', () => {
    const first = getQueueAuthKey();
    resetGlobalSingletonForTest('@workflow/utils//queueAuthKey', 1);
    expect(getQueueAuthKey()).not.toBe(first);
  });

  it('accepts only the exact key', () => {
    const key = getQueueAuthKey();
    expect(isQueueAuthKey(key)).toBe(true);
    expect(isQueueAuthKey(null)).toBe(false);
    expect(isQueueAuthKey(undefined)).toBe(false);
    expect(isQueueAuthKey('')).toBe(false);
    expect(isQueueAuthKey(key.slice(1))).toBe(false);
    expect(isQueueAuthKey(`${key}x`)).toBe(false);
    const flipped = (key[0] === 'A' ? 'B' : 'A') + key.slice(1);
    expect(isQueueAuthKey(flipped)).toBe(false);
  });
});

describe('isQueueAuthRefusal', () => {
  const response = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers });

  it('is a 401 carrying the refusal marker', () => {
    expect(
      isQueueAuthRefusal(response(401, { [QUEUE_AUTH_REFUSED_HEADER]: '1' }))
    ).toBe(true);
  });

  it('is not a bare 401, such as a proxy answers', () => {
    expect(isQueueAuthRefusal(response(401))).toBe(false);
    expect(
      isQueueAuthRefusal(response(401, { [QUEUE_AUTH_REFUSED_HEADER]: '0' }))
    ).toBe(false);
  });

  it('is not another status carrying the marker', () => {
    for (const status of [200, 403, 500]) {
      expect(
        isQueueAuthRefusal(
          response(status, { [QUEUE_AUTH_REFUSED_HEADER]: '1' })
        )
      ).toBe(false);
    }
  });
});

describe('createLogLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs the first call, then at most once per interval with a count', () => {
    vi.useFakeTimers();
    const limit = createLogLimiter(60_000);
    const log = vi.fn();
    limit(log);
    limit(log);
    limit(log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(1);
    vi.advanceTimersByTime(59_999);
    limit(log);
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    limit(log);
    expect(log).toHaveBeenCalledTimes(2);
    // The three suppressed calls and this one.
    expect(log).toHaveBeenLastCalledWith(4);
  });

  it('keeps separate state per limiter', () => {
    const a = vi.fn();
    const b = vi.fn();
    const limitA = createLogLimiter();
    const limitB = createLogLimiter();
    limitA(a);
    limitB(b);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
