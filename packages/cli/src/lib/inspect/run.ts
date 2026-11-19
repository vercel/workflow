import { start } from '@workflow/core/runtime';
import { healthCheck } from '@workflow/core/runtime/helpers';
import type { World } from '@workflow/world';
import { logger } from '../config/log.js';

interface CLICreateOpts {
  json?: boolean;
  verbose?: boolean;
  /**
   * Deployment to start the run on: a deployment ID, or `latest`. Defaults to
   * `latest` for a workflow name and to the source run's deployment for a
   * run ID.
   */
  deployment?: string;
}

/**
 * Resolve the deployment a new run targets, the same way `start()` resolves
 * `deploymentId: 'latest'`: through the World's `resolveLatestDeploymentId()`,
 * which on Vercel asks the Vercel API for the newest READY deployment of the
 * configured project and environment. It never depends on which runs exist,
 * so a workflow that has never run can still be started.
 *
 * Worlds without atomic deployments (local, Postgres) have nothing to choose
 * between, so `latest` is their current deployment, as it is in `start()`.
 */
export const resolveTargetDeploymentId = async (
  world: World,
  deployment: string
): Promise<string> => {
  if (deployment !== 'latest') {
    return deployment;
  }
  if (world.resolveLatestDeploymentId) {
    const deploymentId = await world.resolveLatestDeploymentId();
    logger.debug(`Resolved the latest deployment to ${deploymentId}`);
    return deploymentId;
  }
  return world.getDeploymentId();
};

export const startRun = async (
  world: World,
  workflowNameOrRunId: string,
  opts: CLICreateOpts,
  args: string[]
) => {
  const jsonArgs = args.map((arg) => {
    try {
      return JSON.parse(arg);
    } catch (error) {
      logger.warn(`Failed to parse argument "${arg}" as JSON: ${error}`);
      throw error;
    }
  });

  // A run ID re-runs that run's workflow, on its own deployment unless
  // `--deployment` says otherwise. Only deployment/spec metadata is read.
  let sourceRun:
    | { deploymentId: string; specVersion?: number; workflowName: string }
    | undefined;
  let workflowId = workflowNameOrRunId;
  if (workflowNameOrRunId.startsWith('wrun_')) {
    sourceRun = await world.runs.get(workflowNameOrRunId, {
      resolveData: 'none',
    });
    if (!sourceRun) {
      throw new Error(`Run "${workflowNameOrRunId}" not found`);
    }
    workflowId = sourceRun.workflowName;
  }

  const deploymentId = await resolveTargetDeploymentId(
    world,
    opts.deployment || sourceRun?.deploymentId || 'latest'
  );

  // Probe the deployment's specVersion via health check so we use the
  // correct queue transport (JSON for old deployments, CBOR for new).
  // Falls back to the source run's specVersion if the health check fails
  // (e.g. old deployment without health check support); a start by name has
  // no source run, and leaves the choice to `start()`'s own probe.
  // Capped at this CLI's World, on both paths: it writes `run_created` and
  // the arguments, so it must not claim a version it cannot produce.
  // Matches what `start()` does for its own cross-deployment probe.
  // The source run's version only describes the deployment it ran on.
  const sourceSpecVersion =
    sourceRun?.deploymentId === deploymentId
      ? sourceRun.specVersion
      : undefined;
  let specVersion =
    sourceSpecVersion === undefined
      ? undefined
      : Math.min(sourceSpecVersion, world.specVersion);
  try {
    const hc = await healthCheck(world, {
      deploymentId,
      timeout: 10_000,
    });
    if (
      hc.healthy &&
      typeof hc.specVersion === 'number' &&
      Number.isInteger(hc.specVersion) &&
      hc.specVersion >= 1
    ) {
      specVersion = Math.min(hc.specVersion, world.specVersion);
    }
  } catch {
    // Health check failed, so keep the fallback above
  }

  // Never forward the source run's `startHook`: a re-run is a new run by
  // intent, and its start Hook token would refuse it as a duplicate.
  const newRun = await start({ workflowId }, jsonArgs, {
    deploymentId,
    specVersion,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(newRun, null, 2));
  } else {
    logger.log(newRun);
  }
};
