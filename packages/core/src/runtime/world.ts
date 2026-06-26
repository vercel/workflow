import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  isVercelWorldTarget,
  resolveWorkflowTargetWorld,
} from '@workflow/utils';
import type { World } from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { createVercelWorld } from '@workflow/world-vercel';
import { assertWorldSupportsRuntimeProtocol } from './world-compatibility.js';

function getRuntimeRequire() {
  // Resolve from the app root (process.cwd()) so custom world packages
  // like @workflow/world-postgres can be found even though they're not
  // dependencies of @workflow/core. Using import.meta.url would resolve
  // from core's location, missing app-level packages.
  try {
    return createRequire(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      pathToFileURL(process.cwd() + '/package.json').href
    );
  } catch {
    return createRequire(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      import.meta.url
    );
  }
}

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

// Dynamic import for custom world modules. Uses a standard import()
// wrapped in a try/catch with require() fallback for CJS test runners.
// Note: the previous `new Function('specifier', 'return import(specifier)')`
// pattern was replaced because Turbopack (Next.js) treats unresolvable
// dynamic imports from `new Function` as fatal build errors in the V2
// combined flow route context.

function resolveModulePath(specifier: string): string {
  // Already a file:// URL
  if (specifier.startsWith('file://')) {
    return specifier;
  }
  // Absolute path - convert to file:// URL
  if (specifier.startsWith('/')) {
    return pathToFileURL(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      specifier
    ).href;
  }
  // Relative path - resolve relative to cwd and convert to file:// URL
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return pathToFileURL(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      process.cwd() + '/' + specifier
    ).href;
  }
  // Package specifier - use require.resolve to find the package
  try {
    return pathToFileURL(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      getRuntimeRequire().resolve(
        /* webpackIgnore: true */
        /* turbopackIgnore: true */
        specifier
      )
    ).href;
  } catch {
    return specifier;
  }
}

/**
 * Create a new world instance based on environment variables.
 * WORKFLOW_TARGET_WORLD is used to determine the target world.
 *
 * Note: WORKFLOW_VERCEL_* env vars (PROJECT, TEAM, AUTH_TOKEN, etc.) are
 * intentionally NOT read here. Those are for CLI/observability tooling only
 * and should not affect runtime behavior. The Vercel runtime provides
 * authentication via OIDC tokens and project context via system env vars
 * (VERCEL_DEPLOYMENT_ID, VERCEL_PROJECT_ID). Tooling that needs these env
 * vars should call createVercelWorld() directly with an explicit config and
 * use setWorld() to inject the instance.
 */
export const createWorld = async (): Promise<World> => {
  const targetWorld = resolveWorkflowTargetWorld();

  if (isVercelWorldTarget(targetWorld)) {
    // Warn if WORKFLOW_VERCEL_* env vars are set inside a Vercel serverless
    // function (VERCEL=1) — they have no effect at runtime and likely indicate
    // a misconfiguration (user manually added them as Vercel project env vars,
    // which is not needed). We gate on VERCEL=1 so the warning does not fire
    // when the CLI or web observability app sets these env vars intentionally.
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

    return createVercelWorld();
  }

  if (targetWorld === 'local') {
    return createLocalWorld({
      dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR,
    });
  }

  // Try require() first for custom worlds — this avoids Turbopack tracing
  // a dynamic import() that it can't statically resolve. Fall back to
  // dynamic import() for ESM-only packages.
  let mod: any;
  try {
    mod = getRuntimeRequire()(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      targetWorld
    );
  } catch {
    const resolvedPath = resolveModulePath(targetWorld);
    mod = await import(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      resolvedPath
    );
  }
  if (typeof mod === 'function') {
    return mod() as World;
  } else if (typeof mod.default === 'function') {
    return mod.default() as World;
  } else if (typeof mod.createWorld === 'function') {
    return mod.createWorld() as World;
  }

  throw new Error(
    `Invalid target world module: ${targetWorld}, must export a default function or createWorld function that returns a World instance.`
  );
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
// world.ts is statically present in the bundle. This avoids the relative
// dynamic import('./world.js') fallback in get-world-lazy.ts, which fails
// after Next.js inlines get-world-lazy.js into a route bundle (no sibling
// world.js exists at the bundled location).
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
