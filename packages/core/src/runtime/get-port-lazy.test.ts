import { afterEach, describe, expect, it } from 'vitest';
import {
  getPortLazy,
  resetPortCacheForTesting,
  setPortResolverForTesting,
} from './get-port-lazy.js';

describe('getPortLazy port caching', () => {
  afterEach(() => {
    resetPortCacheForTesting();
  });

  it('resolves the port once and reuses it on subsequent calls', async () => {
    let calls = 0;
    setPortResolverForTesting(async () => {
      calls++;
      return 3000;
    });

    expect(await getPortLazy()).toBe(3000);
    expect(await getPortLazy()).toBe(3000);
    expect(await getPortLazy()).toBe(3000);

    // The expensive OS query (e.g. spawning `lsof`) runs only once.
    expect(calls).toBe(1);
  });

  it('dedupes concurrent first calls into a single resolution', async () => {
    let calls = 0;
    setPortResolverForTesting(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 4000;
    });

    const results = await Promise.all([
      getPortLazy(),
      getPortLazy(),
      getPortLazy(),
    ]);

    expect(results).toEqual([4000, 4000, 4000]);
    expect(calls).toBe(1);
  });

  it('does not cache undefined, and caches the first concrete port', async () => {
    let calls = 0;
    setPortResolverForTesting(async () => {
      calls++;
      // Server not listening yet on the first two calls, then it comes up.
      return calls < 3 ? undefined : 5000;
    });

    // Transient undefined must not poison the cache — each call retries.
    expect(await getPortLazy()).toBeUndefined();
    expect(await getPortLazy()).toBeUndefined();
    // First concrete port resolves and is cached from here on.
    expect(await getPortLazy()).toBe(5000);
    expect(await getPortLazy()).toBe(5000);

    // 3 real queries (the two undefined + the one that resolved); the final
    // call is served from cache.
    expect(calls).toBe(3);
  });
});
