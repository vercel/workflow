import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isVercelWorldTarget,
  resolveWorkflowTargetWorld,
} from '@workflow/utils';
import type { World } from '@workflow/world';
import {
  getCoreRuntimeRequire,
  getProjectRequire,
  type RuntimeRequire,
} from '../package-require.js';

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

/**
 * Hides the dynamic import behind `new Function` to prevent bundlers from
 * trying to resolve it at build time, since the world module may not exist
 * at build time. Falls back to `require()` in environments where
 * `new Function`-based `import()` is unavailable (e.g. CJS test runners).
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>;

function resolveImportPath(
  specifier: string,
  requireFn: RuntimeRequire
): string {
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
    return pathToFileURL(
      resolve(/* turbopackIgnore: true */ process.cwd(), specifier)
    ).href;
  }
  // Package specifier - use require.resolve to find the package
  try {
    return pathToFileURL(requireFn.resolve(specifier)).href;
  } catch {
    return specifier;
  }
}

function resolveRequirePath(
  specifier: string,
  requireFn: RuntimeRequire
): string {
  if (specifier.startsWith('file://')) {
    return fileURLToPath(specifier);
  }
  if (specifier.startsWith('/')) {
    return specifier;
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolve(/* turbopackIgnore: true */ process.cwd(), specifier);
  }
  try {
    return requireFn.resolve(specifier);
  } catch {
    return specifier;
  }
}

async function loadWorldModule(
  specifier: string,
  requireFn: RuntimeRequire
): Promise<any> {
  try {
    return await dynamicImport(resolveImportPath(specifier, requireFn));
  } catch {
    return requireFn(resolveRequirePath(specifier, requireFn));
  }
}

function resolveWorldFactory(
  mod: any,
  preferredNamedExport?: string
): ((...args: any[]) => World) | undefined {
  if (
    preferredNamedExport &&
    typeof mod?.[preferredNamedExport] === 'function'
  ) {
    return mod[preferredNamedExport] as (...args: any[]) => World;
  }
  if (typeof mod === 'function') {
    return mod as (...args: any[]) => World;
  }
  if (typeof mod?.default === 'function') {
    return mod.default as (...args: any[]) => World;
  }
  if (typeof mod?.createWorld === 'function') {
    return mod.createWorld as (...args: any[]) => World;
  }
  return undefined;
}

function isLocalWorldTarget(targetWorld: string): boolean {
  return targetWorld === 'local' || targetWorld === '@workflow/world-local';
}

function resolveWorldSpecifier(targetWorld: string): string {
  if (isVercelWorldTarget(targetWorld)) {
    return '@workflow/world-vercel';
  }
  if (isLocalWorldTarget(targetWorld)) {
    return '@workflow/world-local';
  }
  return targetWorld;
}

/**
 * Resolve the configured world package once at module load so bundlers/NFT can
 * trace it into server deployments without eagerly loading the module itself.
 *
 * Keep the env access inline so Next/BaseBuilder can replace it with a literal
 * package name in generated bundles.
 */
function traceConfiguredWorldPackage(): void {
  if (!process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE) {
    return;
  }

  try {
    const requireFn =
      isLocalWorldTarget(process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE) ||
      isVercelWorldTarget(process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE)
        ? getCoreRuntimeRequire()
        : getProjectRequire();

    requireFn.resolve(process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE);
  } catch {
    // Actual module loading still happens lazily in createWorld().
  }
}

traceConfiguredWorldPackage();

function warnForStaleVercelEnvVars(): void {
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
}

async function createConfiguredVercelWorld(): Promise<World> {
  warnForStaleVercelEnvVars();

  const mod = await loadWorldModule(
    '@workflow/world-vercel',
    getCoreRuntimeRequire()
  );
  const create = resolveWorldFactory(mod, 'createVercelWorld');
  if (!create) {
    throw new Error(
      'Invalid built-in world module "@workflow/world-vercel": expected createVercelWorld/default export.'
    );
  }
  return create();
}

async function createConfiguredLocalWorld(): Promise<World> {
  const mod = await loadWorldModule(
    '@workflow/world-local',
    getCoreRuntimeRequire()
  );
  const create = resolveWorldFactory(mod, 'createLocalWorld');
  if (!create) {
    throw new Error(
      'Invalid built-in world module "@workflow/world-local": expected createLocalWorld/default export.'
    );
  }
  return create({
    dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR,
  });
}

async function createConfiguredCustomWorld(
  specifier: string,
  targetWorldForErrors: string
): Promise<World> {
  const mod = await loadWorldModule(specifier, getProjectRequire());
  const create = resolveWorldFactory(mod);
  if (create) {
    return create();
  }

  throw new Error(
    `Invalid target world module: ${targetWorldForErrors}, must export a default function or createWorld function that returns a World instance.`
  );
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
  const configuredWorldPackage = process.env.WORKFLOW_CONFIGURED_WORLD_PACKAGE;

  if (configuredWorldPackage === '@workflow/world-vercel') {
    return createConfiguredVercelWorld();
  }

  if (configuredWorldPackage === '@workflow/world-local') {
    return createConfiguredLocalWorld();
  }

  if (configuredWorldPackage) {
    return createConfiguredCustomWorld(
      configuredWorldPackage,
      configuredWorldPackage
    );
  }

  const targetWorld = resolveWorkflowTargetWorld();
  const worldSpecifier = resolveWorldSpecifier(targetWorld);

  if (worldSpecifier === '@workflow/world-vercel') {
    return createConfiguredVercelWorld();
  }

  if (worldSpecifier === '@workflow/world-local') {
    return createConfiguredLocalWorld();
  }

  return createConfiguredCustomWorld(worldSpecifier, targetWorld);
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
