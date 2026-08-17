/**
 * Transport selection for the HTTP-backed Worlds (Vercel and local).
 *
 * Both adapters normally issue their requests through the global `fetch`,
 * handing it a hand-built undici `Agent` (wrapped in a `RetryAgent`) so they can
 * set connection pooling, HTTP/2, receive windows, per-request timeouts, and a
 * retry policy tuned per call site. That is undici twice over: the dispatcher
 * the adapter builds, and the undici implementation behind `fetch` itself.
 *
 * {@link NODE_HTTP_ENV_VAR} switches those requests onto a client built on
 * `node:http` / `node:https`, which reach the network through `node:net` /
 * `node:tls` with no undici in the path at all. It exists for a deployment
 * where undici is not a usable dependency: a bundler that mangles its
 * `node:http2` require, or a runtime that ships no working copy of it.
 *
 * See `@workflow/world/node-http.js` for the client itself, and the
 * `WORKFLOW_NODE_HTTP` docs entry for what the swap costs.
 */

import { envFlag } from './env-config.js';

/** Environment variable that selects the `node:http` / `node:https` transport. */
export const NODE_HTTP_ENV_VAR = 'WORKFLOW_NODE_HTTP';

/**
 * Default for {@link NODE_HTTP_ENV_VAR}.
 *
 * The undici path stays the default because it is the one every deployment has
 * run so far. This transport is opt-in, for the deployments that cannot use
 * undici at all.
 */
export const NODE_HTTP_DEFAULT = false;

/**
 * Whether the HTTP Worlds should send their requests over Node's core HTTP
 * client instead of `fetch` + a custom undici dispatcher.
 *
 * Read lazily on every call rather than at module load, so a test or a single
 * process can exercise both transports.
 *
 * An explicitly-supplied dispatcher (`createVercelWorld({ dispatcher })`) still
 * wins over this flag: passing one is an instruction to use undici, so the
 * request goes back through `fetch` with that dispatcher.
 */
export function isNodeHttpEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return envFlag(NODE_HTTP_ENV_VAR, NODE_HTTP_DEFAULT, env);
}
