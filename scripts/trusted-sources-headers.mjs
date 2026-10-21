/**
 * Returns headers needed to bypass Vercel Deployment Protection.
 *
 * Module-private: the credential admits its bearer to every protected
 * deployment the trusted-sources rules cover, so it must only ever travel to
 * the host a caller named. `fetchWithTrustedSources` is the only way out,
 * because it is the only thing that can hold that line across redirects.
 *
 * Source preference, in order:
 *   1. **`VERCEL_PROTECTION_BYPASS` env var** — an explicit Protection
 *      Bypass for Automation secret. Useful for local e2e runs against a
 *      protected preview deployment where no GitHub Actions OIDC token is
 *      available.
 *   2. **GitHub Actions runner** — when running inside a job with
 *      `permissions: id-token: write`, the runner exposes
 *      `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`,
 *      and we mint short-lived OIDC tokens on demand. The runner-issued
 *      tokens have a hard 5-minute lifetime; we cache the active token
 *      and re-mint shortly before expiry so a long-running test suite
 *      keeps working past the 5-minute mark (otherwise tests that run
 *      late in the suite would 401 against trusted-sources rules).
 *   3. **`VERCEL_OIDC_TOKEN` env var** — used inside Vercel functions
 *      (the runtime injects the per-request token) and as a manual
 *      override for local development.
 *
 * Returns an empty object when neither source is available, so the result is
 * always safe to merge into request headers regardless of environment. When
 * the target deployment doesn't have Deployment Protection enabled, the header
 * is silently ignored by Vercel's edge.
 *
 * See: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources
 *
 * @returns {Promise<Record<string, string>>}
 */
async function getTrustedSourcesHeaders() {
  if (process.env.VERCEL_PROTECTION_BYPASS) {
    return {
      'x-vercel-protection-bypass': process.env.VERCEL_PROTECTION_BYPASS,
    };
  }

  const token = await getOidcToken();
  if (token) {
    return { 'x-vercel-trusted-oidc-idp-token': token };
  }
  return {};
}

/** Statuses that carry a `Location` worth following. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hops followed before giving up, matching fetch's own redirect limit. */
const MAX_REDIRECTS = 20;

/**
 * @typedef {object} Hop
 * @property {URL} target
 * @property {string} method
 * @property {BodyInit | null | undefined} body
 */

/**
 * The request a redirect response asks for next, or `null` when the chain ends
 * here. The method rewrite mirrors fetch's own, so a followed hop sends what
 * fetch would have sent.
 *
 * @param {Response} response
 * @param {Hop} hop
 * @returns {Hop | null}
 */
function nextHop(response, hop) {
  if (!REDIRECT_STATUSES.has(response.status)) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  const rewriteToGet =
    response.status === 303 ||
    ((response.status === 301 || response.status === 302) &&
      hop.method.toUpperCase() === 'POST');
  return {
    target: new URL(location, hop.target),
    method: rewriteToGet ? 'GET' : hop.method,
    body: rewriteToGet ? undefined : hop.body,
  };
}

/**
 * `fetch` against a deployment, carrying the Deployment Protection credential
 * only to the origin the caller asked for.
 *
 * The target is a deployment of code under test — a preview built from the
 * branch — so its redirects are not ours to trust. Plain `fetch` follows them
 * and re-sends every header except `Authorization`, `Cookie` and
 * `Proxy-Authorization`, so a single `Location: https://attacker.example`
 * hands over `x-vercel-trusted-oidc-idp-token` (a Trusted Source for every
 * project in the team) or `x-vercel-protection-bypass`. Redirects are
 * therefore followed here, one hop at a time, with the credential attached
 * only while the chain stays on the origin the caller named.
 *
 * `init.redirect` is honoured: `'manual'` and `'error'` are handed to `fetch`
 * as-is, since neither leaves this origin.
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchWithTrustedSources(url, init = {}) {
  const credentials = await getTrustedSourcesHeaders();
  const { redirect = 'follow', headers: callerHeaders, ...rest } = init;
  const origin = new URL(url).origin;

  /** @type {Hop} */
  let hop = {
    target: new URL(url),
    method: rest.method ?? 'GET',
    body: rest.body,
  };

  for (let followed = 0; ; followed++) {
    const headers = new Headers(callerHeaders);
    if (hop.target.origin === origin) {
      for (const [name, value] of Object.entries(credentials)) {
        headers.set(name, value);
      }
    }

    const response = await fetch(hop.target, {
      ...rest,
      method: hop.method,
      body: hop.body,
      headers,
      redirect: redirect === 'follow' ? 'manual' : redirect,
    });
    if (redirect !== 'follow') return response;

    const next = nextHop(response, hop);
    if (!next) return response;
    if (followed === MAX_REDIRECTS) {
      throw new TypeError(`Too many redirects following ${url}`);
    }

    // Release the connection before issuing the next hop.
    await response.body?.cancel().catch(() => {});
    hop = next;
  }
}

