import type { World } from '@workflow/world';
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
  const workflowId = await getWorkflowName(world, workflowNameOrRunId);
  const deploymentId = await world.getDeploymentId();

  const run = await start({ workflowId }, jsonArgs, { deploymentId });

  if (opts.json) {
    process.stdout.write(JSON.stringify(run, null, 2));
  } else {
    logger.log(run);
  }
};

export const cancelRun = async (world: World, runId: string) => {
  await world.runs.cancel(runId);
  logger.log(chalk.green(`Cancel signal sent to run ${runId}`));
};
