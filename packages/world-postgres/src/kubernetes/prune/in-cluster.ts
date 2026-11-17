import { inClusterApi } from './kube.js';
import { httpBacklogSource, type PruneResult, pruneWorkers } from './prune.js';

/**
 * Prunes once from inside the cluster, as the pod's service account, reading
 * backlogs from the service's backlog endpoints over HTTP, so it needs no
 * database access. What the Helm chart's prune CronJob runs:
 *
 * - `WORKFLOW_PRUNE_SERVICE`: the `workflow.vercel.com/service` label value.
 * - `WORKFLOW_PRUNE_MAIN_DEPLOYMENT`: the main Deployment, whose live
 *   versions are never pruned. Default: the service.
 * - `WORKFLOW_PRUNE_BACKLOG_URL`: the backlog endpoints' base URL. Default
 *   `http://<main deployment>.<namespace>.svc.cluster.local/internal/workflow`.
 * - `WORKFLOW_PRUNE_MIN_AGE_MINUTES`: workers younger than this are kept.
 *   Default 60.
 * - `WORKFLOW_PRUNE_DRY_RUN=1`: decide, but change nothing.
 */
export async function pruneWorkersInCluster(
  env: Record<string, string | undefined> = process.env
): Promise<PruneResult> {
  const api = inClusterApi();
  const service = env.WORKFLOW_PRUNE_SERVICE;
  if (!service) throw new Error('WORKFLOW_PRUNE_SERVICE is required');
  const mainDeployment = env.WORKFLOW_PRUNE_MAIN_DEPLOYMENT || service;
  const baseUrl = (
    env.WORKFLOW_PRUNE_BACKLOG_URL ||
    `http://${mainDeployment}.${api.namespace}.svc.cluster.local/internal/workflow`
  ).replace(/\/+$/, '');
  return pruneWorkers({
    api,
    namespace: api.namespace,
    service,
    mainDeployment,
    backlog: httpBacklogSource(async (path) => {
      const res = await fetch(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`GET ${baseUrl}${path}: ${res.status}`);
      return res.json();
    }),
    minAgeMs:
      parseMinAgeMinutes(env.WORKFLOW_PRUNE_MIN_AGE_MINUTES || '60') * 60_000,
    dryRun: env.WORKFLOW_PRUNE_DRY_RUN === '1',
  });
}

/**
 * A minimum age in minutes. Anything that is not a finite, non-negative
 * number is refused: `NaN` would silently disable the minimum age, letting
 * pruning delete a version's workers before its first run is recorded.
 */
export function parseMinAgeMinutes(value: string): number {
  const minutes = Number(value);
  if (value.trim() === '' || !Number.isFinite(minutes) || minutes < 0) {
    throw new Error(
      `The minimum worker age must be a non-negative number of minutes, got ${JSON.stringify(value)}`
    );
  }
  return minutes;
}

/** One line per action, for logs and CI summaries. */
export function formatPruneResult(result: PruneResult): string[] {
  return [
    ...result.actions.map((action) => {
      if (action.kind === 'restore') {
        return `restore ${action.version} (${action.activeRuns} unfinished runs, no workers)`;
      }
      if (action.kind === 'delete') return `delete  ${action.worker.version}`;
      if (action.kind === 'delete-scaler') {
        return `delete  ${action.scaler.version} (ScaledObject left without its worker)`;
      }
      if (action.kind === 'repair') {
        return `repair  ${action.worker.version} (worker without a ScaledObject)`;
      }
      return `keep    ${action.worker.version} (${action.reason})`;
    }),
    ...result.errors.map((error) => `error   ${error}`),
  ];
}
