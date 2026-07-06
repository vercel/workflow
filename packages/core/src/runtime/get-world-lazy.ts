/**
 * Lazy accessor for the World singleton via globalThis symbols.
 *
 * This module exists to break the static import chain from step-side
 * modules (serialization, run, helpers, start) to world.ts. Without it,
 * esbuild bundles world.ts (and its transitive deps: world-local,
 * world-vercel, process.cwd(), etc.) into the step registrations bundle,
 * which triggers Turbopack NFT tracing errors in the V2 combined flow route.
 *
 * Resolution order, in priority:
 *
 * 1. `globalThis[WorldCacheKey]` — populated by a successful prior
 *    `getWorld()` call. This is the steady-state hot path.
 * 2. `globalThis[GetWorldFnKey]` — populated by the module-load side
 *    effect at the bottom of `./world.ts`. Fires on every server bundle
 *    that reaches this file via `workflow/api` (which imports
 *    `./world-init.ts` for its side effect; see that file for the full
 *    rationale). This is the cold-start path for routes that consume
 *    `start` without any prior workflow run.
 * 3. Dynamic `import('./world.js')` — last-resort fallback for
 *    environments where neither (1) nor (2) is available (CJS test
 *    runners, scripts that import deeply into `@workflow/core` without
 *    going through `workflow/api`, future bundlers we haven't validated).
 *    The specifier is built at runtime so esbuild can't trace it into
 *    step bundles. Note: this branch is unreliable in webpack-bundled
 *    routes because webpack inlines this module into the route file and
 *    the relative path resolves against the bundle location — paths (1)
 *    and (2) cover those cases instead.
 */

import type { World } from '@workflow/world';
import { assertWorldSupportsRuntimeProtocol } from './world-compatibility.js';

const WorldCacheKey = Symbol.for('@workflow/world//cache');
const WorldCachePromiseKey = Symbol.for('@workflow/world//cachePromise');
const GetWorldFnKey = Symbol.for('@workflow/world//getWorldFn');

type GlobalWorldCache = typeof globalThis & {
  [WorldCacheKey]?: World;
  [WorldCachePromiseKey]?: Promise<World>;
  [GetWorldFnKey]?: () => Promise<World>;
};

export async function getWorldLazy(): Promise<World> {
  const g = globalThis as GlobalWorldCache;
  if (g[WorldCacheKey]) {
    assertWorldSupportsRuntimeProtocol(g[WorldCacheKey]);
    return g[WorldCacheKey];
  }
  if (g[WorldCachePromiseKey]) {
    g[WorldCacheKey] = await g[WorldCachePromiseKey];
    assertWorldSupportsRuntimeProtocol(g[WorldCacheKey]);
    return g[WorldCacheKey];
  }
  // If world.ts is statically present in this bundle, it has registered
  // getWorld on globalThis at module load. Prefer that over the dynamic
  // import fallback, which doesn't survive Next.js inlining get-world-lazy
  // into a route bundle (the relative './world.js' resolves against the
  // bundled location, where no sibling world.js exists).
  const getWorldFn = g[GetWorldFnKey];
  if (getWorldFn) {
    const world = await getWorldFn();
    assertWorldSupportsRuntimeProtocol(world);
    return world;
  }
  // Last resort: dynamic import for environments where world.ts wasn't
  // bundled but is reachable as a sibling module on disk. The specifier is
  // built at runtime so esbuild can't trace it into the step bundle.
  const worldPath = ['./world', 'js'].join('.');
  const { getWorld } = await import(worldPath);
  return getWorld();
}
