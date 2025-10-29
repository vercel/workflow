import type { WorkflowRun, World } from '@workflow/world';
import chalk from 'chalk';
import { logger } from '../config/log.js';
import { start } from '../runtime.js';

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

  const newRun = await start({ workflowId }, jsonArgs, { deploymentId });

  if (opts.json) {
    process.stdout.write(JSON.stringify(newRun, null, 2));
  } else {
    logger.log(newRun);
  }
};

export const cancelRun = async (world: World, runId: string) => {
  await world.runs.cancel(runId);
  logger.log(chalk.green(`Cancel signal sent to run ${runId}`));
};
