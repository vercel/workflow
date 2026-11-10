import { Args, Flags } from '@oclif/core';
import { isVercelWorldTarget } from '@workflow/utils';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import { getWorkflowConfig } from '../lib/config/workflow-config.js';
import {
  getObservabilityUpgradeRequiredMessage,
  isObservabilityUpgradeRequiredError,
} from '../lib/inspect/errors.js';
import { targetFlags } from '../lib/inspect/flags.js';
import { getCurrentGitBranch } from '../lib/inspect/git-branch.js';
import { startRun } from '../lib/inspect/run.js';
import { setupCliWorld } from '../lib/inspect/setup.js';

export default class Start extends BaseCommand {
  static description = 'Start a workflow';

  static aliases = ['s'];

  static examples = [
    '$ workflow start <workflow-name> <args>',
    '$ wf start <workflow-name> <args>',
    '$ wf start <workflow-name> <args> --backend vercel --deployment dpl_xxx',
  ];

  async catch(error: any) {
    if (isObservabilityUpgradeRequiredError(error)) {
      logger.error(getObservabilityUpgradeRequiredMessage());
      process.exit(1);
    } else if (LOGGING_CONFIG.VERBOSE_MODE) {
      console.error(error);
    }
    throw error;
  }

  static args = {
    workflowName: Args.string({
      description:
        'Name of a workflow to start. Providing a run ID will create a new run on that workflow, on the same deployment unless --deployment is given.',
      required: true,
    }),
    args: Args.string({
      description: [
        'Arguments to pass to the workflow. All arguments will be parsed as JSON.',
        'E.g. `wf start example 123 "\'123\'" "{"a": 1}"` will start the "example" workflow with 123 (a number), "123" (a string), and {"a": 1} (an object)',
      ].join('\n'),
      required: false,
    }),
  } as const;

  static flags = {
    ...targetFlags,
    deployment: Flags.string({
      description: [
        'Deployment ID to start the run on, or `latest` for the newest ready deployment in --env.',
        "Defaults to `latest`, or to the source run's deployment when given a run ID.",
      ].join('\n'),
      required: false,
      helpGroup: 'Target',
      helpLabel: '--deployment',
      helpValue: ['latest', 'DEPLOYMENT_ID'],
    }),
    branch: Flags.string({
      description:
        'With --env preview, the git branch whose newest ready deployment `latest` resolves to. Defaults to the current git branch.',
      required: false,
      helpGroup: 'Target',
      helpLabel: '--branch',
      helpValue: 'BRANCH',
    }),
  };

  public async run(): Promise<void> {
    const { flags, args, argv } = await this.parse(Start);

    const fixedArgIndex = argv.indexOf(args.workflowName);
    const restArgs = fixedArgIndex !== -1 ? argv.slice(fixedArgIndex + 1) : [];
    const stringArgs = restArgs.map((arg) => String(arg));

    // Preview deployments are per branch, so resolving `latest` there needs
    // one. A run ID re-runs on its own deployment unless --deployment is set.
    const resolvesLatest =
      (flags.deployment ??
        (args.workflowName.startsWith('wrun_') ? undefined : 'latest')) ===
      'latest';
    const inferBranch =
      resolvesLatest &&
      !flags.branch &&
      flags.env === 'preview' &&
      isVercelWorldTarget(flags.backend);
    const branch = inferBranch
      ? await getCurrentGitBranch(getWorkflowConfig().workingDir)
      : flags.branch;

    const world = await setupCliWorld(
      { ...flags, branch },
      this.config.version
    );
    if (inferBranch && branch) {
      logger.info(
        `Resolving the latest preview deployment on the current git branch ${branch} (override with --branch)`
      );
    }
    if (!world) {
      throw new Error(
        'Failed to connect to backend. Check your configuration.'
      );
    }

    await startRun(world, args.workflowName, flags, stringArgs);
  }
}
