import { start } from '@workflow/core/runtime';
import { healthCheck } from '@workflow/core/runtime/helpers';
import type { World } from '@workflow/world';
import { logger } from '../config/log.js';
import { planWindowStartFromResponse } from './time-window.js';

interface CLICreateOpts {
  json?: boolean;
  verbose?: boolean;
}

const getWorkflowName = async (world: World, runNameOrId: string) => {
  if (runNameOrId.startsWith('wrun_')) {
    const run = await world.runs.get(runNameOrId);
    if (!run) {
      throw new Error(`Run ${runNameOrId} not found`);
    }
    return run.workflowName;
  }
  return runNameOrId;
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

  // Only deployment/spec metadata is needed to start a new run, so this
  // accepts either a full run record or an analytics (metadata-only) row.
  let run:
    | { deploymentId: string; specVersion?: number; workflowName: string }
    | undefined;
  // If the workflowNameOrRunId is a run ID, get the run
  if (workflowNameOrRunId.startsWith('wrun_')) {
    run = await world.runs.get(workflowNameOrRunId);
  } else {
    // Get the first run for that name, hopefully the newest deployment,
    // but can't guarantee that. This is metadata only, so prefer the
    // analytics read path when the backend provides one.
    const runList = world.analytics
      ? await world.analytics.runs.list({
          workflowName: workflowNameOrRunId,
          pagination: { sortOrder: 'desc', limit: 1 },
        })
      : await world.runs.list({
          workflowName: workflowNameOrRunId,
          pagination: { sortOrder: 'desc', limit: 1 },
          resolveData: 'none',
        });
    run = runList.data[0];

    // The analytics backend defaults its listing to a recent window
    // (trailing 24h on the Vercel backend). When the name wasn't found
    // there, retry across the plan's whole observability window using the
    // window bounds from the response's page metadata.
    if (!run && world.analytics) {
      const windowStart = planWindowStartFromResponse(runList);
      if (windowStart) {
        const widened = await world.analytics.runs.list({
          workflowName: workflowNameOrRunId,
          startTime: windowStart,
          endTime: new Date().toISOString(),
          pagination: { sortOrder: 'desc', limit: 1 },
        });
        run = widened.data[0];
      }
    }
  }

  if (!run) {
    throw new Error(`Run "${workflowNameOrRunId}" not found`);
  }

  const deploymentId = run.deploymentId;
  const workflowId = await getWorkflowName(world, workflowNameOrRunId);

  // Probe the deployment's specVersion via health check so we use the
  // correct queue transport (JSON for old deployments, CBOR for new).
  // Falls back to the run's specVersion if the health check fails
  // (e.g. old deployment without health check support).
  let specVersion = run.specVersion;
  try {
    const hc = await healthCheck(world, 'workflow', {
      deploymentId,
      timeout: 10_000,
    });
    if (hc.healthy && hc.specVersion != null) {
      specVersion = hc.specVersion;
    }
  } catch {
    // Health check failed — use run's specVersion as fallback
  }

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
