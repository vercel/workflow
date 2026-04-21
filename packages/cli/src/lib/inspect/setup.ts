import { createWorld, setWorld } from '@workflow/core/runtime';
import { isVercelWorldTarget } from '@workflow/utils';
import type { World } from '@workflow/world';
import { createVercelWorld } from '@workflow/world-vercel';
import chalk from 'chalk';
import terminalLink from 'terminal-link';
import { logger, setJsonMode, setVerboseMode } from '../config/log.js';
import { checkForUpdateCached } from '../update-check.js';
import {
  inferLocalWorldEnvVars,
  inferVercelEnvVars,
  type VercelEnvVars,
  writeEnvVars,
} from './env.js';

/**
 * Setup CLI world configuration.
 * If throwOnConfigError is false, will return null world with the error message
 * instead of throwing, allowing the web UI to open for configuration.
 */
export const setupCliWorld = async (
  flags: {
    json: boolean;
    verbose: boolean;
    backend: string;
    env: string;
    authToken: string;
    project: string;
    team: string;
  },
  version: string,
  ignoreLocalWorldConfigError = false
) => {
  setJsonMode(Boolean(flags.json));
  setVerboseMode(Boolean(flags.verbose));

  // Check for updates
  const updateCheck = await checkForUpdateCached(version);

  const withAnsiLinks = flags.json ? false : true;
  const docsUrl = withAnsiLinks
    ? terminalLink('https://workflow-sdk.dev/', 'https://workflow-sdk.dev/')
    : 'https://workflow-sdk.dev/';

  // Prepare showBox lines
  const boxLines = [
    `Workflow CLI v${version}`,
    `Docs at ${docsUrl}`,
    chalk.yellow('This is a beta release'),
  ];

  // Add update message if available
  if (updateCheck.needsUpdate && updateCheck.latestVersion) {
    boxLines.push(
      '',
      chalk.cyan(
        `Update available: ${updateCheck.currentVersion} → ${updateCheck.latestVersion}`
      ),
      // Note that we're suggesting install "latest" instead of the release tag that the user is
      // on, because we currently tag beta releases as "latest". After GA, we need to adjust
      // this to install the release tag that the user is on.
      chalk.gray(
        `Run: \`[npm|bun|pnpm] i workflow@${updateCheck.latestVersion}\``
      ),
      chalk.gray(
        terminalLink(
          'View changelog',
          'https://github.com/vercel/workflow/releases'
        )
      )
    );
  }

  logger.showBox('green', ...boxLines);

  logger.debug('Inferring env vars, backend:', flags.backend);
  writeEnvVars({
    DEBUG: flags.verbose ? '1' : '',
    WORKFLOW_TARGET_WORLD: flags.backend,
  });

  let vercelEnvVars: VercelEnvVars | undefined;
  if (isVercelWorldTarget(flags.backend)) {
    // Seed the initial flags into process.env so inferVercelEnvVars() can
    // read them via getEnvVars() as starting values before inference.
    writeEnvVars({
      WORKFLOW_VERCEL_ENV: flags.env,
      WORKFLOW_VERCEL_AUTH_TOKEN: flags.authToken,
      WORKFLOW_VERCEL_PROJECT: flags.project,
      WORKFLOW_VERCEL_TEAM: flags.team,
    });
    vercelEnvVars = await inferVercelEnvVars();
  } else if (
    flags.backend === 'local' ||
    flags.backend === '@workflow/world-local'
  ) {
    try {
      await inferLocalWorldEnvVars();
    } catch (error) {
      if (ignoreLocalWorldConfigError) {
        const configError =
          error instanceof Error
            ? error.message
            : 'Unknown configuration error';
        logger.warn(
          'Failed to find valid local world configuration:',
          configError
        );
        return null;
      }
      throw error;
    }
  }

  logger.debug('Initializing world');

  let world: World;
  if (vercelEnvVars) {
    // Build the Vercel world directly from the inferred config, rather than
    // relying on createWorld() reading process.env.
    world = createVercelWorld({
      token: vercelEnvVars.token,
      projectConfig: {
        environment: vercelEnvVars.environment,
        projectId: vercelEnvVars.projectId,
        projectName: vercelEnvVars.projectName,
        teamId: vercelEnvVars.teamId,
      },
    });
  } else {
    world = await createWorld();
  }

  // Store in the global cache so BaseCommand.finally() can find and close it.
  setWorld(world);
  return world;
};
