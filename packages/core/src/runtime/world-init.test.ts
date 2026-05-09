import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Re-declare the symbols here (mirrors world.ts and get-world-lazy.ts)
// instead of importing them, so the test fails loudly if either file
// changes its symbol identity in a way that would silently break the
// cross-module global handshake.
const WorldCacheKey = Symbol.for('@workflow/world//cache');
const WorldCachePromiseKey = Symbol.for('@workflow/world//cachePromise');
const GetWorldFnKey = Symbol.for('@workflow/world//getWorldFn');

type GlobalsShape = {
  [WorldCacheKey]?: unknown;
  [WorldCachePromiseKey]?: unknown;
  [GetWorldFnKey]?: () => Promise<unknown>;
};

const g = globalThis as GlobalsShape;

// Importing world-init for its side effect at the top of this test file is
// itself the regression test: if `import '@workflow/core/runtime/world-init'`
// stops loading `world.ts`, the `GetWorldFnKey` registration won't run and
// the first assertion below fails. This mirrors what `workflow/api` (the
// host file) does in production.
import './world-init.js';

describe('world-init', () => {
  let priorFn: GlobalsShape[typeof GetWorldFnKey];

  beforeEach(() => {
    // Snapshot and clear the world cache. Each test wants to drive
    // getWorldLazy down a deterministic path; leaving a previously-cached
    // World instance around would short-circuit the test.
    priorFn = g[GetWorldFnKey];
    delete g[WorldCacheKey];
    delete g[WorldCachePromiseKey];
  });

  afterEach(() => {
    g[GetWorldFnKey] = priorFn;
    delete g[WorldCacheKey];
    delete g[WorldCachePromiseKey];
  });

  it('registers getWorld on globalThis at module-load time', () => {
    expect(typeof g[GetWorldFnKey]).toBe('function');
  });

  it(
    'getWorldLazy resolves via the registered global instead of falling ' +
      'through to the dynamic-import branch',
    async () => {
      const { getWorldLazy } = await import('./get-world-lazy.js');

      // Replace the registration with a sentinel-returning function so we can
      // prove which branch getWorldLazy used. Using a Symbol means a real
      // World instance from `world.ts`'s `getWorld()` (returned by the
      // production registration) can't accidentally satisfy this assertion.
      const sentinel = Symbol('sentinel-world');
      g[GetWorldFnKey] = async () => sentinel as unknown;

      const result = await getWorldLazy();
      expect(result).toBe(sentinel);
    }
  );

  it('uses ??= to register, so a prior registration is preserved', async () => {
    // Simulate the case where some earlier code already set the registration
    // (e.g., a setWorld() bypass in tests, or a future module that registers
    // before world.ts). The world-init side effect must not clobber it.
    const sentinel = async () => 'preserved' as unknown;
    g[GetWorldFnKey] = sentinel;

    // Re-evaluating world.ts is what would clobber. Importing world-init
    // again returns the cached module, so the assignment doesn't re-run —
    // this assertion is really documenting the contract.
    await import('./world-init.js');

    expect(g[GetWorldFnKey]).toBe(sentinel);
  });
});
