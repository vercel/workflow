import { createWorld } from '@workflow/core/runtime';
import chalk from 'chalk';
import terminalLink from 'terminal-link';
import { logger, setJsonMode, setVerboseMode } from '../config/log.js';
import { checkForUpdateCached } from '../update-check.js';
import {
  inferLocalWorldEnvVars,
  inferVercelEnvVars,
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
): Promise<Awaited<ReturnType<typeof createWorld>> | null> => {
  setJsonMode(Boolean(flags.json));
  setVerboseMode(Boolean(flags.verbose));

  // Check for updates
  const updateCheck = await checkForUpdateCached(version);

  const withAnsiLinks = flags.json ? false : true;
  const docsUrl = withAnsiLinks
    ? terminalLink('https://useworkflow.dev/', 'https://useworkflow.dev/')
    : 'https://useworkflow.dev/';

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
    WORKFLOW_VERCEL_ENV: flags.env,
    WORKFLOW_VERCEL_AUTH_TOKEN: flags.authToken,
    WORKFLOW_VERCEL_PROJECT: flags.project,
    WORKFLOW_VERCEL_TEAM: flags.team,
  });

  if (
    flags.backend === 'vercel' ||
    flags.backend === '@workflow/world-vercel'
  ) {
    await inferVercelEnvVars();
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
  const world = await createWorld();
  return world;
};
