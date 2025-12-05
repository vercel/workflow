import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { createVercelWorld } from '@workflow/world-vercel';

const require = createRequire(join(process.cwd(), 'index.js'));

const WorldCache = Symbol.for('@workflow/world//cache');
const StubbedWorldCache = Symbol.for('@workflow/world//stubbedCache');

const globalSymbols: typeof globalThis & {
  [WorldCache]?: World;
  [StubbedWorldCache]?: World;
} = globalThis;

function defaultWorld(): 'vercel' | 'local' {
  if (process.env.VERCEL_DEPLOYMENT_ID) {
    return 'vercel';
  }

  return 'local';
}

/**
 * Create a new world instance based on environment variables.
 * WORKFLOW_TARGET_WORLD is used to determine the target world.
 * All other environment variables are specific to the target world
 */
export const createWorld = (): World => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD || defaultWorld();

  if (targetWorld === 'vercel') {
    return createVercelWorld({
      baseUrl: process.env.WORKFLOW_VERCEL_PROXY_URL,
      token: process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
      projectConfig: {
        environment: process.env.WORKFLOW_VERCEL_ENV,
        projectId: process.env.WORKFLOW_VERCEL_PROJECT,
        teamId: process.env.WORKFLOW_VERCEL_TEAM,
      },
    });
  }

  if (targetWorld === 'local') {
    return createLocalWorld({
      dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR,
    });
  }

  const mod = require(targetWorld);
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

/**
 * Some functions from the world are needed at build time, but we do NOT want
 * to cache the world in those instances for general use, since we don't have
 * the correct environment variables set yet. This is a safe function to
 * call at build time, that only gives access to non-environment-bound world
 * functions. The only binding value should be the target world.
 * Once we migrate to a file-based configuration (workflow.config.ts), we should
 * be able to re-combine getWorld and getWorldHandlers into one singleton.
 */
export const getWorldHandlers = (): Pick<World, 'createQueueHandler'> => {
  if (globalSymbols[StubbedWorldCache]) {
    return globalSymbols[StubbedWorldCache];
  }
  const _world = createWorld();
  globalSymbols[StubbedWorldCache] = _world;
  return {
    createQueueHandler: _world.createQueueHandler,
  };
};

export const getWorld = (): World => {
  if (globalSymbols[WorldCache]) {
    return globalSymbols[WorldCache];
  }
  globalSymbols[WorldCache] = createWorld();
  return globalSymbols[WorldCache];
};

/**
 * Reset the cached world instance. This should be called when environment
 * variables change and you need to reinitialize the world with new config.
 */
export const setWorld = (world: World | undefined): void => {
  globalSymbols[WorldCache] = world;
  globalSymbols[StubbedWorldCache] = world;
};
