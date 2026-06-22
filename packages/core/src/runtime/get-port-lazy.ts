import { getPort } from '@workflow/utils/get-port';

// Per-process cache of the resolved port. The workflow dev server listens on a
// stable port for the lifetime of the process, but `getPort()` rediscovers it
// on every call by querying the OS for the process's listening sockets — on
// macOS that shells out to `lsof` (~60ms), which the runtime pays on EVERY
// workflow replay (the non-Vercel branch of `runWorkflow`). Since the port does
// not change within a process, resolve it once and reuse it. `_inFlight`
// dedupes concurrent first calls so discovery never runs more than once.
//
// The first concrete port is pinned for the lifetime of the process — there is
// no per-call re-resolution. This is safe because the runtime only runs inside
// the already-listening dev-server process, and `getPort()` -> `getAllPorts()`
// returns a deterministic order, so repeated calls would resolve the same port
// anyway.
let _getPort: () => Promise<number | undefined> = getPort;
let _cachedPort: number | undefined;
let _inFlight: Promise<number | undefined> | undefined;

export async function getPortLazy(): Promise<number | undefined> {
  // Fast path: already resolved a concrete port for this process.
  if (_cachedPort !== undefined) {
    return _cachedPort;
  }
  // A discovery is already running — share it rather than starting a second.
  if (_inFlight) {
    return _inFlight;
  }

  _inFlight = _getPort()
    .then((port) => {
      // Only cache a concrete port. A transient `undefined` (e.g. the server is
      // not listening yet on the very first replay) must not poison the cache —
      // leaving it unset lets the next call retry discovery.
      if (typeof port === 'number') {
        _cachedPort = port;
      }
      return port;
    })
    .finally(() => {
      _inFlight = undefined;
    });
  return _inFlight;
}

/**
 * Resets the per-process port cache. Intended for tests; not used on the hot
 * path. Callers must let any in-flight lookup settle (await the pending
 * `getPortLazy()` call) before resetting: clearing `_inFlight` here does not
 * cancel an already-scheduled resolution, so a late `.then` could otherwise
 * repopulate `_cachedPort` after the reset and bleed into the next test.
 */
export function resetPortCacheForTesting(): void {
  _getPort = getPort;
  _cachedPort = undefined;
  _inFlight = undefined;
}

/**
 * Installs a fake port resolver and clears the cache. Test-only seam used to
 * exercise the caching contract deterministically without touching the OS.
 */
export function setPortResolverForTesting(
  fn: () => Promise<number | undefined>
): void {
  _getPort = fn;
  _cachedPort = undefined;
  _inFlight = undefined;
}
