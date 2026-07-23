import * as targetWorldModule from '@workflow/core/runtime/world-target';
import type { World } from '@workflow/world';
import { assertWorldSupportsRuntimeProtocol } from './world-compatibility.js';

const WorldCache = Symbol.for('@workflow/world//cache');
const StubbedWorldCache = Symbol.for('@workflow/world//stubbedCache');
const WorldCachePromise = Symbol.for('@workflow/world//cachePromise');
const StubbedWorldCachePromise = Symbol.for(
  '@workflow/world//stubbedCachePromise'
);
const WorldStartPromise = Symbol.for('@workflow/world//startPromise');

const globalSymbols: typeof globalThis & {
  [WorldCache]?: World;
  [StubbedWorldCache]?: World;
  [WorldCachePromise]?: Promise<World>;
  [StubbedWorldCachePromise]?: Promise<World>;
  [WorldStartPromise]?: Promise<void>;
} = globalThis;

export type WorldFactoryModule = {
  createWorld?: () => World | Promise<World>;
  /** @deprecated World packages should export `createWorld()` instead. */
  createLocalWorld?: () => World | Promise<World>;
  /** @deprecated World packages should export `createWorld()` instead. */
  createVercelWorld?: () => World | Promise<World>;
  default?: (() => World | Promise<World>) | World;
};

/**
 * Create a World instance from a world factory module. Shared by
 * `createWorld()` (for the statically injected target world module) and
 * tooling that loads a world module dynamically (e.g. the Nitro dev
 * handler and `@workflow/world-testing`). Legacy world-specific factory
 * names are still accepted for compatibility, but world packages should
 * export `createWorld()`.
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
    'Invalid target world module: must export createWorld(), a default factory, or a default World instance.'
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
 * Ensure the World's background tasks are started exactly once per process,
 * and that boot-time recovery (`reenqueueActiveRuns` for queue-backed Worlds)
 * runs. Framework integrations call this at server startup — e.g. a Next.js
 * `instrumentation.ts`, a Nitro server plugin, a SvelteKit `init` hook — so
 * that in-flight runs resume after a restart WITHOUT requiring a workflow
 * operation to wake the process.
 *
 * Idempotent: the start promise is cached on `globalThis` and reused, so
 * repeated calls (e.g. Next.js invoking `register()` for multiple runtimes)
 * start the World only once. Safe to call regardless of the target World — for
 * push-based Worlds (Vercel) `world.start()` is a no-op.
 *
 * Development vs production: in production, in-flight runs are recovered
 * (re-enqueued). In development they are **cancelled** instead — the workflow
 * code has likely changed since they started, so replaying them would diverge.
 * Pass `options.dev` from your framework's authoritative dev flag (e.g. Nitro's
 * `nitro.options.dev`, SvelteKit's `$app/environment` `dev`, Astro's
 * `import.meta.env.DEV`); when omitted it falls back to
 * `process.env.NODE_ENV === 'development'`. Set `WORKFLOW_RECOVER_IN_DEV=1` to
 * force recovery even in development (e.g. to debug recovery itself).
 *
 * Fail-open: this never throws. Boot-time recovery is best-effort, so a
 * transient failure (e.g. the database is briefly unreachable at startup) must
 * not prevent the server from coming up — runs are durable and will be
 * recovered on a later start() or, for queue-backed Worlds, the next enqueue.
 * Failures are logged and the cached promise is cleared so a subsequent call
 * retries rather than reusing the rejection. Callers (and the docs samples)
 * can therefore `await ensureWorldStarted()` unguarded.
 */
export interface EnsureWorldStartedOptions {
  /**
   * Whether this is a development server. In dev, in-flight runs from a previous
   * session are cancelled rather than recovered (their workflow code may have
   * changed). Defaults to `process.env.NODE_ENV === 'development'`.
   */
  dev?: boolean;
}

export const ensureWorldStarted = async (
  options?: EnsureWorldStartedOptions
): Promise<void> => {
  const isDev = options?.dev ?? process.env.NODE_ENV === 'development';
  const recoverInDev = process.env.WORKFLOW_RECOVER_IN_DEV === '1';
  const onRestart = isDev && !recoverInDev ? 'cancel' : 'recover';
  if (!globalSymbols[WorldStartPromise]) {
    globalSymbols[WorldStartPromise] = (async () => {
      const world = await getWorld();
      await world.start?.({ onRestart });
    })().catch((err) => {
      globalSymbols[WorldStartPromise] = undefined;
      console.error(
        '[workflow] Failed to start the World for boot-time recovery. ' +
          'In-flight runs may not resume until the next successful start; ' +
          'this is non-fatal and the server will continue to start.',
        err
      );
    });
  }
  await globalSymbols[WorldStartPromise];
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
  // Clear the start guard too: a freshly injected world has not been started,
  // so a subsequent ensureWorldStarted() should start it rather than no-op on
  // the previous world's cached promise.
  globalSymbols[WorldStartPromise] = undefined;
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
