import * as targetWorldModule from '@workflow/core/runtime/world-target';
import type { World } from '@workflow/world';
import { assertWorldSupportsRuntimeProtocol } from './world-compatibility.js';

const WorldCache = Symbol.for('@workflow/world//cache');
const StubbedWorldCache = Symbol.for('@workflow/world//stubbedCache');
const WorldCachePromise = Symbol.for('@workflow/world//cachePromise');
const StubbedWorldCachePromise = Symbol.for(
  '@workflow/world//stubbedCachePromise'
);

const globalSymbols: typeof globalThis & {
  [WorldCache]?: World;
  [StubbedWorldCache]?: World;
  [WorldCachePromise]?: Promise<World>;
  [StubbedWorldCachePromise]?: Promise<World>;
} = globalThis;

export type WorldFactoryModule = {
  createWorld?: () => World | Promise<World>;
  createLocalWorld?: () => World | Promise<World>;
  createVercelWorld?: () => World | Promise<World>;
  default?: (() => World | Promise<World>) | World;
};

/**
 * Create a World instance from a world factory module. Shared by
 * `createWorld()` (for the statically injected target world module) and
 * tooling that loads a world module dynamically (e.g. the Nitro dev
 * handler and `@workflow/world-testing`).
 */
export function createWorldFromModule(
  mod: WorldFactoryModule
): World | Promise<World> {
  if (typeof mod.createWorld === 'function') {
    return mod.createWorld();
  }
  if (typeof mod.createLocalWorld === 'function') {
    return mod.createLocalWorld();
  }
  if (typeof mod.createVercelWorld === 'function') {
    return mod.createVercelWorld();
  }
  if (typeof mod.default === 'function') {
    return mod.default();
  }
  if (mod.default && typeof mod.default === 'object') {
    return mod.default as World;
  }

  throw new Error(
    'Invalid target world module: must export createWorld(), createLocalWorld(), createVercelWorld(), a default factory, or a default World instance.'
  );
}

/**
 * Create a new world instance from the statically imported target world module.
 *
 * Framework integrations alias `@workflow/core/runtime/world-target` to the
 * concrete world package at build time, so bundlers see a static import path
 * instead of tracing a runtime-built require/import expression.
 */
export const createWorld = async (): Promise<World> => {
  const world = await createWorldFromModule(targetWorldModule);

  const staleEnvVars = [
    'WORKFLOW_VERCEL_PROJECT',
    'WORKFLOW_VERCEL_TEAM',
    'WORKFLOW_VERCEL_AUTH_TOKEN',
    'WORKFLOW_VERCEL_ENV',
  ].filter((key) => process.env[key]);
  if (staleEnvVars.length > 0 && process.env.VERCEL === '1') {
    console.warn(
      `[workflow] Warning: ${staleEnvVars.join(', ')} env var(s) ` +
        'are set but have no effect at runtime. These are only used by the Workflow CLI. ' +
        'Remove them from your Vercel project environment variables.'
    );
  }

  return world;
};

export type WorldHandlers = Pick<World, 'createQueueHandler' | 'specVersion'>;

/**
 * Some functions from the world are needed at build time, but we do NOT want
 * to cache the world in those instances for general use, since we don't have
 * the correct environment variables set yet. This is a safe function to
 * call at build time, that only gives access to non-environment-bound world
 * functions. The only binding value should be the target world.
 * Once we migrate to a file-based configuration (workflow.config.ts), we should
 * be able to re-combine getWorld and getWorldHandlers into one singleton.
 */
export const getWorldHandlers = async (): Promise<WorldHandlers> => {
  if (globalSymbols[StubbedWorldCache]) {
    assertWorldSupportsRuntimeProtocol(globalSymbols[StubbedWorldCache]);
    return globalSymbols[StubbedWorldCache];
  }
  // Store the promise immediately to prevent race conditions with concurrent calls.
  // Clear on rejection so subsequent calls can retry instead of caching the failure.
  if (!globalSymbols[StubbedWorldCachePromise]) {
    globalSymbols[StubbedWorldCachePromise] = createWorld().catch((err) => {
      globalSymbols[StubbedWorldCachePromise] = undefined;
      throw err;
    });
  }
  const _world = await globalSymbols[StubbedWorldCachePromise];
  assertWorldSupportsRuntimeProtocol(_world);
  globalSymbols[StubbedWorldCache] = _world;
  return {
    createQueueHandler: _world.createQueueHandler,
    specVersion: _world.specVersion,
  };
};

export const getWorld = async (): Promise<World> => {
  if (globalSymbols[WorldCache]) {
    assertWorldSupportsRuntimeProtocol(globalSymbols[WorldCache]);
    return globalSymbols[WorldCache];
  }
  // Store the promise immediately to prevent race conditions with concurrent calls.
  // Clear on rejection so subsequent calls can retry instead of caching the failure.
  if (!globalSymbols[WorldCachePromise]) {
    globalSymbols[WorldCachePromise] = createWorld().catch((err) => {
      globalSymbols[WorldCachePromise] = undefined;
      throw err;
    });
  }
  globalSymbols[WorldCache] = await globalSymbols[WorldCachePromise];
  assertWorldSupportsRuntimeProtocol(globalSymbols[WorldCache]);
  return globalSymbols[WorldCache];
};

/**
 * Reset the cached world instance. This should be called when environment
 * variables change and you need to reinitialize the world with new config.
 */
export const setWorld = (world: World | undefined): void => {
  globalSymbols[WorldCache] = world;
  globalSymbols[StubbedWorldCache] = world;
  globalSymbols[WorldCachePromise] = undefined;
  globalSymbols[StubbedWorldCachePromise] = undefined;
};

// Register getWorld on globalThis so getWorldLazy can call it directly when
// world.ts is statically present in the bundle.
//
// For server routes that only consume `start` (or another helper that goes
// through getWorldLazy without statically using getWorld), webpack/turbopack
// would otherwise tree-shake world.ts out of the bundle entirely. The
// host-only `./world-init.ts` module imports world.ts for its side effect
// and is itself imported by `packages/workflow/src/api.ts` so this
// registration runs in every server bundle that touches `workflow/api`.
//
// Step/VM bundles never reach this branch: they don't statically import
// world.ts, and `world-init` resolves to an empty stub via the `workflow`
// export condition.
const GetWorldFnKey = Symbol.for('@workflow/world//getWorldFn');
(globalThis as { [GetWorldFnKey]?: () => Promise<World> })[GetWorldFnKey] ??=
  getWorld;
