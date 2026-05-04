/**
 * Lazy accessor for the World singleton via globalThis symbols.
 *
 * This module exists to break the static import chain from step-side
 * modules (serialization, run, helpers, start) to world.ts. Without it,
 * esbuild bundles world.ts (and its transitive deps: world-local,
 * world-vercel, process.cwd(), etc.) into the step registrations bundle,
 * which triggers Turbopack NFT tracing errors in the V2 combined flow route.
 *
 * When the world is not yet cached, falls back to a dynamic import() of
 * ./world.js to initialize the world. The dynamic import is fine here
 * because get-world-lazy.ts is NOT in the step registrations bundle — it's
 * only used by modules that are already importing from this directory.
 */

import type { World } from '@workflow/world';

const WorldCacheKey = Symbol.for('@workflow/world//cache');
const WorldCachePromiseKey = Symbol.for('@workflow/world//cachePromise');
const GetWorldFnKey = Symbol.for('@workflow/world//getWorldFn');

export async function getWorldLazy(): Promise<World> {
  const g = globalThis as any;
  if (g[WorldCacheKey]) return g[WorldCacheKey];
  if (g[WorldCachePromiseKey]) {
    g[WorldCacheKey] = await g[WorldCachePromiseKey];
    return g[WorldCacheKey];
  }
  // If world.ts is statically present in this bundle, it has registered
  // getWorld on globalThis at module load. Prefer that over the dynamic
  // import fallback, which doesn't survive Next.js inlining get-world-lazy
  // into a route bundle (the relative './world.js' resolves against the
  // bundled location, where no sibling world.js exists).
  const getWorldFn = g[GetWorldFnKey] as (() => Promise<World>) | undefined;
  if (getWorldFn) return getWorldFn();
  // Last resort: dynamic import for environments where world.ts wasn't
  // bundled but is reachable as a sibling module on disk. The specifier is
  // built at runtime so esbuild can't trace it into the step bundle.
  const worldPath = ['./world', 'js'].join('.');
  const { getWorld } = await import(worldPath);
  return getWorld();
}
