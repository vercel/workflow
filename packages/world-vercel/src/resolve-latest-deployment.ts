/**
 * Resolve the latest deployment ID for the current deployment's environment.
 *
 * Calls the Vercel API to find the most recent deployment that shares the same
 * environment (e.g., same "production" target or same git branch for "preview"
 * deployments) as the provided current deployment.
 */

import { getVercelOidcToken } from '@vercel/oidc';
import * as z from 'zod';
import { missingDeploymentIdMessage } from './deployment-id.js';
import { getDispatcher } from './http-client.js';
import { instrumentedFetch, resolveVercelApiToken } from './http-core.js';
import type { APIConfig } from './utils.js';

const ResolveLatestDeploymentResponseSchema = z.compile(
  z.object({
    id: z.string(),
  })
);

/**
 * Resolve the credential this call should authenticate with.
 *
 * This endpoint is scoped to a *team* on the API side: it reads the source
 * deployment out of a team-partitioned store, so the identity we present
 * decides which team's deployments are visible. That makes the credential
 * choice a correctness concern here, not just an auth detail, and it is why
 * this path does not simply use `resolveVercelApiToken`.
 *
 * Inside the Vercel runtime the OIDC token is preferred over `VERCEL_TOKEN`,
 * reversing that helper's order. The OIDC token carries the deployment's own
 * `owner_id`/`project_id` claims, so the API resolves exactly the team that
 * owns the deployment we are asking about. A `VERCEL_TOKEN` in the function's
 * environment is a *user's* credential: it carries no team, so the API falls
 * back to that user's default team, and the lookup then misses on every team
 * but that one and returns 404. An ambient token set for unrelated tooling
 * must not displace the deployment's own identity.
 *
 * Outside the runtime (CLI, CI, the dashboard) the original order is kept.
 * There is no deployment identity to prefer, `VERCEL_TOKEN` is usually set
 * deliberately, and those callers pass an explicit `teamId` instead.
 */
async function resolveDeploymentIdentityToken(
  config?: APIConfig
): Promise<string | null> {
  if (config?.token) return config.token;

  if (process.env.VERCEL === '1') {
    const oidcToken = await getVercelOidcToken().catch(() => null);
    if (oidcToken) return oidcToken;
  }

  return resolveVercelApiToken(config);
}

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
        missingDeploymentIdMessage(
          "Resolving the latest deployment for deploymentId: 'latest'"
        )
      );
    }

    const token = await resolveDeploymentIdentityToken(config);
    if (!token) {
      throw new Error(
        'Cannot resolve latest deployment: no OIDC token or VERCEL_TOKEN available'
      );
    }

    // Scope the request to the owning team when the caller knows it, the same
    // way the sibling run-key request does. Without either this parameter or
    // an OIDC token's `owner_id` claim, the API scopes the lookup to the
    // token owner's *default* team and 404s when that is not the team that
    // owns the deployment.
    const teamId = config?.projectConfig?.teamId;
    const query = teamId ? `?${new URLSearchParams({ teamId })}` : '';
    const url = `https://api.vercel.com/v1/workflow/resolve-latest-deployment/${encodeURIComponent(currentDeploymentId)}${query}`;

    // 429/5xx retries are handled by the shared RetryAgent from getDispatcher().
    // instrumentedFetch adds the OTEL client span + DEBUG logging the v3/v4
    // paths have.
    const response = await instrumentedFetch({
      method: 'GET',
      url,
      headers: new Headers({ Authorization: `Bearer ${token}` }),
      dispatcher: getDispatcher(config),
      peerService: 'vercel-api',
      // Preserve the prior no-timeout behavior for this Vercel-API call; the
      // shared RetryAgent still handles transient/5xx retries.
      timeoutMs: null,
      buildError: async (res) => {
        let body: string;
        try {
          body = await res.text();
        } catch {
          body = '<unable to read response body>';
        }
        // A 404 here reads as "the deployment does not exist", but the far
        // more common cause is that the request resolved to a team that does
        // not own it, so the team-partitioned lookup missed. Name that, or
        // the next reader debugs deployment state instead of identity.
        const hint =
          res.status === 404
            ? '. The deployment exists but was not visible to the identity this' +
              ' request authenticated as, which means the request resolved to a' +
              " different team. Set the World's `projectConfig.teamId` to scope" +
              ' it explicitly.'
            : '';
        return new Error(
          `Failed to resolve latest deployment for ${currentDeploymentId}: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}${hint}`
        );
      },
    });

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
