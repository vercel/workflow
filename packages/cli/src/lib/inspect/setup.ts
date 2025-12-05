import { createWorld } from '@workflow/core/runtime';
import chalk from 'chalk';
import terminalLink from 'terminal-link';
import { logger, setJsonMode, setVerboseMode } from '../config/log.js';
import {
  inferLocalWorldEnvVars,
  inferVercelEnvVars,
  writeEnvVars,
} from './env.js';

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
  version: string
) => {
  setJsonMode(Boolean(flags.json));
  setVerboseMode(Boolean(flags.verbose));

  const withAnsiLinks = flags.json ? false : true;
  const docsUrl = withAnsiLinks
    ? terminalLink('https://useworkflow.dev/', 'https://useworkflow.dev/')
    : 'https://useworkflow.dev/';

  logger.showBox(
    'green',
    `        Workflow CLI v${version}        `,
    `        Docs at ${docsUrl}          `,
    chalk.yellow('This is a beta release - commands might change')
  );

  logger.debug('Inferring env vars, backend:', flags.backend);
  writeEnvVars({
    DEBUG: flags.verbose ? '1' : '',
    WORKFLOW_TARGET_WORLD: flags.backend,
    WORKFLOW_VERCEL_ENV: flags.env,
    WORKFLOW_VERCEL_AUTH_TOKEN: flags.authToken,
    WORKFLOW_VERCEL_PROJECT: flags.project,
    WORKFLOW_VERCEL_TEAM: flags.team,
    WORKFLOW_VERCEL_PROXY_URL: 'https://api.vercel.com/v1/workflow',
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
    await inferLocalWorldEnvVars();
  }

  logger.debug('Initializing world');
  return createWorld();
};
