import { Args, Flags } from '@oclif/core';
import { VERCEL_403_ERROR_MESSAGE } from '@workflow/errors';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import type { InspectCLIOptions } from '../lib/config/types.js';
import { cliFlags } from '../lib/inspect/flags.js';
import {
  listEvents,
  listHooks,
  listRuns,
  listSleeps,
  listSteps,
  listStreamsByRunId,
  showHook,
  showRun,
  showStep,
  showStream,
} from '../lib/inspect/output.js';
import { setupCliWorld } from '../lib/inspect/setup.js';
import { launchWebUI } from '../lib/inspect/web.js';

export default class Inspect extends BaseCommand {
  static description = 'Inspect runs, steps, streams, or events';

  static aliases = ['i'];

  static examples = [
    '$ workflow inspect runs',
    '$ workflow inspect runs',
    '$ workflow inspect events --step=step_01K5WAJZ8W367CV2RFKDSDNWB8',
    '$ workflow inspect hooks',
    '$ workflow inspect hook hook_01K5WAJZ8W367CV2RFKDSDNWB8',
    '$ workflow inspect sleeps --runId=run_01K5WAJZ8W367CV2RFKDSDNWB8',
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
    resource: Args.string({
      description:
        'what to inspect: run(s) | step(s) | stream(s) | event(s) | hook(s) | sleep(s)',
      required: true,
      options: [
        'r',
        'run',
        'runs',
        's',
        'step',
        'steps',
        'e',
        'event',
        'events',
        'st',
        'stream',
        'streams',
        'h',
        'hook',
        'hooks',
        'w',
        'web',
        'sleep',
        'sleeps',
      ],
    }),
    id: Args.string({
      description: 'ID of the resource if inspecting a specific item',
      required: false,
    }),
  } as const;

  static flags = {
    runId: Flags.string({
      description:
        'run ID to filter by (optional for steps, events, and hooks, required for sleeps)',
      required: false,
      char: 'r',
      aliases: ['run'],
      helpGroup: 'Filtering',
      helpLabel: '-r, --runId',
      helpValue: 'RUN_ID',
    }),
    stepId: Flags.string({
      description: 'step ID to filter by (only for events)',
      required: false,
      char: 's',
      aliases: ['step'],
      helpGroup: 'Filtering',
      helpLabel: '-s, --stepId',
      helpValue: 'STEP_ID',
    }),
    hookId: Flags.string({
      description: 'hook ID to filter by (only for events)',
      required: false,
      aliases: ['hook'],
      helpGroup: 'Filtering',
      helpLabel: '--hookId',
      helpValue: 'HOOK_ID',
    }),
    workflowName: Flags.string({
      description: 'workflow name to filter by (only for runs)',
      required: false,
      char: 'n',
      aliases: ['workflow'],
      helpGroup: 'Filtering',
      helpLabel: '-n, --workflowName',
    }),
    withData: Flags.boolean({
      description: 'include full input/output data in list views',
      required: false,
      char: 'd',
      default: false,
      helpGroup: 'Display',
      helpLabel: '-d, --withData',
    }),
    ...cliFlags,
  } as const;

  public async run(): Promise<void> {
    try {
      const { args, flags } = await this.parse(Inspect);

      const resource = normalizeResource(args.resource);
      if (!resource) {
        this.logError(
          `Unknown resource "${args.resource}": must be one of: run(s), step(s), stream(s), event(s), hook(s), sleep(s)`
        );
        process.exit(1);
      }

      const id = args.id;

      const world = await setupCliWorld(flags, this.config.version);

      // Handle web UI mode
      if (flags.web || resource === 'web') {
        const actualResource = resource === 'web' ? 'run' : resource;
        await launchWebUI(actualResource, id, flags, this.config.version);
        process.exit(0);
      }

      // Convert flags to InspectCLIOptions with proper typing
      const options = toInspectOptions(flags);

      if (resource === 'run') {
        if (id) {
          await showRun(world, id, options);
        } else {
          await listRuns(world, options);
        }
        process.exit(0);
      }

      if (resource === 'step') {
        if (id) {
          await showStep(world, id, options);
        } else {
          await listSteps(world, options);
        }
        process.exit(0);
      }

      if (resource === 'stream') {
        if (id) {
          await showStream(world, id, options);
        } else {
          await listStreamsByRunId(world, options);
        }
        process.exit(0);
      }

      if (resource === 'event') {
        if (id) {
          this.logError(
            'Event-ID is not supported for events. Filter by run-id or step-id instead. Usage: `workflow inspect events --runId=<id>`'
          );
          process.exit(1);
        }
        await listEvents(world, options);
        process.exit(0);
      }

      if (resource === 'hook') {
        if (id) {
          await showHook(world, id, options);
        } else {
          await listHooks(world, options);
        }
        process.exit(0);
      }

      if (resource === 'sleep') {
        if (id) {
          this.logError(
            'Sleep-ID is not supported for sleeps. Filter by run-id instead. Usage: `workflow inspect sleeps --runId=<id>`'
          );
          process.exit(1);
        }
        if (!flags.runId) {
          this.logError(
            'run-id is required for listing sleeps. Usage: `workflow inspect sleeps --runId=<id>`'
          );
          process.exit(1);
        }
        await listSleeps(world, options);
        process.exit(0);
      }

      this.logError(
        `Unknown resource: ${resource}. Usage: ${Inspect.examples.join('\n')}`
      );
      process.exit(1);
    } catch (error) {
      // Let the catch handler deal with it, but ensure we exit
      throw error;
    }
  }
}

function toInspectOptions(flags: any): InspectCLIOptions {
  return {
    json: flags.json,
    runId: flags.runId,
    stepId: flags.stepId,
    cursor: flags.cursor,
    sort: flags.sort as 'asc' | 'desc' | undefined,
    limit: flags.limit,
    workflowName: flags.workflowName,
    withData: flags.withData,
    backend: flags.backend,
    interactive: flags.interactive,
  };
}

function normalizeResource(
  value?: string
): 'run' | 'step' | 'stream' | 'event' | 'hook' | 'web' | 'sleep' | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v.startsWith('r')) return 'run';
  if (v.startsWith('e')) return 'event';
  if (v.startsWith('str')) return 'stream';
  if (v.startsWith('sl')) return 'sleep';
  if (v.startsWith('s')) return 'step';
  if (v.startsWith('h')) return 'hook';
  if (v.startsWith('w')) return 'web';
  return undefined;
}
