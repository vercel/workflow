import type { Server } from 'srvx';

export interface StartServerOptions {
  /**
   * Host names, besides `localhost`, `*.localhost` and IP addresses, that
   * requests may address the server by in their `Host` header. An array, or a
   * comma-separated string. `.example.com` matches the domain and its
   * subdomains; `true` or `"*"` disables the check. Defaults to
   * `WORKFLOW_WEB_ALLOWED_HOSTS`.
   */
  allowedHosts?: string | string[] | true;
}

/**
 * Start the standalone observability UI server on `port` (defaults to `PORT`, then 3000),
 * and resolve once it is listening.
 */
export function startServer(
  port?: number,
  options?: StartServerOptions
): Promise<Server>;
