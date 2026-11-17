import type { Pool } from 'pg';
import type { PostgresWorldConfig } from '../config.js';
import { getDeploymentBacklog, listActiveDeployments } from './backlog.js';

/**
 * The backlog of one version, as the HTTP endpoints report it. A version is
 * what the Helm chart labels a deployment's workers with (the image tag); by
 * default it is the run's `deploymentId` itself.
 */
export interface VersionBacklog {
  readonly version: string;
  readonly activeRuns: number;
  readonly dueDeliveries: number;
  readonly wanted: number;
}

export interface BacklogEndpointsOptions {
  pool: Pool;
  config: Pick<PostgresWorldConfig, 'jobPrefix'>;
  /** Where the endpoints are served. Default `/internal/workflow`. */
  basePath?: string;
  /**
   * The `deploymentId` of a version, and back, when they differ (a
   * deployment ID such as `<service>@<tag>` with workers labeled `<tag>`).
   * `versionOf` returns `undefined` for a deployment that is not one of these
   * versions. Default: the same string.
   */
  deploymentIdOf?: (version: string) => string;
  versionOf?: (deploymentId: string) => string | undefined;
}

export interface BacklogResponse {
  status: number;
  body: unknown;
}

export interface BacklogEndpoints {
  /**
   * The response for a request, or `undefined` when the path is not one of
   * these endpoints:
   *
   * - `GET {basePath}/backlog/{version}`: a {@link VersionBacklog}. A KEDA
   *   `metrics-api` trigger reads `wanted`.
   * - `GET {basePath}/versions`: `{ versions: { [version]: activeRuns } }`,
   *   every version with unfinished runs.
   */
  respond(
    method: string,
    pathname: string
  ): Promise<BacklogResponse | undefined>;
  /** {@link respond} for a Fetch API request; `undefined` when not matched. */
  fetch(request: Request): Promise<Response | undefined>;
}

const VERSION = /^[A-Za-z0-9._@-]{1,128}$/;

/**
 * HTTP endpoints reporting each version's backlog, which the Helm chart's
 * KEDA triggers and prune job read. Serve them on the main Deployment's port
 * from inside the cluster only: they disclose run counts.
 */
export function createBacklogEndpoints({
  pool,
  config,
  basePath = '/internal/workflow',
  deploymentIdOf = (version) => version,
  versionOf = (deploymentId) => deploymentId,
}: BacklogEndpointsOptions): BacklogEndpoints {
  const base = basePath.replace(/\/+$/, '');
  const backlogPrefix = `${base}/backlog/`;

  async function respond(
    method: string,
    pathname: string
  ): Promise<BacklogResponse | undefined> {
    if (pathname === `${base}/versions`) {
      if (method !== 'GET')
        return { status: 405, body: { error: 'method_not_allowed' } };
      const versions: Record<string, number> = {};
      for (const [deploymentId, count] of await listActiveDeployments(
        pool,
        config
      )) {
        const version = versionOf(deploymentId);
        if (version !== undefined) versions[version] = count;
      }
      return { status: 200, body: { versions } };
    }
    if (pathname.startsWith(backlogPrefix)) {
      if (method !== 'GET')
        return { status: 405, body: { error: 'method_not_allowed' } };
      const version = decodeURIComponent(pathname.slice(backlogPrefix.length));
      if (!VERSION.test(version)) {
        return { status: 400, body: { error: 'invalid_version' } };
      }
      let backlog: Awaited<ReturnType<typeof getDeploymentBacklog>>;
      try {
        backlog = await getDeploymentBacklog(
          pool,
          config,
          deploymentIdOf(version)
        );
      } catch (error) {
        // An ID world-postgres rejects (reserved, or too long for its job
        // prefix) names no deployment.
        if (error instanceof Error && /deploymentId/.test(error.message)) {
          return { status: 400, body: { error: 'invalid_version' } };
        }
        throw error;
      }
      const body: VersionBacklog = {
        version,
        activeRuns: backlog.activeRuns,
        dueDeliveries: backlog.dueDeliveries,
        wanted: backlog.wanted,
      };
      return { status: 200, body };
    }
    return undefined;
  }

  return {
    respond,
    async fetch(request) {
      const result = await respond(
        request.method,
        new URL(request.url).pathname
      );
      return result && Response.json(result.body, { status: result.status });
    },
  };
}
