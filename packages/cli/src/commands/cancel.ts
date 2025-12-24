import { Args } from '@oclif/core';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG } from '../lib/config/log.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { cancelRun } from '../lib/inspect/run.js';
import { setupCliWorld } from '../lib/inspect/setup.js';

export default class Cancel extends BaseCommand {
  static description = 'Cancel a workflow';

  static aliases = ['c'];

  static examples = ['$ workflow cancel <run-id>', '$ wf cancel <run-id>'];

  async catch(error: any) {
    if (LOGGING_CONFIG.VERBOSE_MODE) {
      console.error(error);
    }
    throw error;
  }

  static args = {
    runId: Args.string({
      description: 'ID of the run to cancel.',
      required: true,
    }),
  } as const;

  static flags = cliFlags;

  public async run(): Promise<void> {
    const { flags, args } = await this.parse(Cancel);

    const { world } = await setupCliWorld(flags, this.config.version);
    if (!world) {
      throw new Error(
        'Failed to connect to backend. Check your configuration.'
      );
    }

    await cancelRun(world, args.runId);
  }
}
