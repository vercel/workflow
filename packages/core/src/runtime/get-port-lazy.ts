/**
 * Lazy loader for getPort that prevents bundlers (Turbopack, esbuild)
 * from statically tracing @workflow/utils/get-port and its filesystem
 * operations (readdir, readFile, readlink) into the flow route bundle.
 *
 * Uses createRequire with a dynamically constructed specifier so the
 * dependency is invisible to bundler static analysis.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { globalSingleton } from '@workflow/utils';
import { runtimeLogger } from '../logger.js';

// All three live on `globalThis` (see `globalSingleton`) rather than at module
// scope. The resolved port is a fact about the process, not about one copy of
// this module, and per-copy caches would each pay the ~60ms `lsof` discovery
// and could each pin their own answer.
const portState = globalSingleton('@workflow/core//devServerPort', 1, () => ({
  getPort: undefined as (() => Promise<number | undefined>) | undefined,
  cachedPort: undefined as number | undefined,
  inFlight: undefined as Promise<number | undefined> | undefined,
}));

// Per-process cache of the resolved port. The workflow server listens on a
// stable port for the lifetime of the process, but `getPort()` rediscovers it
// on every call by querying the OS for the process's listening sockets. On
// macOS that shells out to `lsof` (~60ms), which the runtime pays on EVERY
// workflow replay or step invocation. Since the port does not change within a
// process, resolve it once and reuse it. `portState.inFlight`
// dedupes concurrent first calls so discovery never runs more than once.
//
// The first concrete port is pinned for the lifetime of the process: there is
// no per-call re-resolution. This is safe because the runtime only runs inside
// the already-listening dev-server process, and `getPort()` -> `getAllPorts()`
// returns a deterministic order, so repeated calls would resolve the same port
// anyway.

export async function getPortLazy(): Promise<number | undefined> {
  // Fast path: already resolved a concrete port for this process.
  if (portState.cachedPort !== undefined) {
    return portState.cachedPort;
  }
  // A discovery is already running, so share it rather than starting a second.
  if (portState.inFlight) {
    return portState.inFlight;
  }

  // An explicit `PORT` wins over detection, matching the order the local
  // world uses to address its own queue requests. It also skips the OS query.
  const envPort = parseEnvPort(process.env.PORT);
  if (envPort !== undefined) {
    return envPort;
  }

  if (!portState.getPort) {
    portState.getPort = loadGetPort();
  }

  // `portState.getPort` is always assigned by the block above; the fallback keeps the
  // type non-nullable without a non-null assertion.
  const resolver = portState.getPort ?? (async () => undefined);
  portState.inFlight = resolver()
    .then((port) => {
      // Only cache a concrete port. A transient `undefined` (e.g. the server is
      // not listening yet on the first replay) must not poison the cache:
      // leaving it unset lets the next call retry discovery.
      if (typeof port === 'number') {
        portState.cachedPort = port;
      }
      return port;
    })
    .finally(() => {
      portState.inFlight = undefined;
    });
  return portState.inFlight;
}

function parseEnvPort(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Loads `getPort` from `@workflow/utils/get-port`.
 *
 * The specifier is resolved from a chain of bases rather than only from
 * `process.cwd()`. Under a strict `node_modules` layout (pnpm without
 * hoisting) the app usually depends on `workflow` but not on
 * `@workflow/utils`, so a cwd-based lookup fails. `workflow` and
 * `@workflow/core` both depend on `@workflow/utils`, so resolving relative to
 * either package finds it. `import.meta.url` is not used as a base because it
 * is unavailable in CJS re-bundled outputs.
 */
function loadGetPort(): () => Promise<number | undefined> {
  // Construct specifiers at runtime to defeat bundler static analysis.
  const spec = ['@workflow/utils', 'get-port'].join('/');
  const errors: string[] = [];
  const record = (error: unknown) =>
    errors.push(error instanceof Error ? error.message : String(error));

  let req: NodeJS.Require;
  try {
    req = createRequire(pathToFileURL(`${process.cwd()}/package.json`).href);
  } catch (error) {
    record(error);
    return failedGetPort(errors);
  }
  // Each hop resolves the next package relative to the last base that
  // resolved: cwd -> `workflow` -> `@workflow/core`. A hop that does not
  // resolve is skipped, so an app depending on `@workflow/core` alone is
  // still covered.
  const hops = ['workflow', ['@workflow', 'core'].join('/')];
  for (let i = 0; ; i++) {
    try {
      const mod = req(spec);
      if (typeof mod?.getPort === 'function') {
        return mod.getPort;
      }
      record(`${spec} has no getPort export`);
    } catch (error) {
      record(error);
    }
    let advanced = false;
    while (!advanced && i < hops.length) {
      try {
        req = createRequire(req.resolve(hops[i]));
        advanced = true;
      } catch (error) {
        record(error);
        i++;
      }
    }
    if (!advanced) return failedGetPort(errors);
  }
}

// Prints once per process: the failed loader is cached in `portState.getPort`,
// so later calls never reach it again. Only non-Vercel deployments resolve the
// port (on Vercel the URL comes from `VERCEL_URL`), so this never prints there.
function failedGetPort(errors: string[]): () => Promise<number | undefined> {
  runtimeLogger.warn(
    'Could not detect the port this server listens on, so webhook and workflow URLs fall back to port 3000. Set the PORT environment variable to the port your server listens on.',
    { errors }
  );
  return async () => undefined;
}

/**
 * Resets the per-process port cache. Intended for tests; not used on the hot
 * path. Callers must let any in-flight lookup settle (await the pending
 * `getPortLazy()` call) before resetting: clearing `portState.inFlight` here does not
 * cancel an already-scheduled resolution, so a late `.then` could otherwise
 * repopulate `portState.cachedPort` after the reset and bleed into the next test.
 */
export function resetPortCacheForTesting(): void {
  portState.getPort = undefined;
  portState.cachedPort = undefined;
  portState.inFlight = undefined;
}

/**
 * Installs a fake port resolver and clears the cache. Test-only seam: the real
 * resolver is loaded via `createRequire` with a runtime-built specifier (to
 * hide it from bundlers), which also defeats module mocking, so injection is
 * the only deterministic way to exercise the caching contract.
 */
export function setPortResolverForTesting(
  fn: () => Promise<number | undefined>
): void {
  portState.getPort = fn;
  portState.cachedPort = undefined;
  portState.inFlight = undefined;
}
