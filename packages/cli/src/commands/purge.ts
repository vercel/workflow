import { Args, Flags } from '@oclif/core';
import { BULK_PURGE_MAX_RUN_IDS } from '@workflow/world';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import { reportActionableApiError } from '../lib/inspect/errors.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { setupCliWorld } from '../lib/inspect/setup.js';
import { createPromptConfirm, performPurge } from '../lib/purge.js';

export default class Purge extends BaseCommand {
  static description =
    'Delete the stored data of finished workflow runs (inputs, outputs, streams, and hook payloads). The runs stay listed. This cannot be undone.';

  static examples = [
    '$ workflow purge <run-id>',
    '$ workflow purge <run-id> <run-id> <run-id>',
    '$ workflow purge <run-id> -y --backend vercel',
  ];

  // Takes any number of run IDs.
  static strict = false;

  /** See `Cancel.backend`: lets `catch()` classify a Vercel 403. */
  private backend?: string;

  async catch(error: any) {
    if (reportActionableApiError(error, this.backend)) {
      process.exit(1);
    }
    if (LOGGING_CONFIG.VERBOSE_MODE) {
      console.error(error);
    }
    throw error;
  }

  static args = {
    runId: Args.string({
      description: `IDs of the runs to purge, up to ${BULK_PURGE_MAX_RUN_IDS}. Runs that have not finished are skipped.`,
      required: true,
    }),
  } as const;

  static flags = {
    ...cliFlags,
    confirm: Flags.boolean({
      description: 'Skip the interactive confirmation prompt',
      required: false,
      char: 'y',
      default: false,
      helpLabel: '-y, --confirm',
    }),
  };

  public async run(): Promise<void> {
    const { flags, argv } = await this.parse(Purge);
    this.backend = flags.backend;

    const world = await setupCliWorld(flags, this.config.version);
    if (!world) {
      throw new Error(
        'Failed to connect to backend. Check your configuration.'
      );
    }

    const { exitCode } = await performPurge({
      world,
      runIds: argv.map((arg) => String(arg)),
      confirm: flags.confirm,
      json: flags.json,
      logger,
      // Only a terminal can confirm; without one, `-y` is required.
      promptConfirm: process.stdin.isTTY
        ? createPromptConfirm(process.stdin, process.stderr)
        : undefined,
    });

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}
