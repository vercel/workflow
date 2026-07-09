import readline from 'node:readline';
import { Args, Flags } from '@oclif/core';
import { cancelRun } from '@workflow/core/runtime';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import type { WorkflowRun } from '@workflow/world';
import chalk from 'chalk';
import Table from 'easy-table';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import {
  getObservabilityUpgradeRequiredMessage,
  isObservabilityUpgradeRequiredError,
} from '../lib/inspect/errors.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { setupCliWorld } from '../lib/inspect/setup.js';
import { planWindowStartFromResponse } from '../lib/inspect/time-window.js';

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
      description: 'Filter runs by status for bulk cancel',
      required: false,
      options: ['running', 'completed', 'failed', 'cancelled', 'pending'],
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
      description: 'Max runs to cancel in bulk mode',
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

    // Fetch matching runs. Only metadata is needed to display and cancel, so
    // prefer the analytics read path when the backend provides one.
    const status = flags.status as WorkflowRun['status'] | undefined;
    const limit = flags.limit || 50;
    const analytics = world.analytics;
    const fetchMatches = async () => {
      if (!analytics) {
        return world.runs.list({
          status,
          workflowName: flags.workflowName,
          pagination: { limit },
          resolveData: 'none',
        });
      }
      // The analytics backend defaults its listing to a recent window
      // (trailing 24h on the Vercel backend), but bulk cancel must match
      // across the plan's whole observability window — a run can sleep or
      // wait on a hook for days without emitting recent events. Probe for
      // the plan window bounds first, then match across them.
      const probe = await analytics.runs.list({
        status,
        workflowName: flags.workflowName,
        pagination: { limit: 1 },
      });
      const windowStart = planWindowStartFromResponse(probe);
      return analytics.runs.list({
        status,
        workflowName: flags.workflowName,
        ...(windowStart
          ? { startTime: windowStart, endTime: new Date().toISOString() }
          : {}),
        pagination: { limit },
      });
    };
    const runList = await fetchMatches();
    const runs = {
      data: runList.data.map((run) => ({
        runId: run.runId,
        workflowName: run.workflowName,
        status: run.status,
        startedAt: run.startedAt,
      })),
      hasMore: runList.hasMore,
    };

    if (runs.data.length === 0) {
      logger.warn('No matching runs found.');
      return;
    }

    // Display what will be cancelled
    const table = new Table();
    for (const run of runs.data) {
      const shortName =
        parseWorkflowName(run.workflowName)?.shortName || run.workflowName;
      table.cell('runId', run.runId);
      table.cell('workflow', chalk.blueBright(shortName));
      table.cell('status', run.status);
      table.cell(
        'startedAt',
        run.startedAt ? new Date(run.startedAt).toISOString() : '-'
      );
      table.newRow();
    }
    logger.log(`\nFound ${chalk.bold(runs.data.length)} runs to cancel:\n`);
    logger.log(table.toString());

    if (runs.hasMore) {
      logger.warn(
        `More runs match these filters. Increase --limit (currently ${flags.limit || 50}) or re-run to cancel additional runs.`
      );
    }

    // Confirm unless --confirm/-y
    if (!flags.confirm) {
      const confirmed = await promptConfirm(
        `Cancel ${runs.data.length} run${runs.data.length === 1 ? '' : 's'}?`
      );
      if (!confirmed) {
        logger.log('Aborted.');
        return;
      }
    }

    // Cancel each run with progress
    let cancelled = 0;
    let failed = 0;
    for (const run of runs.data) {
      try {
        await cancelRun(world, run.runId);
        cancelled++;
        logger.log(
          chalk.green(`  ✓ ${run.runId}`) +
            chalk.gray(` (${cancelled}/${runs.data.length})`)
        );
      } catch (err: any) {
        failed++;
        logger.warn(`  ✗ ${run.runId}: ${err.message || String(err)}`);
      }
    }

    logger.log(
      `\nDone: ${chalk.green(`${cancelled} cancelled`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
    );
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
