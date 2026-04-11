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

export async function getWorldLazy(): Promise<World> {
  const g = globalThis as any;
  if (g[WorldCacheKey]) return g[WorldCacheKey];
  if (g[WorldCachePromiseKey]) {
    g[WorldCacheKey] = await g[WorldCachePromiseKey];
    return g[WorldCacheKey];
  }
  // World not in cache — initialize via the real getWorld().
  // Dynamic import is safe here because get-world-lazy.ts is NOT
  // in the step registrations bundle (it only contains globalThis access).
  // Esbuild doesn't bundle dynamic imports with variable paths.
  const worldPath = ['./world', 'js'].join('.');
  const { getWorld } = await import(worldPath);
  return getWorld();
}
