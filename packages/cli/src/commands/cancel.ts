import readline from 'node:readline';
import { Args, Flags } from '@oclif/core';
import { cancelRun } from '@workflow/core/runtime';
import { WorkflowRunStatusSchema } from '@workflow/world';
import chalk from 'chalk';
import { BaseCommand } from '../base.js';
import {
  CANCELLABLE_STATUSES,
  performBulkCancel,
  validateBulkCancelLimit,
} from '../lib/bulk-cancel.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import {
  getObservabilityUpgradeRequiredMessage,
  isObservabilityUpgradeRequiredError,
} from '../lib/inspect/errors.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { setupCliWorld } from '../lib/inspect/setup.js';

export default class Cancel extends BaseCommand {
  static description =
    'Cancel a workflow run, or bulk-cancel runs by status/name';

  static aliases = ['c'];

  static examples = [
    '$ workflow cancel <run-id>',
    '$ workflow cancel --status=running',
    '$ workflow cancel --status=running --workflowName=myWorkflow',
    '$ workflow cancel --status=running -y',
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
    runId: Args.string({
      description: 'ID of the run to cancel (omit for bulk mode with filters)',
      required: false,
    }),
  } as const;

  static flags = {
    ...cliFlags,
    status: Flags.string({
      // Only cancellable statuses are offered: cancelling a terminal run
      // (completed / failed / cancelled) is a no-op, so pinning one would list
      // the same page on every rerun and never advance.
      description: 'Filter runs by status for bulk cancel (pending or running)',
      required: false,
      options: [...CANCELLABLE_STATUSES],
      helpGroup: 'Bulk Cancel',
      helpLabel: '--status',
    }),
    workflowName: Flags.string({
      description: 'Filter runs by workflow name for bulk cancel',
      required: false,
      char: 'n',
      helpGroup: 'Bulk Cancel',
      helpLabel: '-n, --workflowName',
    }),
    limit: Flags.integer({
      description: 'Max runs to cancel in bulk mode (1-500)',
      required: false,
      default: 50,
      helpGroup: 'Bulk Cancel',
      helpLabel: '--limit',
      helpValue: 'NUMBER',
    }),
    confirm: Flags.boolean({
      description: 'Skip interactive confirmation prompt',
      required: false,
      char: 'y',
      default: false,
      helpGroup: 'Bulk Cancel',
      helpLabel: '-y, --confirm',
    }),
  };

  public async run(): Promise<void> {
    const { flags, args } = await this.parse(Cancel);

    const world = await setupCliWorld(flags, this.config.version);
    if (!world) {
      throw new Error(
        'Failed to connect to backend. Check your configuration.'
      );
    }

    // Single-run cancel (existing behavior)
    if (args.runId) {
      await cancelRun(world, args.runId);
      logger.log(chalk.green(`Cancelled run ${args.runId}`));
      return;
    }

    // Bulk mode requires at least one filter
    if (!flags.status && !flags.workflowName) {
      logger.error(
        'Provide a run ID or use --status/--workflowName to bulk cancel.\n' +
          'Examples:\n' +
          '  workflow cancel <run-id>\n' +
          '  workflow cancel --status=running\n' +
          '  workflow cancel --status=running --workflowName=myWorkflow'
      );
      process.exit(1);
    }

    const limit = flags.limit ?? 50;
    const limitError = validateBulkCancelLimit(limit);
    if (limitError) {
      logger.error(limitError);
      process.exit(1);
    }

    const status = flags.status
      ? WorkflowRunStatusSchema.parse(flags.status)
      : undefined;

    const { exitCode } = await performBulkCancel({
      world,
      status,
      workflowName: flags.workflowName,
      limit,
      confirm: flags.confirm,
      logger,
      promptConfirm,
    });

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

async function promptConfirm(message: string): Promise<boolean> {
  // Non-TTY: abort since user cannot confirm interactively (use -y/--confirm to skip prompt)
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
