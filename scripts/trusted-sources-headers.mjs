/**
 * Returns headers needed to bypass Vercel Deployment Protection via OIDC
 * Trusted Sources. Reads `VERCEL_OIDC_TOKEN` from the environment, matching
 * Vercel's convention (`@vercel/oidc`'s `getVercelOidcToken()` reads the
 * same variable). In CI we populate it via `core.getIDToken()` from the
 * GitHub Actions runner.
 *
 * Returns an empty object when no token is set, so this can be safely
 * spread into request headers regardless of environment. When the target
 * deployment doesn't have Deployment Protection enabled, the header is
 * silently ignored by Vercel's edge.
 *
 * See: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources
 *
 * @returns {Record<string, string>}
 */
export function getTrustedSourcesHeaders() {
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  if (oidcToken) {
    return { 'x-vercel-trusted-oidc-idp-token': oidcToken };
  }
  return {};
}
