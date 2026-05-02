/**
 * Decode the (public, unverified) payload of a JWT to expose a small subset
 * of claims for diagnostic logging.
 *
 * Used on the request-auth path to help diagnose 401/403 responses from the
 * workflow-server: when the deployment-protection trusted-source check fails,
 * the only thing that matters in the proxy/workflow-server logs is whether
 * the inbound `iss`/`aud`/`owner_id`/`project_id` actually match the rule
 * we configured. Surfacing those values into the SDK-side error makes that
 * diagnosis a one-line read instead of "fetch a fresh token, decode by
 * hand, compare against the rule".
 *
 * Signature is intentionally NOT logged — we already had the proxy mint and
 * sign the token, so re-validating it client-side adds no security value;
 * the goal is observability, not trust.
 */
export interface SafeJwtClaims {
  iss?: string;
  aud?: string | string[];
  owner_id?: string;
  project_id?: string;
  environment?: string;
  sub?: string;
  scope?: string;
  exp?: number;
}

const SAFE_CLAIM_KEYS = [
  'iss',
  'aud',
  'owner_id',
  'project_id',
  'environment',
  'sub',
  'scope',
  'exp',
] as const satisfies ReadonlyArray<keyof SafeJwtClaims>;

/**
 * Returns a non-sensitive subset of claims from a JWT, or `null` if the
 * input doesn't look like a JWT. Never throws.
 */
export function decodeSafeJwtClaims(token: string): SafeJwtClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    if (typeof payload !== 'object' || payload === null) return null;
    const out: SafeJwtClaims = {};
    for (const key of SAFE_CLAIM_KEYS) {
      const v = (payload as Record<string, unknown>)[key];
      if (v !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: narrowing by allow-list
        (out as any)[key] = v;
      }
    }
    return out;
  } catch {
    return null;
  }
}
