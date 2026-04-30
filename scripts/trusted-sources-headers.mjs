/**
 * Returns headers needed to bypass Vercel Deployment Protection via OIDC
 * Trusted Sources. Reads `VERCEL_TRUSTED_OIDC_TOKEN` from the environment
 * (set by GitHub Actions via `core.getIDToken()` in CI).
 *
 * Returns an empty object when no token is set, so this can be safely
 * spread into request headers regardless of environment.
 *
 * See: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources
 *
 * @returns {Record<string, string>}
 */
export function getTrustedSourcesHeaders() {
  const oidcToken = process.env.VERCEL_TRUSTED_OIDC_TOKEN;
  if (oidcToken) {
    return { 'x-vercel-trusted-oidc-idp-token': oidcToken };
  }
  return {};
}