/**
 * Cached OIDC token state. The runner-issued JWT carries an `exp` claim
 * (5 minutes from issuance); we eagerly refresh `EARLY_REFRESH_MS` before
 * it actually expires so an in-flight request never carries an
 * about-to-expire token.
 */
let cachedToken = null;
/** @type {number} */
let cachedExpiresAtMs = 0;
/** @type {Promise<string | null> | null} */
let inflight = null;
const EARLY_REFRESH_MS = 60_000; // refresh 1 min before expiry

/**
 * @returns {Promise<string | null>}
 */
async function getOidcToken() {
  // Fast path: cached token is still safely fresh.
  const now = Date.now();
  if (cachedToken && now < cachedExpiresAtMs - EARLY_REFRESH_MS) {
    return cachedToken;
  }
  // Coalesce concurrent calls during a refresh.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const minted = await mintFromGitHubActionsRunner();
      if (minted) {
        cachedToken = minted.token;
        cachedExpiresAtMs = minted.expiresAtMs;
        return minted.token;
      }
      // Fall back to the env var (Vercel runtime / local dev).
      const envToken = process.env.VERCEL_OIDC_TOKEN;
      if (envToken) {
        cachedToken = envToken;
        // We can't trust the runner refresh path on env-var tokens, but
        // we also can't introspect their lifetime safely; treat them as
        // long-lived. Setting a far-future expiry effectively pins the
        // value for the lifetime of the process.
        cachedExpiresAtMs = Number.POSITIVE_INFINITY;
        return envToken;
      }
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Mints a fresh OIDC token from the GitHub Actions runner if the
 * required env vars are set; returns `null` otherwise.
 *
 * @returns {Promise<{ token: string, expiresAtMs: number } | null>}
 */
async function mintFromGitHubActionsRunner() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) return null;
  // Audience defaults to `https://github.com/<owner>`; matches the
  // trusted-source rules configured on each Vercel project.
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${requestToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to mint GitHub Actions OIDC token: ${res.status} ${res.statusText}`
    );
  }
  /** @type {{ value?: string }} */
  const body = await res.json();
  const token = body.value;
  if (!token || typeof token !== 'string') {
    throw new Error(
      'Failed to mint GitHub Actions OIDC token: empty/invalid response body'
    );
  }
  // Decode the unsigned `exp` claim so we know when to refresh.
  const expiresAtMs = readJwtExpMs(token);
  return { token, expiresAtMs };
}

/**
 * Reads the `exp` claim (in seconds since epoch) from the JWT payload
 * and returns it in milliseconds. Falls back to "5 minutes from now"
 * (GitHub Actions's documented OIDC token lifetime) if the claim is
 * missing or unparseable.
 *
 * @param {string} jwt
 * @returns {number}
 */
function readJwtExpMs(jwt) {
  const fallback = Date.now() + 5 * 60 * 1000;
  const parts = jwt.split('.');
  if (parts.length !== 3) return fallback;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    if (typeof payload?.exp === 'number') return payload.exp * 1000;
  } catch {
    // ignore — return fallback
  }
  return fallback;
}
