/**
 * Resolve the latest deployment ID for the current deployment's environment.
 *
 * Calls the Vercel API to find the most recent deployment that shares the same
 * environment (e.g., same "production" target or same git branch for "preview"
 * deployments) as the provided current deployment.
 */

import { getVercelOidcToken } from '@vercel/oidc';
import * as z from 'zod';
import { getDispatcher } from './http-client.js';
import type { APIConfig } from './utils.js';

const ResolveLatestDeploymentResponseSchema = z.object({
  id: z.string(),
});

/**
 * Create the `resolveLatestDeploymentId` implementation for a Vercel World.
 *
 * Resolves the most recent deployment ID for the same environment as the
 * current deployment by calling the Vercel API.
 *
 * @param config - API configuration (token, project config, etc.)
 * @returns The `resolveLatestDeploymentId` function
 */
export function createResolveLatestDeploymentId(
  config?: APIConfig
): () => Promise<string> {
  return async function resolveLatestDeploymentId(): Promise<string> {
    const currentDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (!currentDeploymentId) {
      throw new Error(
        'Cannot resolve latest deployment: VERCEL_DEPLOYMENT_ID environment variable is not set'
      );
    }

    // Authenticate via provided token (CLI/config), VERCEL_TOKEN env var
    // (external tooling), or OIDC token (runtime) — in that order.
    // OIDC is last to avoid an unnecessary network call when a token is
    // already available (e.g. CLI or CI contexts).
    const token =
      config?.token ??
      process.env.VERCEL_TOKEN ??
      (await getVercelOidcToken().catch(() => null));
    if (!token) {
      throw new Error(
        'Cannot resolve latest deployment: no OIDC token or VERCEL_TOKEN available'
      );
    }

    const url = `https://api.vercel.com/v1/workflow/resolve-latest-deployment/${encodeURIComponent(currentDeploymentId)}`;

    // 429/5xx retries are handled by the shared RetryAgent from getDispatcher()
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
      // @ts-expect-error -- undici dispatcher is accepted by Node.js fetch but not in @types/node's RequestInit
      dispatcher: getDispatcher(),
    });

    if (!response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch {
        body = '<unable to read response body>';
      }
      throw new Error(
        `Failed to resolve latest deployment for ${currentDeploymentId}: HTTP ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`
      );
    }

    const data = await response.json();
    const result = ResolveLatestDeploymentResponseSchema.safeParse(data);
    if (!result.success) {
      throw new Error(
        `Invalid response from Vercel API: expected { id: string }. Zod error: ${result.error.message}`
      );
    }

    return result.data.id;
  };
}
