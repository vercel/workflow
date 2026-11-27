/**
 * Resolve the latest deployment ID for the current deployment's environment.
 *
 * Calls the Vercel API to find the most recent deployment that shares the same
 * environment (e.g., same "production" target or same git branch for "preview"
 * deployments) as the provided current deployment.
 *
 * Outside a deployment (the CLI, CI, scripts) there is no current deployment,
 * so the source deployment is taken from the configured project and
 * environment instead, and the same API resolves the latest deployment from
 * it. Every caller therefore gets the same answer to "latest".
 */

import { getVercelOidcToken } from '@vercel/oidc';
import * as z from 'zod';
import { missingDeploymentIdMessage } from './deployment-id.js';
import { getDispatcher } from './http-client.js';
import { instrumentedFetch, resolveVercelApiToken } from './http-core.js';
import { type APIConfig, getVercelApiUrl } from './utils.js';

const ResolveLatestDeploymentResponseSchema = z.object({
  id: z.string(),
});

const ListDeploymentsResponseSchema = z.object({
  deployments: z.array(z.object({ uid: z.string() })),
});

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
  // A custom `vercelApiUrl` authenticates requests itself; never send it an
  // ambient credential.
  if (config?.vercelApiUrl) return null;

  if (process.env.VERCEL === '1') {
    const oidcToken = await getVercelOidcToken().catch(() => null);
    if (oidcToken) return oidcToken;
  }

  return resolveVercelApiToken(config);
}

const authorizationHeaders = (token: string | null): Headers =>
  new Headers(token ? { Authorization: `Bearer ${token}` } : {});

/**
 * Find a deployment of the configured project in the configured environment,
 * to stand in for the current deployment when this process is not one.
 *
 * The resolve-latest-deployment API only reads the source's environment (its
 * target, or for a preview its git branch) and picks the newest READY
 * deployment there itself. The source is limited to READY deployments too:
 * the newest deployment may still be building or have failed, and on a
 * preview branch with no READY deployment yet it could not be resolved.
 *
 * Preview deployments are per branch, so a preview source is taken from the
 * configured `gitBranch` and "latest" is the newest READY deployment on it.
 * Without one there is no predictable branch to pick, so this throws rather
 * than choosing whichever branch deployed last.
 */
async function findSourceDeployment(
  projectId: string,
  config: APIConfig | undefined,
  token: string | null
): Promise<string> {
  const environment = config?.projectConfig?.environment || 'production';
  const teamId = config?.projectConfig?.teamId;
  const branch =
    environment === 'preview' ? config?.projectConfig?.gitBranch : undefined;
  if (environment === 'preview' && !branch) {
    throw new Error(
      'Cannot resolve the latest preview deployment outside a deployment without a git branch. ' +
        'Set `projectConfig.gitBranch` (the CLI takes it from `--branch` or the current git branch), ' +
        'or pass a concrete deployment ID.'
    );
  }

  const params = new URLSearchParams({
    projectId,
    target: environment,
    limit: '1',
    state: 'READY',
  });
  if (branch) params.set('branch', branch);
  if (teamId) params.set('teamId', teamId);
  const url = `${getVercelApiUrl(config)}/v6/deployments?${params}`;

  const response = await instrumentedFetch({
    method: 'GET',
    url,
    headers: authorizationHeaders(token),
    dispatcher: getDispatcher(config),
    peerService: 'vercel-api',
    timeoutMs: null,
    buildError: async (res) => {
      const body = await res.text().catch(() => '');
      return new Error(
        `Failed to list ${environment} deployments of project ${projectId}: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`
      );
    },
  });

  const result = ListDeploymentsResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error(
      `Invalid response from Vercel API: expected { deployments: { uid: string }[] }. Zod error: ${result.error.message}`
    );
  }
  const source = result.data.deployments[0];
  if (!source) {
    const where = branch ? ` on branch ${branch}` : '';
    throw new Error(
      `Cannot resolve the latest deployment: project ${projectId} has no READY ${environment} deployments${where}.`
    );
  }
  return source.uid;
}

/**
 * Create the `resolveLatestDeploymentId` implementation for a Vercel World.
 *
 * Resolves the most recent deployment ID for the same environment as the
 * current deployment by calling the Vercel API. Outside a deployment, the
 * environment is the one in `config.projectConfig` (see
 * {@link findSourceDeployment}).
 *
 * @param config - API configuration (token, project config, etc.)
 * @returns The `resolveLatestDeploymentId` function
 */
export function createResolveLatestDeploymentId(
  config?: APIConfig
): () => Promise<string> {
  return async function resolveLatestDeploymentId(): Promise<string> {
    // Inside a deployment, "latest" is relative to that deployment. Outside
    // one, it is relative to the configured project's environment.
    const envDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    const projectId = config?.projectConfig?.projectId;
    if (!envDeploymentId && !projectId) {
      throw new Error(
        missingDeploymentIdMessage(
          "Resolving the latest deployment for deploymentId: 'latest'"
        )
      );
    }

    const token = await resolveDeploymentIdentityToken(config);
    if (!token && !config?.vercelApiUrl) {
      throw new Error(
        'Cannot resolve latest deployment: no OIDC token or VERCEL_TOKEN available'
      );
    }

    const currentDeploymentId =
      envDeploymentId ||
      (await findSourceDeployment(projectId as string, config, token));

    // Scope the request to the owning team when the caller knows it, the same
    // way the sibling run-key request does. Without either this parameter or
    // an OIDC token's `owner_id` claim, the API scopes the lookup to the
    // token owner's *default* team and 404s when that is not the team that
    // owns the deployment.
    const teamId = config?.projectConfig?.teamId;
    const query = teamId ? `?${new URLSearchParams({ teamId })}` : '';
    const url = `${getVercelApiUrl(config)}/v1/workflow/resolve-latest-deployment/${encodeURIComponent(currentDeploymentId)}${query}`;

    // 429/5xx retries are handled by the shared RetryAgent from getDispatcher().
    // instrumentedFetch adds the OTEL client span + DEBUG logging the v3/v4
    // paths have.
    const response = await instrumentedFetch({
      method: 'GET',
      url,
      headers: authorizationHeaders(token),
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
