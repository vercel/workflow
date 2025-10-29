import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import open from 'open';
import { logger } from '../config/log.js';
import { getEnvVars } from './env.js';
import { getVercelDashboardUrl } from './vercel-api.js';

export const WEB_PORT = 3456;
export const WEB_PACKAGE_NAME = '@workflow/web';
export const HOST_URL = `http://localhost:${WEB_PORT}`;

let serverProcess: ChildProcess | null = null;
let isServerStarting = false;
let cleanupHandlersRegistered = false;

/**
 * Get the path to the @workflow/web package
 * Since it's now a direct dependency, we can resolve it from node_modules
 *
 * We resolve relative to this file's location to handle cases where the CLI
 * is installed as a dependency of another project:
 *   test-project/node_modules/@workflow/cli/node_modules/@workflow/web
 */
function getWebPackagePath(): string {
  try {
    // Get the path to this file so we can resolve relative to the CLI package
    const thisFilePath = fileURLToPath(import.meta.url);

    logger.debug(`Resolving web package from: ${thisFilePath}`);

    // Create a require function that resolves relative to this file
    // This is the proper way to resolve dependencies of the CLI package
    const requireFromHere = createRequire(import.meta.url);

    // Resolve the package.json of @workflow/web from the CLI's location
    // This ensures we find it even when the CLI is a dependency of another project
    const packageJsonPath = requireFromHere.resolve(
      `${WEB_PACKAGE_NAME}/package.json`
    );

    logger.debug(`Resolved web package: ${packageJsonPath}`);

    // Return the directory containing package.json
    return dirname(packageJsonPath);
  } catch (error) {
    throw new Error(
      `Failed to resolve ${WEB_PACKAGE_NAME} package. ` +
        `This should be installed as a dependency of the CLI. Error: ${error}`
    );
  }
}

/**
 * Check if server is already running on the port
 */
