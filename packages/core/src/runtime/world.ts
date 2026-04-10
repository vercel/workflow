import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isVercelWorldTarget,
  resolveWorkflowTargetWorld,
} from '@workflow/utils';
import type { World } from '@workflow/world';

function getRuntimeRequire() {
  try {
    return createRequire(resolve(process.cwd(), 'package.json'));
  } catch {
    return createRequire(import.meta.url);
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

type LegacyStreamWorld = World & {
  writeToStream?: (
    name: string,
    runId: string,
    chunk: string | Uint8Array
  ) => Promise<void>;
  writeToStreamMulti?: (
    name: string,
    runId: string,
    chunks: (string | Uint8Array)[]
  ) => Promise<void>;
  closeStream?: (name: string, runId: string) => Promise<void>;
  readFromStream?: (
    name: string,
    runId: string,
    startIndex?: number
  ) => Promise<ReadableStream<Uint8Array>>;
  listStreamsByRunId?: (runId: string) => Promise<string[]>;
};

function normalizeLegacyWorld(world: World): World {
  if (world.streams) {
    return world;
  }

  const legacyWorld = world as LegacyStreamWorld;
  const hasLegacyStreams =
    typeof legacyWorld.writeToStream === 'function' ||
    typeof legacyWorld.writeToStreamMulti === 'function' ||
    typeof legacyWorld.closeStream === 'function' ||
    typeof legacyWorld.readFromStream === 'function' ||
    typeof legacyWorld.listStreamsByRunId === 'function';

  if (!hasLegacyStreams) {
    return world;
  }

  const unsupported = async (operation: string): Promise<never> => {
    throw new Error(
      `The configured world does not implement streams.${operation}(). Upgrade the world adapter to the current stream interface.`
    );
  };

  return Object.assign(legacyWorld, {
    streams: {
      write: async (
        runId: string,
        name: string,
        chunk: string | Uint8Array
      ) => {
        if (typeof legacyWorld.writeToStream === 'function') {
          return await legacyWorld.writeToStream(name, runId, chunk);
        }
        return unsupported('write');
      },
      writeMulti:
        typeof legacyWorld.writeToStreamMulti === 'function'
          ? async (
              runId: string,
              name: string,
              chunks: (string | Uint8Array)[]
            ) => legacyWorld.writeToStreamMulti!(name, runId, chunks)
          : undefined,
      close: async (runId: string, name: string) => {
        if (typeof legacyWorld.closeStream === 'function') {
          return await legacyWorld.closeStream(name, runId);
        }
        return unsupported('close');
      },
      get: async (runId: string, name: string, startIndex?: number) => {
        if (typeof legacyWorld.readFromStream === 'function') {
          return await legacyWorld.readFromStream(name, runId, startIndex);
        }
        return unsupported('get');
      },
      list: async (runId: string) => {
        if (typeof legacyWorld.listStreamsByRunId === 'function') {
          return await legacyWorld.listStreamsByRunId(runId);
        }
        return unsupported('list');
      },
      getChunks: async () => unsupported('getChunks'),
      getInfo: async () => unsupported('getInfo'),
    },
  }) as World;
}

/**
 * Hides the dynamic import behind `new Function` to prevent bundlers from
 * trying to resolve it at build time, since the world module may not exist
 * at build time. Falls back to `require()` in environments where
 * `new Function`-based `import()` is unavailable (e.g. CJS test runners).
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>;

function resolveModulePath(specifier: string): string {
  // Already a file:// URL
  if (specifier.startsWith('file://')) {
    return specifier;
  }
  // Absolute path - convert to file:// URL
  if (specifier.startsWith('/')) {
    return pathToFileURL(specifier).href;
  }
  // Relative path - resolve relative to cwd and convert to file:// URL
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return pathToFileURL(resolve(process.cwd(), specifier)).href;
  }
  // Package specifier - use require.resolve to find the package
  try {
    return pathToFileURL(getRuntimeRequire().resolve(specifier)).href;
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

    const { createVercelWorld } = await import('@workflow/world-vercel');
    return normalizeLegacyWorld(createVercelWorld());
  }

  if (targetWorld === 'local') {
    const { createLocalWorld } = await import('@workflow/world-local');
    return normalizeLegacyWorld(
      createLocalWorld({
        dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR,
      })
    );
  }

  // Try dynamic import() first — ESM-first since this PR's purpose is ESM support.
  // Fall back to require() for environments where `new Function`-based import()
  // is unavailable (e.g. CJS test runners).
  let mod: any;
  try {
    const resolvedPath = resolveModulePath(targetWorld);
    mod = await dynamicImport(resolvedPath);
  } catch {
    mod = getRuntimeRequire()(targetWorld);
  }
  if (typeof mod === 'function') {
    return normalizeLegacyWorld(mod() as World);
  } else if (typeof mod.default === 'function') {
    return normalizeLegacyWorld(mod.default() as World);
  } else if (typeof mod.createWorld === 'function') {
    return normalizeLegacyWorld(mod.createWorld() as World);
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
  globalSymbols[StubbedWorldCache] = _world;
  return {
    createQueueHandler: _world.createQueueHandler,
    specVersion: _world.specVersion,
  };
};

export const getWorld = async (): Promise<World> => {
  if (globalSymbols[WorldCache]) {
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
