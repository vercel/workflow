import type { Server } from 'node:http';
import chalk from 'chalk';
import open from 'open';
import { logger } from '../config/log.js';
import { getEnvVars } from './env.js';
import { setupCliWorld } from './setup.js';
import { getVercelDashboardUrl } from './vercel-api.js';

export const getHostUrl = (webPort: number) => `http://localhost:${webPort}`;

let httpServer: Server | null = null;

/**
 * Check if a server is already listening on the given URL.
 */
async function isServerRunning(hostUrl: string): Promise<boolean> {
  try {
    const response = await fetch(hostUrl, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start the @workflow/web server in the current process.
 */
async function startWebServer(webPort: number): Promise<boolean> {
  if (await isServerRunning(getHostUrl(webPort))) {
    logger.debug('Server is already running');
    return true;
  }

  try {
    logger.info('Starting web UI server...');
    const { startServer } = await import('@workflow/web/server');
    httpServer = await startServer(webPort);
    logger.success(chalk.green(`Web UI server started on port ${webPort}`));
    return true;
  } catch (error) {
    logger.error(`Failed to start server: ${error}`);
    return false;
  }
}

/**
 * Build a URL for opening the local web UI.
 *
 * The web UI reads world configuration from server-side environment variables.
 * Query params are only used for deep-linking to specific resources (resource/id, runId, etc.)
 */
export function buildWebUIUrl(
  hostUrl: string,
  resource: string,
  id: string | undefined,
  flags: Record<string, any>
): string {
  const params = new URLSearchParams();

  // Deep-linking params
  params.set('resource', resource);
  if (id) {
    params.set('id', id);
  }

  // Optional deep-linking to specific run/step/hook
  for (const flagName of ['runId', 'stepId', 'hookId'] as const) {
    const value = flags[flagName];
    if (value !== undefined && value !== '' && value !== false) {
      params.set(flagName, String(value));
    }
  }

  const queryString = params.toString();
  return queryString ? `${hostUrl}?${queryString}` : hostUrl;
}

/**
 * Launch the web UI with the specified configuration.
 * This starts the server (if not running), opens the browser, then keeps the server running.
 *
 * World configuration is passed to the web server via environment variables.
 * The web UI reads these from process.env on the server side, not from query params.
 */
export async function launchWebUI(
  resource: string,
  id: string | undefined,
  flags: Record<string, any>,
  _cliVersion: string
): Promise<void> {
  const envVars = getEnvVars();

  // Check if browser opening is disabled via flag or environment variable
  const disableBrowserOpen = flags.noBrowser;

  // Check if we should try to use the Vercel dashboard
  const vercelBackendNames = ['vercel', '@workflow/world-vercel'];
  const isVercelBackend = vercelBackendNames.includes(
    envVars.WORKFLOW_TARGET_WORLD
  );
  const teamSlug = envVars.WORKFLOW_VERCEL_TEAM;
  const projectName =
    envVars.WORKFLOW_VERCEL_PROJECT_NAME || envVars.WORKFLOW_VERCEL_PROJECT;

  // Check if user wants local UI via flag or environment variable
  const useLocalUi = flags.localUi;

  if (!useLocalUi && isVercelBackend) {
    logger.info(
      'If you do not want to use the Vercel dashboard, use the --localUi flag or set WORKFLOW_LOCAL_UI=1 in your environment variables.'
    );
  }
  if (isVercelBackend && teamSlug && projectName && !useLocalUi) {
    logger.debug(
      `Checking Vercel dashboard availability for team: ${teamSlug}, project: ${projectName}`
    );

    const dashboardUrl = getVercelDashboardUrl(
      teamSlug,
      projectName,
      resource,
      id,
      envVars.WORKFLOW_VERCEL_ENV || 'production'
    );

    if (disableBrowserOpen) {
      logger.info(chalk.cyan(`Vercel dashboard URL: ${dashboardUrl}`));
      logger.info(chalk.cyan('(Browser auto-open disabled)'));
      return;
    }

    logger.info(
      chalk.green(`Opening Vercel dashboard for workflows at: ${dashboardUrl}`)
    );
    try {
      await open(dashboardUrl);
      return; // Exit early since we opened the dashboard
    } catch (error) {
      logger.error(`Failed to open browser: ${error}`);
      logger.info(`Please open the link manually.`);
      return;
    }
  }

  // Fall back to local web UI
  const webPort = flags.webPort ?? 3456;
  const hostUrl = getHostUrl(webPort);
  const url = buildWebUIUrl(hostUrl, resource, id, flags);

  // Check if server is already running
  const alreadyRunning = await isServerRunning(hostUrl);

  if (alreadyRunning) {
    logger.info(
      chalk.cyan(`Web UI server is already running on port ${webPort}.`)
    );
  } else {
    // Start the server
    const started = await startWebServer(webPort);
    if (!started) {
      logger.error('Failed to start web UI server');
      return;
    }
  }

  // Open browser
  if (disableBrowserOpen) {
    logger.info(chalk.cyan(`Web UI available at: ${url}`));
    logger.info(chalk.cyan('(Browser auto-open disabled)'));
  } else {
    logger.info(chalk.cyan(`Opening browser to: ${url}`));
    try {
      await open(url);
    } catch (error) {
      logger.error(`Failed to open browser: ${error}`);
      logger.info(`Please open the link manually.`);
    }
  }

  // If we started the server, keep the process running
  if (!alreadyRunning && httpServer) {
    logger.info(chalk.cyan('Press Ctrl+C to stop the web UI server and exit'));

    // Keep the CLI process alive while the server is running
    await new Promise<void>((resolve) => {
      if (httpServer) {
        httpServer.on('close', () => resolve());
      } else {
        resolve();
      }
    });
  }
}

/**
 * Build the deep-link URL for a resource without any side effects (no server,
 * no browser). Picks the Vercel dashboard for a Vercel backend (unless
 * `--localUi`), otherwise the local web UI deep link.
 *
 * Assumes env vars have already been resolved (e.g. via `setupCliWorld`).
 */
export function buildDeepLinkUrl(
  resource: string,
  id: string | undefined,
  flags: Record<string, any>
): string {
  const envVars = getEnvVars();

  const vercelBackendNames = ['vercel', '@workflow/world-vercel'];
  const isVercelBackend = vercelBackendNames.includes(
    envVars.WORKFLOW_TARGET_WORLD
  );
  const teamSlug = envVars.WORKFLOW_VERCEL_TEAM;
  const projectName =
    envVars.WORKFLOW_VERCEL_PROJECT_NAME || envVars.WORKFLOW_VERCEL_PROJECT;

  // Use the Vercel dashboard when targeting Vercel (and not forced local).
  if (isVercelBackend && !flags.localUi && teamSlug && projectName) {
    return getVercelDashboardUrl(
      teamSlug,
      projectName,
      resource,
      id,
      envVars.WORKFLOW_VERCEL_ENV || 'production'
    );
  }

  // Fall back to the local web UI deep link.
  const webPort = flags.webPort ?? 3456;
  return buildWebUIUrl(getHostUrl(webPort), resource, id, flags);
}

/**
 * Resolve and print a shareable deep-link URL to stdout, then return — without
 * opening a browser or starting the local web server. Intended for scripting
 * and agents that need the link rather than a rendered dashboard.
 *
 * Human-readable chatter (the startup box, info/debug logs) is routed to stderr
 * so stdout contains only the URL (or `{ "url": "..." }` with `--json`).
 */
export async function printDeepLink(
  resource: string,
  id: string | undefined,
  flags: Record<string, any>,
  version: string
): Promise<void> {
  const wantsJson = Boolean(flags.json);

  // Force JSON logging mode during setup so the startup box and any info/debug
  // logs go to stderr, keeping stdout clean for the URL. We print the URL
  // ourselves below, respecting the user's actual `--json` choice.
  await setupCliWorld({ ...flags, json: true } as any, version, true);

  const url = buildDeepLinkUrl(resource, id, flags);

  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({ url }, null, 2)}\n`);
  } else {
    process.stdout.write(`${url}\n`);
  }
}