async function isServerRunning(hostUrl: string): Promise<boolean> {
  try {
    const response = await fetch(hostUrl, {
      method: 'HEAD',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Cleanup function to stop the server gracefully
 */
function cleanupServer(): void {
  if (serverProcess && !serverProcess.killed) {
    logger.debug('Cleaning up web server process...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

/**
 * Register cleanup handlers to ensure server is stopped when CLI exits
 */
function registerCleanupHandlers(): void {
  if (cleanupHandlersRegistered) {
    return;
  }

  cleanupHandlersRegistered = true;

  // Handle Ctrl+C (SIGINT)
  process.on('SIGINT', () => {
    logger.debug('Received SIGINT, cleaning up...');
    cleanupServer();
    process.exit(0);
  });

  // Handle termination signal
  process.on('SIGTERM', () => {
    logger.debug('Received SIGTERM, cleaning up...');
    cleanupServer();
    process.exit(0);
  });

  // Handle normal process exit
  process.on('exit', () => {
    cleanupServer();
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error}`);
    cleanupServer();
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
    cleanupServer();
    process.exit(1);
  });
}

/**
 * Start the web server without detaching
 * The server will stay attached to the CLI process and be cleaned up on exit
 */
async function startWebServer(): Promise<boolean> {
  if (isServerStarting) {
    logger.debug('Server is already starting...');
    return false;
  }

  if (await isServerRunning(HOST_URL)) {
    logger.debug('Server is already running');
    return true;
  }

  const packagePath = getWebPackagePath();
  logger.debug(`Using web package at: ${packagePath}`);

  isServerStarting = true;

  try {
    logger.info('Starting web UI server...');
    const command = 'npx';
    const args = ['next', 'start', '-p', String(WEB_PORT)];
    logger.debug(`Running ${command} ${args.join(' ')} in ${packagePath}`);

    // Start the Next.js server WITHOUT detaching
    // This keeps it attached to the CLI process
    serverProcess = spawn(command, args, {
      cwd: packagePath,
      detached: false, // Keep attached so Ctrl+C works
      stdio: ['ignore', 'pipe', 'pipe'], // Pipe output so we can log it if needed
    });

    // Register cleanup handlers to ensure server is killed on exit
    registerCleanupHandlers();

    // Log server output for debugging
    if (serverProcess.stdout) {
      serverProcess.stdout.on('data', (data) => {
        logger.debug(`[web-server] ${data.toString().trim()}`);
      });
    }

    if (serverProcess.stderr) {
      serverProcess.stderr.on('data', (data) => {
        logger.debug(`[web-server] ${data.toString().trim()}`);
      });
    }

    // Handle server process errors
    serverProcess.on('error', (error) => {
      logger.error(`Web server process error: ${error}`);
      cleanupServer();
    });

    // Handle server process exit
    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        logger.debug(`Web server exited with code ${code}`);
      } else if (signal) {
        logger.debug(`Web server exited with signal ${signal}`);
      }
      serverProcess = null;
    });

    // Wait for server to be ready
    const maxRetries = 30;
    const retryIntervalMs = 1000;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      if (await isServerRunning(HOST_URL)) {
        logger.success(
          chalk.green(`Web UI server started on port ${WEB_PORT}`)
        );
        isServerStarting = false;
        return true;
      }
    }

    logger.error(
      `Server failed to start within ${maxRetries * retryIntervalMs}ms`
    );
    cleanupServer();
    isServerStarting = false;
    return false;
  } catch (error) {
    logger.error(`Failed to start server: ${error}`);
    cleanupServer();
    isServerStarting = false;
    return false;
  }
}

/**
 * Launch the web UI with the specified configuration
 * This starts the server (if not running), opens the browser, then keeps the server running
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
  const projectName = envVars.WORKFLOW_VERCEL_PROJECT;

  if (!envVars.WORKFLOW_LOCAL_UI && isVercelBackend) {
    logger.info(
      'If you do not want to use the Vercel dashboard, set WORKFLOW_LOCAL_UI=1 in your environment variables.'
    );
  }
  if (
    isVercelBackend &&
    teamSlug &&
    projectName &&
    !envVars.WORKFLOW_LOCAL_UI
  ) {
    logger.debug(
      `Checking Vercel dashboard availability for team: ${teamSlug}, project: ${projectName}`
    );

    // const dashboardAvailable = await checkVercelDashboardAvailable(
    //   teamSlug,
    //   projectName,
    //   envVars.WORKFLOW_VERCEL_AUTH_TOKEN
    // );

    // if (dashboardAvailable) {
    const dashboardUrl = getVercelDashboardUrl(
      teamSlug,
      projectName,
      resource,
      id
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
    // } else {
    //   logger.warn(
    //     chalk.yellow(
    //       'Vercel dashboard is not available for this project. Falling back to local web UI.'
    //     )
    //   );
    // }
  }

  // Fall back to local web UI
  // Build URL with query params
  const queryParams = envToQueryParams(resource, id, flags, envVars);
  const url = `${HOST_URL}?${queryParams.toString()}`;

  // Check if server is already running
  const alreadyRunning = await isServerRunning(HOST_URL);

  if (alreadyRunning) {
    logger.info(chalk.cyan('Web UI server is already running'));
    logger.info(chalk.cyan(`Access at: ${HOST_URL}`));
  } else {
    // Start the server
    const started = await startWebServer();
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
  if (!alreadyRunning && serverProcess) {
    logger.info(chalk.cyan('Press Ctrl+C to stop the web UI server and exit'));

    // Keep the CLI process alive to maintain the server
    // The server will be cleaned up when the process exits
    await new Promise((resolve) => {
      // This will only resolve when the server exits, or immediately if there is no serverProcess
      if (serverProcess) {
        serverProcess.on('exit', resolve);
      } else {
        resolve(null);
      }
    });
  }
}

/**
 * Convert CLI flags to query parameters
 */
function envToQueryParams(
  resource: string,
  id: string | undefined,
  flags: Record<string, any>,
  envVars: Record<string, string>
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('resource', resource);
  if (id) {
    params.set('id', id);
  }

  // Map relevant flags to query params
  const envToQueryParamMappings: Record<string, string> = {
    WORKFLOW_TARGET_WORLD: 'backend',
    WORKFLOW_VERCEL_ENV: 'env',
    WORKFLOW_VERCEL_AUTH_TOKEN: 'authToken',
    WORKFLOW_VERCEL_PROJECT: 'project',
    WORKFLOW_VERCEL_TEAM: 'team',
    PORT: 'port',
    WORKFLOW_EMBEDDED_DATA_DIR: 'dataDir',
  };

  for (const [envName, paramName] of Object.entries(envToQueryParamMappings)) {
    const value = envVars[envName];
    if (value !== undefined && value !== '' && value !== '0') {
      params.set(paramName, String(value));
    }
  }
  // We only take the runId/stepId/hookId flags directly, the rest are set via env vars,
  // which are internally already influenced by the CLI flags
  for (const flagName of ['runId', 'stepId', 'hookId'] as const) {
    const value = flags[flagName];
    if (value !== undefined && value !== '' && value !== false) {
      params.set(flagName, String(value));
    }
  }

  return params;
}
