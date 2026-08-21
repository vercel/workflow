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

  if (!portState.getPort) {
    try {
      // Construct specifier at runtime to defeat bundler static analysis.
      const spec = ['@workflow/utils', 'get-port'].join('/');
      // Use process.cwd()-based createRequire for CJS/ESM compatibility.
      // import.meta.url is unavailable in CJS re-bundled outputs.
      const _require = createRequire(
        pathToFileURL(process.cwd() + '/package.json').href
      );
      const mod = _require(spec);
      portState.getPort = mod.getPort;
    } catch {
      // Module not available (e.g., in a browser or minimal bundle)
      portState.getPort = async () => undefined;
    }
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
