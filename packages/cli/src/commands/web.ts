import { Args } from '@oclif/core';
import { VERCEL_403_ERROR_MESSAGE } from '@workflow/errors';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { setupCliWorld } from '../lib/inspect/setup.js';
import { launchWebUI } from '../lib/inspect/web.js';

export default class Web extends BaseCommand {
  static description = 'Open the web UI to inspect workflow runs';

  static aliases = ['w'];

  static examples = [
    '$ workflow web',
    '$ workflow web run_01K5WAJZ8W367CV2RFKDSDNWB8',
    '$ workflow web --backend=vercel',
  ];

  async catch(error: any) {
    // Check if this is a 403 error from the Vercel backend
    if (error?.status === 403) {
      const message = VERCEL_403_ERROR_MESSAGE;
      logger.error(message);
    } else if (LOGGING_CONFIG.VERBOSE_MODE) {
      logger.error(error);
    } else {
      const errorMessage = error?.message || String(error) || 'Unknown error';
      logger.error(`Error: ${errorMessage}`);
    }
    process.exit(1);
  }

  static args = {
    id: Args.string({
      description: 'Optional run ID to open directly',
      required: false,
    }),
  } as const;

  static flags = {
    ...cliFlags,
  } as const;

  public async run(): Promise<void> {
    try {
      const { args, flags } = await this.parse(Web);
      const id = args.id;

      // Setup the CLI world to write env vars from flags
      // This ensures backend, authToken, team, project, etc. are properly set
      // Don't throw on config errors - let the web UI handle them
      await setupCliWorld(flags, this.config.version, true);

      // Launch web UI with 'run' as the default resource
      await launchWebUI('run', id, flags, this.config.version);
      process.exit(0);
    } catch (error) {
      // Let the catch handler deal with it, but ensure we exit
      throw error;
    }
  }
}
