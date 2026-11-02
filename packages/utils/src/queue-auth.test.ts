import { afterEach, describe, expect, it } from 'vitest';
import { resetGlobalSingletonForTest } from './global-singleton.js';
import { getQueueAuthKey, isQueueAuthKey } from './queue-auth.js';

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
