/**
 * Request guard for the standalone server (`server.js`) against DNS rebinding
 * and cross-site writes.
 *
 * The UI has no authentication, so the only thing keeping a web page on an
 * unrelated site from talking to it is the browser's same-origin policy. DNS
 * rebinding defeats that policy: the attacker's page re-points its own host
 * name at an address this server listens on, and from then on its requests are
 * same-origin and their responses readable. Such a request always carries the
 * attacker's host name in its `Host` header, which is what this guard rejects.
 *
 * Accepted `Host` values:
 * - `localhost` and `*.localhost` (resolved to loopback by browsers, never by
 *   an attacker's DNS);
 * - IP literals, which involve no DNS lookup and so cannot be rebound;
 * - names listed in `allowedHosts` (exact names, or `.example.com` for a domain
 *   and all its subdomains), or every name when `allowedHosts` is `true`.
 *
 * Unsafe methods additionally require that an `Origin` header, when present,
 * names the same host as `Host` or a name in `allowedHosts`, so that a
 * cross-site page cannot send blind writes either.
 *
 * The guard does not restrict which interfaces the server listens on: a client
 * that can reach the machine directly can still address it by IP. The UI has
 * no authentication, so network exposure is for the operator to control.
 *
 * Internal: ships in the package for `server.js` but is not in the `exports`
 * map.
 */

import { isIP } from 'node:net';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Split a `Host` header value (or URL host) into its lowercased host name,
 * without port, brackets, or trailing dot. Returns undefined when malformed.
 *
 * @param {string | null | undefined} host
 * @returns {string | undefined}
 */
export function parseHostHeader(host) {
  if (!host) return undefined;
  const value = host.trim().toLowerCase();
  let name;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return undefined;
    const rest = value.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return undefined;
    name = value.slice(1, end);
    return isIP(name) === 6 ? name : undefined;
  }
  const colon = value.indexOf(':');
  if (colon !== -1) {
    if (!/^\d+$/.test(value.slice(colon + 1))) return undefined;
    name = value.slice(0, colon);
  } else {
    name = value;
  }
  if (name.endsWith('.')) name = name.slice(0, -1);
  return name || undefined;
}

/**
 * Parse `WORKFLOW_WEB_ALLOWED_HOSTS`-style input: a comma-separated list, or
 * `true`/`*` for any host.
 *
 * @param {string | undefined} value
 * @returns {string[] | true}
 */
export function parseAllowedHosts(value) {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed === '*' || trimmed.toLowerCase() === 'true') return true;
  return trimmed
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Normalize the `allowedHosts` option: an array of names, a comma-separated
 * string, or `true` for any host.
 *
 * @param {string | string[] | true | undefined} value
 * @returns {string[] | true}
 */
export function normalizeAllowedHosts(value) {
  if (value === true) return true;
  if (Array.isArray(value)) {
    if (value.includes('*')) return true;
    return value.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  }
  return parseAllowedHosts(value);
}

/**
 * @param {string | null | undefined} hostHeader
 * @param {string[] | true} [allowedHosts]
 * @returns {boolean}
 */
export function isAllowedHost(hostHeader, allowedHosts = []) {
  if (allowedHosts === true) return true;
  const name = parseHostHeader(hostHeader);
  if (!name) return false;
  if (isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  return matchesAllowList(name, allowedHosts);
}

/**
 * @param {string} name - Parsed host name.
 * @param {string[]} allowedHosts
 * @returns {boolean}
 */
function matchesAllowList(name, allowedHosts) {
  for (const entry of allowedHosts) {
    if (entry.startsWith('.')) {
      if (name === entry.slice(1) || name.endsWith(entry)) return true;
    } else if (name === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Return a rejection `Response` for a request that fails the guard, or
 * undefined when the request may proceed.
 *
 * @param {Request} request
 * @param {string[] | true} [allowedHosts]
 * @returns {Response | undefined}
 */
export function checkRequest(request, allowedHosts = []) {
  const host = request.headers.get('host');
  if (!isAllowedHost(host, allowedHosts)) {
    return new Response(
      'Forbidden: unrecognized Host header. To serve the workflow web UI under ' +
        'this host name, add it to WORKFLOW_WEB_ALLOWED_HOSTS.\n',
      { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }

  if (!SAFE_METHODS.has(request.method)) {
    const origin = request.headers.get('origin');
    if (origin) {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined;
      }
      // Same origin compares the full host (name and port), so another local
      // origin on a different port is cross-origin. An origin on an explicitly
      // allowed name also passes, for reverse proxies that rewrite `Host` to
      // the upstream address.
      const sameOrigin =
        originHost !== undefined &&
        originHost.toLowerCase() === host?.toLowerCase();
      const allowedOrigin =
        originHost !== undefined &&
        (allowedHosts === true ||
          matchesAllowList(parseHostHeader(originHost) ?? '', allowedHosts));
      if (!sameOrigin && !allowedOrigin) {
        return new Response('Forbidden: cross-origin request\n', {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
    }
  }

  return undefined;
}
