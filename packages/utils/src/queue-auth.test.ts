import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetGlobalSingletonForTest } from './global-singleton.js';
import {
  clearQueueAuthKeySources,
  createLogLimiter,
  generateQueueAuthKey,
  getQueueAuthKey,
  isQueueAuthKey,
  isQueueAuthRefusal,
  QUEUE_AUTH_REFUSED_HEADER,
  setQueueAuthKeySource,
  verifyQueueAuthKey,
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

describe('verifyQueueAuthKey with a key source', () => {
  afterEach(() => {
    clearQueueAuthKeySources();
    resetGlobalSingletonForTest('@workflow/utils//queueAuthKey', 1);
  });

  /** A source whose storage holds `stored`, counting reloads. */
  function source(inMemory: string, stored: string | undefined, id = 'dir') {
    const state = { key: inMemory, stored, reloads: 0 };
    setQueueAuthKeySource(id, {
      current: () => state.key,
      reload: async () => {
        state.reloads++;
        if (state.stored) state.key = state.stored;
        return state.key;
      },
    });
    return state;
  }

  it('accepts the key in memory without reloading', async () => {
    const key = generateQueueAuthKey();
    const state = source(key, undefined);
    for (let i = 0; i < 100; i++) {
      expect(await verifyQueueAuthKey(key)).toBe(true);
    }
    expect(state.reloads).toBe(0);
  });

  it('accepts a key another process stored, after one reload', async () => {
    const stored = generateQueueAuthKey();
    const state = source(generateQueueAuthKey(), stored);
    expect(await verifyQueueAuthKey(stored)).toBe(true);
    expect(state.reloads).toBe(1);
    // Now in memory: no further reload.
    expect(await verifyQueueAuthKey(stored)).toBe(true);
    expect(state.reloads).toBe(1);
  });

  it('refuses a wrong key after reloading', async () => {
    const state = source(generateQueueAuthKey(), undefined);
    expect(await verifyQueueAuthKey(generateQueueAuthKey())).toBe(false);
    expect(state.reloads).toBe(1);
  });

  it.each([
    ['no key', undefined],
    ['an empty key', ''],
    ['a malformed key', 'not-a-key'],
  ])('refuses %s, and reloads so storage gets a key back', async (_, value) => {
    const key = generateQueueAuthKey();
    const state = source(key, key);
    expect(await verifyQueueAuthKey(value)).toBe(false);
    expect(state.reloads).toBe(1);
  });

  it('accepts the key of every registered source, one per data directory', async () => {
    const a = generateQueueAuthKey();
    const b = generateQueueAuthKey();
    const stateA = source(a, undefined, '/data/a');
    const stateB = source(b, undefined, '/data/b');

    expect(await verifyQueueAuthKey(a)).toBe(true);
    expect(await verifyQueueAuthKey(b)).toBe(true);
    expect(stateA.reloads + stateB.reloads).toBe(0);
    // A wrong key reloads every source, and matches none.
    expect(await verifyQueueAuthKey(generateQueueAuthKey())).toBe(false);
    expect([stateA.reloads, stateB.reloads]).toEqual([1, 1]);
  });

  it('accepts a key stored for any source, after reloading', async () => {
    const storedB = generateQueueAuthKey();
    source(generateQueueAuthKey(), undefined, '/data/a');
    source(generateQueueAuthKey(), storedB, '/data/b');
    expect(await verifyQueueAuthKey(storedB)).toBe(true);
  });

  it('stops accepting a source that was removed', async () => {
    const key = generateQueueAuthKey();
    source(key, undefined, '/data/a');
    source(generateQueueAuthKey(), undefined, '/data/b');
    setQueueAuthKeySource('/data/a', undefined);
    expect(await verifyQueueAuthKey(key)).toBe(false);
  });

  it('without a source, checks the in-memory key', async () => {
    expect(await verifyQueueAuthKey(getQueueAuthKey())).toBe(true);
    expect(await verifyQueueAuthKey(generateQueueAuthKey())).toBe(false);
  });
});
