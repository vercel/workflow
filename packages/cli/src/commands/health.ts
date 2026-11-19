import { Flags } from '@oclif/core';
import { VERCEL_403_ERROR_MESSAGE } from '@workflow/errors';
import { setWorkflowBasePath, WORKFLOW_ROUTE_BASE } from '@workflow/utils';
import { getWorkflowPort } from '@workflow/utils/get-port';
import chalk from 'chalk';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { setupCliWorld } from '../lib/inspect/setup.js';

interface HealthCheckResult {
  healthy: boolean;
  error?: string;
  latencyMs?: number;
}

interface EndpointHealthResult {
  endpoint: 'workflow';
  healthy: boolean;
  error?: string;
  latencyMs?: number;
}

function formatHealthyResult(latencyMs: number): string {
  return (
    chalk.green('  ✓ workflow endpoint is healthy') +
    chalk.gray(` (${latencyMs}ms)`)
  );
}

function formatUnhealthyResult(error?: string): string {
  const errorSuffix = error ? chalk.gray(` - ${error}`) : '';
  return chalk.red('  ✗ workflow endpoint is unhealthy') + errorSuffix;
}

function printSummary(results: EndpointHealthResult[], backend: string): void {
  const allHealthy = results.every((r) => r.healthy);
  logger.log('');
  if (allHealthy) {
    logger.log(chalk.green('Workflow endpoint is healthy!'));
  } else {
    const unhealthyCount = results.filter((r) => !r.healthy).length;
    logger.log(chalk.red(`${unhealthyCount} workflow endpoint(s) unhealthy`));
    // Provide helpful hints for common issues
    if (backend === 'local' || backend === '@workflow/world-local') {
      logger.log('');
      logger.log(chalk.yellow('Hint: For local health checks, ensure:'));
      logger.log(chalk.yellow('  1. Your development server is running'));
      logger.log(
        chalk.yellow('  2. The server is accessible at the configured URL')
      );
    }
  }
}

function logPortDetectionDebug(
  explicitPort: number | undefined,
  detectedPort: number | undefined
): void {
  logger.debug(`Explicit port flag: ${explicitPort || '(not set)'}`);
  logger.debug(`PORT env: ${process.env.PORT || '(not set)'}`);
  logger.debug(
    `WORKFLOW_LOCAL_BASE_URL env: ${process.env.WORKFLOW_LOCAL_BASE_URL || '(not set)'}`
  );
  logger.debug(`Detected/resolved port: ${detectedPort || '(none)'}`);
}

// Default port for local development servers
const DEFAULT_LOCAL_PORT = 3000;

/**
 * Normalizes `--base-path` to a leading slash with no trailing slash
 * (`dashboard/` -> `/dashboard`), or `''` when unset.
 */
