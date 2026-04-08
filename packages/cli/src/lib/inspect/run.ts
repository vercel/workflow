import { start } from '@workflow/core/runtime';
import { healthCheck } from '@workflow/core/runtime/helpers';
import type { WorkflowRun, World } from '@workflow/world';
import { logger } from '../config/log.js';

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

  let run: WorkflowRun | undefined;
  // If the workflowNameOrRunId is a run ID, get the run
  if (workflowNameOrRunId.startsWith('wrun_')) {
    run = await world.runs.get(workflowNameOrRunId);
  } else {
    // Get the first run for that name, hopefully the newest deployment,
    // but can't guarantee that.
    const runList = await world.runs.list({
      workflowName: workflowNameOrRunId,
      pagination: {
        sortOrder: 'desc',
        limit: 1,
      },
    });
    run = runList.data[0];
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
