import { Args } from '@oclif/core';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG } from '../lib/config/log.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { startRun } from '../lib/inspect/run.js';
import { setupCliWorld } from '../lib/inspect/setup.js';

export default class Start extends BaseCommand {
  static description = 'Start a workflow';

  static aliases = ['s'];

  static examples = [
    '$ workflow start <workflow-name> <args>',
    '$ wf start <workflow-name> <args>',
  ];

  async catch(error: any) {
    if (LOGGING_CONFIG.VERBOSE_MODE) {
      console.error(error);
    }
    throw error;
  }

  static args = {
    workflowName: Args.string({
      description:
        'Name of a workflow to start. Providing a run ID will create a new run on that workflow.',
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

  static flags = cliFlags;

  public async run(): Promise<void> {
    const { flags, args, argv } = await this.parse(Start);

    const fixedArgIndex = argv.indexOf(args.workflowName);
    const restArgs = fixedArgIndex !== -1 ? argv.slice(fixedArgIndex + 1) : [];
    const stringArgs = restArgs.map((arg) => String(arg));

    const world = await setupCliWorld(flags, this.config.version);
    if (!world) {
      throw new Error(
        'Failed to connect to backend. Check your configuration.'
      );
    }

    await startRun(world, args.workflowName, flags, stringArgs);
  }
}
