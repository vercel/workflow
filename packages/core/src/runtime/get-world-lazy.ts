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
 *    that reaches this file via `workflow` or `workflow/api` (which import
 *    `./world-init.ts` for its side effect; see that file for the full
 *    rationale). This is the cold-start path for routes that consume host
 *    helpers without any prior workflow run.
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
  // world-init statically imports world.ts in host bundles, which registers
  // getWorld on globalThis at module load.
  const getWorldFn = g[GetWorldFnKey];
  if (getWorldFn) {
    const world = await getWorldFn();
    assertWorldSupportsRuntimeProtocol(world);
    return world;
  }
  throw new Error(
    'Workflow world runtime was not initialized. Import from the host workflow entrypoints (`workflow`, `workflow/api`, or `workflow/runtime`) so @workflow/core/runtime/world-init can register getWorld before getWorldLazy() is used.'
  );
}