export function normalizeHealthBasePath(basePath: string | undefined): string {
  const trimmed = basePath?.trim() ?? '';
  if (trimmed.includes('://') || /[?#\\]/.test(trimmed)) {
    throw new Error(
      `Invalid --base-path ${JSON.stringify(basePath)}: expected a path such as "/dashboard".`
    );
  }
  const segments = trimmed.split('/').filter(Boolean);
  return segments.length === 0 ? '' : `/${segments.join('/')}`;
}

function appendBasePath(url: string, basePath: string): string {
  return basePath ? `${url.replace(/\/+$/, '')}${basePath}` : url;
}

function resolveLocalBaseUrl(
  explicitPort: number | undefined,
  detectedPort: number | undefined,
  basePath: string
): string {
  if (explicitPort) {
    return appendBasePath(`http://localhost:${explicitPort}`, basePath);
  }
  // Used as is: `run()` has already appended the base path to it.
  if (process.env.WORKFLOW_LOCAL_BASE_URL) {
    return process.env.WORKFLOW_LOCAL_BASE_URL;
  }
  if (process.env.PORT) {
    return appendBasePath(`http://localhost:${process.env.PORT}`, basePath);
  }
  if (detectedPort) {
    return appendBasePath(`http://localhost:${detectedPort}`, basePath);
  }
  // Fall back to default port 3000 (common for Next.js, Nuxt, etc.)
  return appendBasePath(`http://localhost:${DEFAULT_LOCAL_PORT}`, basePath);
}

async function testHttpHealthEndpoint(
  baseUrl: string,
  verbose: boolean,
  timeoutMs: number
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const healthUrl = `${baseUrl.replace(/\/+$/, '')}${WORKFLOW_ROUTE_BASE}/flow?__health`;
    if (verbose) {
      logger.debug(`Testing HTTP health at: ${healthUrl}`);
    }
    const response = await fetch(healthUrl, {
      method: 'POST',
      // A dev server answers its first request to the flow route only once
      // it compiled it, so the probe gets the whole `--timeout`.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      return { ok: true, status: response.status };
    }
    if (verbose) {
      logger.debug(`HTTP health check returned status: ${response.status}`);
    }
    return { ok: false, status: response.status };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (verbose) {
      logger.debug(`HTTP health check failed: ${errorMessage}`);
    }
    return { ok: false, error: errorMessage };
  }
}

/**
 * For local backend, verify the server is accessible before attempting health check.
 * Returns the base URL if accessible, or throws an error with a helpful message.
 */
export async function verifyLocalServerAccessible(
  verbose: boolean,
  explicitPort: number | undefined,
  timeoutMs: number,
  basePath = ''
): Promise<string> {
  const detectedPort =
    explicitPort ??
    (await getWorkflowPort({
      endpoint: `${basePath}${WORKFLOW_ROUTE_BASE}/flow?__health`,
    }));

  if (verbose) {
    logPortDetectionDebug(explicitPort, detectedPort);
  }

  const baseUrl = resolveLocalBaseUrl(explicitPort, detectedPort, basePath);

  if (verbose) {
    logger.debug(`Resolved base URL: ${baseUrl}`);
  }

  const result = await testHttpHealthEndpoint(baseUrl, verbose, timeoutMs);
  if (result.ok) {
    return baseUrl;
  }

  // The server is there but its workflow endpoint is not healthy: a port
  // hint would send the user looking in the wrong place.
  if (result.status !== undefined) {
    throw new Error(
      `The local server at ${baseUrl} answered the workflow health check with HTTP ${result.status}.`
    );
  }

  const portHint =
    baseUrl === `http://localhost:${DEFAULT_LOCAL_PORT}`
      ? 'If your server runs on a different port, use --port <port> or set WORKFLOW_LOCAL_BASE_URL'
      : `Hint: Use --port <port> or set WORKFLOW_LOCAL_BASE_URL=http://localhost:<port>`;
  throw new Error(
    `Cannot reach local server at ${baseUrl} (${result.error}). Make sure your development server is running.\n` +
      portHint
  );
}

/**
 * Points the Local World at the app's workflow routes for the queue-based
 * health check, which enqueues from this process.
 */
function configureLocalBaseUrl(
  port: number | undefined,
  basePath: string
): void {
  // If user specifies a port, set the env var so the World uses it
  if (port) {
    process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${port}`;
  }
  // Set default WORKFLOW_LOCAL_BASE_URL if not already set
  // We use WORKFLOW_LOCAL_BASE_URL instead of PORT to avoid conflicts
  // with other tools (like Next.js) that also use the PORT env var
  if (!process.env.WORKFLOW_LOCAL_BASE_URL && !process.env.PORT) {
    process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${DEFAULT_LOCAL_PORT}`;
  }
  // The Local World uses WORKFLOW_LOCAL_BASE_URL as is, so the base path
  // goes into it; a `PORT`-derived target picks it up from the global
  // base path instead. The queue-based check below enqueues from this
  // process, so both must match where the app serves its workflow routes.
  if (basePath && process.env.WORKFLOW_LOCAL_BASE_URL) {
    process.env.WORKFLOW_LOCAL_BASE_URL = appendBasePath(
      process.env.WORKFLOW_LOCAL_BASE_URL,
      basePath
    );
  }
  setWorkflowBasePath(basePath);
}

function isLocalBackend(backend: string): boolean {
  return backend === 'local' || backend === '@workflow/world-local';
}

function logWorldConfig(): void {
  logger.debug(
    `Data directory: ${process.env.WORKFLOW_LOCAL_DATA_DIR || '(not set)'}`
  );
  logger.debug(
    `Base URL: ${process.env.WORKFLOW_LOCAL_BASE_URL || '(not set)'}`
  );
  logger.debug(`PORT: ${process.env.PORT || '(not set)'}`);
}

async function runHealthCheckWithLogging(
  healthCheck: (
    world: any,
    options: { timeout: number }
  ) => Promise<HealthCheckResult>,
  world: any,
  timeout: number,
  verbose: boolean
): Promise<HealthCheckResult> {
  try {
    if (verbose) {
      logger.debug('Starting health check for workflow endpoint...');
    }
    const result = await healthCheck(world, { timeout });
    if (verbose) {
      logger.debug(
        `Workflow health check completed: ${JSON.stringify(result)}`
      );
    }
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (verbose) {
      logger.debug(`Workflow health check threw: ${errorMessage}`);
    }
    return {
      healthy: false,
      error: errorMessage || 'Unknown error during health check',
    };
  }
}

export default class Health extends BaseCommand {
  static description =
    'Check the workflow endpoint via a queue-based health check';

  static examples = [
    '$ workflow health',
    '$ workflow health --timeout 60000',
    '$ workflow health --base-path /dashboard',
    '$ workflow health --backend vercel --project my-project --team my-team',
  ];

  static flags = {
    timeout: Flags.integer({
      char: 't',
      description: 'Timeout in milliseconds for health check',
      default: 30000,
      helpGroup: 'Health Check',
      helpLabel: '-t, --timeout',
      helpValue: 'MS',
    }),
    port: Flags.integer({
      char: 'p',
      description: 'Local server port (for local backend)',
      required: false,
      helpGroup: 'Health Check',
      helpLabel: '-p, --port',
      helpValue: 'PORT',
    }),
    'base-path': Flags.string({
      description:
        'Path the workflow routes are served under (local backend), for example the Next.js basePath followed by workflows.experimentalRoutePrefix',
      required: false,
      helpGroup: 'Health Check',
      helpLabel: '--base-path',
      helpValue: 'PATH',
    }),
    // Include relevant flags from cliFlags (excluding ones not relevant to health check)
    verbose: cliFlags.verbose,
    json: cliFlags.json,
    backend: cliFlags.backend,
    authToken: cliFlags.authToken,
    project: cliFlags.project,
    team: cliFlags.team,
    env: cliFlags.env,
  } as const;

  async catch(error: any) {
    handleHealthCheckError(error);
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Health);

    // For local backend, set up port configuration early
    if (isLocalBackend(flags.backend)) {
      const basePath = normalizeHealthBasePath(flags['base-path']);
      configureLocalBaseUrl(flags.port, basePath);

      // Verify the server is accessible before proceeding
      const accessible = await this.verifyLocalServer(
        flags.json,
        flags.verbose,
        flags.port,
        flags.timeout,
        basePath
      );
      if (!accessible) {
        process.exit(1);
      }
    }

    const world = await setupCliWorld(flags, this.config.version);
    if (!world) {
      throw new Error(
        'Failed to connect to backend. Check your configuration.'
      );
    }

    const { healthCheck } = await import('@workflow/core/runtime');

    if (!flags.json) {
      const backendName =
        flags.backend === 'local' ? 'local server' : flags.backend;
      logger.log(
        chalk.gray(`Running queue-based health check against ${backendName}...`)
      );
      logger.log('');
    }

    const result = await this.checkEndpoint(healthCheck, world, {
      timeout: flags.timeout,
      json: flags.json,
      verbose: flags.verbose,
    });

    this.outputResults([result], flags.json, flags.backend);

    process.exit(result.healthy ? 0 : 1);
  }

  private async verifyLocalServer(
    jsonMode: boolean,
    verbose: boolean,
    port: number | undefined,
    timeoutMs: number,
    basePath: string
  ): Promise<boolean> {
    if (!jsonMode) {
      logger.log(chalk.gray('Checking local server accessibility...'));
    }
    try {
      const baseUrl = await verifyLocalServerAccessible(
        verbose,
        port,
        timeoutMs,
        basePath
      );
      if (!jsonMode) {
        logger.log(chalk.green(`  ✓ Local server accessible at ${baseUrl}`));
        logger.log('');
      }
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (jsonMode) {
        console.log(
          JSON.stringify({
            results: [],
            allHealthy: false,
            error: errorMessage,
          })
        );
      } else {
        logger.error(errorMessage);
      }
      return false;
    }
  }

  private async checkEndpoint(
    healthCheck: (
      world: any,
      options: { timeout: number }
    ) => Promise<HealthCheckResult>,
    world: any,
    flags: { timeout: number; json: boolean; verbose: boolean }
  ): Promise<EndpointHealthResult> {
    if (flags.verbose) {
      logWorldConfig();
    }

    if (!flags.json) {
      logger.log('Checking workflow endpoint...');
    }

    const result = await runHealthCheckWithLogging(
      healthCheck,
      world,
      flags.timeout,
      flags.verbose
    );

    if (!flags.json) {
      const message = result.healthy
        ? formatHealthyResult(result.latencyMs ?? 0)
        : formatUnhealthyResult(result.error);
      logger.log(message);
    }

    return {
      endpoint: 'workflow',
      healthy: result.healthy,
      error: result.error,
      latencyMs: result.latencyMs,
    };
  }

  private outputResults(
    results: EndpointHealthResult[],
    jsonMode: boolean,
    backend: string
  ): void {
    if (jsonMode) {
      const jsonOutput = {
        results,
        allHealthy: results.every((r) => r.healthy),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
    } else {
      printSummary(results, backend);
    }
  }
}

function handleHealthCheckError(error: any): never {
  if (error?.status === 403) {
    logger.error(VERCEL_403_ERROR_MESSAGE);
  } else if (LOGGING_CONFIG.VERBOSE_MODE) {
    logger.error(error);
  } else {
    const errorMessage = error?.message || String(error) || 'Unknown error';
    logger.error(`Error: ${errorMessage}`);
  }
  process.exit(1);
}
