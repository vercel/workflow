/**
 * Transport selection for the HTTP-backed Worlds (Vercel and local).
 *
 * Both adapters normally hand `fetch()` a hand-built undici `Agent` (wrapped in
 * a `RetryAgent`) so they can set connection pooling, HTTP/2, receive windows,
 * per-request timeouts, and a retry policy tuned per call site. Node's own
 * `fetch` is undici too, but it dispatches through the runtime's global agent
 * with none of that configuration.
 *
 * {@link NATIVE_FETCH_ENV_VAR} selects between the two. It exists so a
 * deployment (or a runtime that does not ship a working `undici` package, e.g.
 * a bundler that mangles undici's `node:http2` require) can drop the custom
 * dispatchers and run on whatever the platform's `fetch` provides.
 */

import { envFlag } from './env-config.js';

/** Environment variable that selects the runtime's own `fetch` transport. */
export const NATIVE_FETCH_ENV_VAR = 'WORKFLOW_NATIVE_FETCH';

/**
 * Default for {@link NATIVE_FETCH_ENV_VAR}.
 *
 * TODO(before merge): flip to `false` so native fetch is opt-in. It ships
 * default-on only so CI exercises the new transport on every lane.
 */
export const NATIVE_FETCH_DEFAULT = true;

/**
 * Whether the HTTP Worlds should skip their custom undici dispatchers and let
 * `fetch()` use the runtime's global agent.
 *
 * Read lazily on every call rather than at module load, so a test or a single
 * process can exercise both transports.
 *
 * An explicitly-supplied dispatcher (`createVercelWorld({ dispatcher })`) still
 * wins over this flag: the flag governs which *default* the adapter builds, not
 * whether a caller may override it.
 */
export function isNativeFetchEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return envFlag(NATIVE_FETCH_ENV_VAR, NATIVE_FETCH_DEFAULT, env);
}
