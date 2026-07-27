import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  isVercelWorldTarget,
  resolveWorkflowTargetWorld,
} from '@workflow/utils';
import type { World } from '@workflow/world';
import { createWorld as createLocalWorld } from '@workflow/world-local';
import { createWorld as createVercelWorld } from '@workflow/world-vercel';
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

export type WorldFactoryModule = {
  createWorld?: () => World | Promise<World>;
  default?: (() => World | Promise<World>) | World;
};

/**
 * Create a World instance from a world factory module. Shared by
 * `createWorld()` (for the world package named by WORKFLOW_TARGET_WORLD) and
 * tooling that loads a world module dynamically (e.g. the Nitro dev
 * handler and `@workflow/world-testing`). World packages should export
 * `createWorld()`.
 */
export function createWorldFromModule(
  mod: WorldFactoryModule
): World | Promise<World> {
  if (typeof mod.createWorld === 'function') {
    return mod.createWorld();
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

// Dynamic import for custom world modules. Uses a standard import()
// wrapped in a try/catch with require() fallback for CJS test runners.
// Note: the previous `new Function('specifier', 'return import(specifier)')`
// pattern was replaced because Turbopack (Next.js) treats unresolvable
// dynamic imports from `new Function` as fatal build errors in the V2
// combined flow route context.
//
// The `webpackIgnore`/`turbopackIgnore` comments below are load-bearing: they
// are what stop webpack and Turbopack from rewriting the expression `import()`
// into a throwing "expression is too dynamic" stub. `world-bundler-safety.test.ts`
// asserts they stay attached to every non-literal import/require in this file.

/**
 * Error text bundlers emit at runtime when they have replaced a dynamic
 * `import()`/`require()` of a non-literal specifier with a throwing stub
 * instead of leaving the native call in place. These messages say nothing
 * about the workflow world, so they get rewrapped with actionable guidance
 * (see `loadWorldModule`) rather than surfacing raw.
 *
 * The o2flow `workflow@5.0.0-beta.26` incident surfaced the Turbopack variant
 * ("Cannot find module as expression is too dynamic") from a different code
 * path — see `packages/core/e2e/route-bundle-isolation.test.ts`.
 */
const BUNDLER_STUB_ERROR_SIGNATURES = [
  'expression is too dynamic', // Turbopack
  'the request of a dependency is an expression', // webpack
  'Cannot find module as expression', // Turbopack (older wording)
];

function isBundlerStubError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return BUNDLER_STUB_ERROR_SIGNATURES.some((signature) =>
    message.includes(signature)
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load the module named by `WORKFLOW_TARGET_WORLD` for a custom (non-built-in)
 * world.
 *
 * Both resolution strategies are best-effort by nature: the world package is
 * not a dependency of `@workflow/core`, so it is resolved from the app root at
 * runtime and is not part of the host bundle. That fails in two ways worth
 * telling the user about explicitly, because neither raw error mentions
 * workflows:
 *
 * 1. Self-contained outputs (Nitro's `.output/server`, an esbuild bundle, a
 *    Docker image built without the world package) have no resolvable copy of
 *    the package at runtime -> `ERR_MODULE_NOT_FOUND`.
 * 2. A bundler stripped the ignore comments (or never honored them) and
 *    replaced the `import()` with a stub -> "expression is too dynamic".
 *
 * In both cases the fix is the same and is not discoverable from the raw
 * error: import the world statically at server boot and register it with
 * `setWorld()`.
 */
async function loadWorldModule(targetWorld: string): Promise<unknown> {
  const attempts: string[] = [];

  // Try require() first for custom worlds — this avoids Turbopack tracing
  // a dynamic import() that it can't statically resolve. Fall back to
  // dynamic import() for ESM-only packages.
  try {
    return getRuntimeRequire()(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      targetWorld
    );
  } catch (requireError) {
    attempts.push(`require("${targetWorld}"): ${describeError(requireError)}`);
  }

  const resolvedPath = resolveModulePath(targetWorld);
  try {
    return await import(
      /* webpackIgnore: true */
      /* turbopackIgnore: true */
      resolvedPath
    );
  } catch (importError) {
    attempts.push(`import("${resolvedPath}"): ${describeError(importError)}`);

    const bundlerHint = isBundlerStubError(importError)
      ? '\nThe import above was replaced by a bundler stub, so the world package ' +
        'can never be resolved at runtime from this bundle.'
      : '';

    throw new Error(
      `Could not load the workflow world package "${targetWorld}" named by ` +
        'WORKFLOW_TARGET_WORLD.' +
        bundlerHint +
        '\nIf the package is not resolvable from the running output (a ' +
        'self-contained server bundle, or a bundler that rewrote the dynamic ' +
        'import), import it statically at server boot and register it instead ' +
        `of relying on WORKFLOW_TARGET_WORLD:\n  import { createWorld } from '${targetWorld}';\n` +
        "  import { setWorld } from 'workflow/runtime';\n" +
        '  setWorld(await createWorld());\n' +
        `Resolution attempts:\n  - ${attempts.join('\n  - ')}`,
      { cause: importError }
    );
  }
}

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
 * vars should call the Vercel world's createWorld() directly with an explicit
 * config and use setWorld() to inject the instance.
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

  const mod = await loadWorldModule(targetWorld);
  if (typeof mod === 'function') {
    return mod() as World;
  }

  try {
    return await createWorldFromModule(mod as WorldFactoryModule);
  } catch (error) {
    throw new Error(
      `Invalid target world module: ${targetWorld}, must export a createWorld function or a default function that returns a World instance.`,
      { cause: error }
    );
  }
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
