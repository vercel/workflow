import { Args, Flags } from '@oclif/core';
import { DELETE_RUNS_DATA_MAX_RUN_IDS } from '@workflow/world';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import {
  createPromptConfirm,
  performDeleteData,
  readRunIds,
} from '../lib/delete-data.js';
import { reportActionableApiError } from '../lib/inspect/errors.js';
import { targetFlags } from '../lib/inspect/flags.js';
import { setupCliWorld } from '../lib/inspect/setup.js';

export default class DeleteData extends BaseCommand {
  static description =
    'Delete the stored data of finished workflow runs (inputs, outputs, streams, and hook payloads). The runs stay listed. This cannot be undone.';

  static examples = [
    '$ workflow delete-data <run-id>',
    '$ workflow delete-data <run-id> <run-id> <run-id>',
    '$ workflow delete-data <run-id> -y --backend vercel',
    '$ cat run-ids.txt | workflow delete-data - -y --strict',
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
      description: `IDs of the runs whose data to delete, or - to read them from stdin (one per line or whitespace-separated). Sent in batches of ${DELETE_RUNS_DATA_MAX_RUN_IDS}. Runs that have not finished are skipped.`,
      required: true,
    }),
  } as const;

  static flags = {
    ...targetFlags,
    confirm: Flags.boolean({
      description: 'Skip the interactive confirmation prompt',
      required: false,
      char: 'y',
      default: false,
      helpLabel: '-y, --confirm',
    }),
    strict: Flags.boolean({
      description:
        'Exit with code 1 unless the data of every run is gone: also when a run is not found or has not finished, not only when one fails',
      required: false,
      default: false,
      helpLabel: '--strict',
    }),
  };

  public async run(): Promise<void> {
    const { flags, argv } = await this.parse(DeleteData);
    this.backend = flags.backend;

    const args = argv.map((arg) => String(arg));
    const fromStdin = args.includes('-');
    const runIds = fromStdin
      ? [
          ...args.filter((arg) => arg !== '-'),
          ...(await readRunIds(process.stdin)),
        ]
      : args;

    const world = await setupCliWorld(flags, this.config.version);
    if (!world) {
      throw new Error(
        'Failed to connect to backend. Check your configuration.'
      );
    }

    const { exitCode } = await performDeleteData({
      world,
      runIds,
      confirm: flags.confirm,
      json: flags.json,
      strict: flags.strict,
      logger,
      // Only a terminal can confirm; without one, `-y` is required. So it is
      // when the run IDs came from stdin, which is then used up.
      promptConfirm:
        process.stdin.isTTY && !fromStdin
          ? createPromptConfirm(process.stdin, process.stderr)
          : undefined,
    });

    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  }
}
