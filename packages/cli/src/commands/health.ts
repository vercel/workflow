import { Flags } from '@oclif/core';
import { VERCEL_403_ERROR_MESSAGE } from '@workflow/errors';
import { getWorkflowPort } from '@workflow/utils/get-port';
import chalk from 'chalk';
import { BaseCommand } from '../base.js';
import { LOGGING_CONFIG, logger } from '../lib/config/log.js';
import { cliFlags } from '../lib/inspect/flags.js';
import { setupCliWorld } from '../lib/inspect/setup.js';

type HealthCheckEndpoint = 'workflow' | 'step';

interface HealthCheckResult {
  healthy: boolean;
  error?: string;
  latencyMs?: number;
}

interface EndpointHealthResult {
  endpoint: HealthCheckEndpoint;
  healthy: boolean;
  error?: string;
  latencyMs?: number;
}

function formatHealthyResult(endpoint: string, latencyMs: number): string {
  return (
    chalk.green(`  ✓ ${endpoint} endpoint is healthy`) +
    chalk.gray(` (${latencyMs}ms)`)
  );
}

function formatUnhealthyResult(endpoint: string, error?: string): string {
  const errorSuffix = error ? chalk.gray(` - ${error}`) : '';
  return chalk.red(`  ✗ ${endpoint} endpoint is unhealthy`) + errorSuffix;
}

function getEndpointsToCheck(endpointFlag: string): HealthCheckEndpoint[] {
  return endpointFlag === 'both'
    ? ['workflow', 'step']
    : [endpointFlag as HealthCheckEndpoint];
}

function printSummary(results: EndpointHealthResult[], backend: string): void {
  const allHealthy = results.every((r) => r.healthy);
  logger.log('');
  if (allHealthy) {
    logger.log(chalk.green('All endpoints are healthy!'));
  } else {
    const unhealthyCount = results.filter((r) => !r.healthy).length;
    logger.log(
      chalk.red(`${unhealthyCount} of ${results.length} endpoint(s) unhealthy`)
    );
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

function resolveLocalBaseUrl(
  explicitPort: number | undefined,
  detectedPort: number | undefined
): string {
  if (explicitPort) {
    return `http://localhost:${explicitPort}`;
  }
  if (process.env.WORKFLOW_LOCAL_BASE_URL) {
    return process.env.WORKFLOW_LOCAL_BASE_URL;
  }
  if (process.env.PORT) {
    return `http://localhost:${process.env.PORT}`;
  }
  if (detectedPort) {
    return `http://localhost:${detectedPort}`;
  }
  // Fall back to default port 3000 (common for Next.js, Nuxt, etc.)
  return `http://localhost:${DEFAULT_LOCAL_PORT}`;
}

async function testHttpHealthEndpoint(
  baseUrl: string,
  endpoint: 'flow' | 'step',
  verbose: boolean
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const healthUrl = `${baseUrl}/.well-known/workflow/v1/${endpoint}?__health`;
    if (verbose) {
      logger.debug(`Testing HTTP health at: ${healthUrl}`);
    }
    const response = await fetch(healthUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
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
async function verifyLocalServerAccessible(
  verbose: boolean,
  explicitPort?: number
): Promise<string> {
  const detectedPort = explicitPort ?? (await getWorkflowPort());

  if (verbose) {
    logPortDetectionDebug(explicitPort, detectedPort);
  }

  const baseUrl = resolveLocalBaseUrl(explicitPort, detectedPort);

  if (verbose) {
    logger.debug(`Resolved base URL: ${baseUrl}`);
  }

  const result = await testHttpHealthEndpoint(baseUrl, 'flow', verbose);
  if (result.ok) {
    return baseUrl;
  }

  const portHint =
    baseUrl === `http://localhost:${DEFAULT_LOCAL_PORT}`
      ? 'If your server runs on a different port, use --port <port> or set WORKFLOW_LOCAL_BASE_URL'
      : `Hint: Use --port <port> or set WORKFLOW_LOCAL_BASE_URL=http://localhost:<port>`;
  throw new Error(
    `Cannot reach local server at ${baseUrl}. Make sure your development server is running.\n` +
      portHint
  );
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
    endpoint: HealthCheckEndpoint,
    options: { timeout: number }
  ) => Promise<HealthCheckResult>,
  world: any,
  endpoint: HealthCheckEndpoint,
  timeout: number,
  verbose: boolean
): Promise<HealthCheckResult> {
  try {
    if (verbose) {
      logger.debug(`Starting health check for ${endpoint}...`);
    }
    const result = await healthCheck(world, endpoint, { timeout });
    if (verbose) {
      logger.debug(
        `Health check for ${endpoint} completed: ${JSON.stringify(result)}`
      );
    }
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (verbose) {
      logger.debug(`Health check for ${endpoint} threw: ${errorMessage}`);
    }
    return {
      healthy: false,
      error: errorMessage || 'Unknown error during health check',
    };
  }
}

export default class Health extends BaseCommand {
  static description =
    'Check health of workflow and step endpoints via queue-based health check';

  static examples = [
    '$ workflow health',
    '$ workflow health --endpoint workflow',
    '$ workflow health --endpoint step --timeout 60000',
    '$ workflow health --backend vercel --project my-project --team my-team',
  ];

  static flags = {
    endpoint: Flags.string({
      char: 'e',
      description: 'Which endpoint(s) to check',
      options: ['workflow', 'step', 'both'],
      default: 'both',
      helpGroup: 'Health Check',
      helpLabel: '-e, --endpoint',
      helpValue: ['workflow', 'step', 'both'],
    }),
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
      // If user specifies a port, set the env var so the World uses it
      if (flags.port) {
        process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${flags.port}`;
      }
      // Set default WORKFLOW_LOCAL_BASE_URL if not already set
      // We use WORKFLOW_LOCAL_BASE_URL instead of PORT to avoid conflicts
      // with other tools (like Next.js) that also use the PORT env var
      if (!process.env.WORKFLOW_LOCAL_BASE_URL && !process.env.PORT) {
        process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${DEFAULT_LOCAL_PORT}`;
      }

      // Verify the server is accessible before proceeding
      const accessible = await this.verifyLocalServer(
        flags.json,
        flags.verbose,
        flags.port
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
    const endpoints = getEndpointsToCheck(flags.endpoint);

    if (!flags.json) {
      const backendName =
        flags.backend === 'local' ? 'local server' : flags.backend;
      logger.log(
        chalk.gray(`Running queue-based health check against ${backendName}...`)
      );
      logger.log('');
    }

    const results = await this.checkEndpoints(endpoints, healthCheck, world, {
      timeout: flags.timeout,
      json: flags.json,
      verbose: flags.verbose,
    });

    this.outputResults(results, flags.json, flags.backend);

    const allHealthy = results.every((r) => r.healthy);
    process.exit(allHealthy ? 0 : 1);
  }

  private async verifyLocalServer(
    jsonMode: boolean,
    verbose: boolean,
    port?: number
  ): Promise<boolean> {
    if (!jsonMode) {
      logger.log(chalk.gray('Checking local server accessibility...'));
    }
    try {
      const baseUrl = await verifyLocalServerAccessible(verbose, port);
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

  private async checkEndpoints(
    endpoints: HealthCheckEndpoint[],
    healthCheck: (
      world: any,
      endpoint: HealthCheckEndpoint,
      options: { timeout: number }
    ) => Promise<HealthCheckResult>,
    world: any,
    flags: { timeout: number; json: boolean; verbose: boolean }
  ): Promise<EndpointHealthResult[]> {
    if (flags.verbose) {
      logWorldConfig();
    }

    const results: EndpointHealthResult[] = [];
    for (const endpoint of endpoints) {
      const result = await this.checkSingleEndpoint(
        endpoint,
        healthCheck,
        world,
        flags
      );
      results.push(result);
    }
    return results;
  }

  private async checkSingleEndpoint(
    endpoint: HealthCheckEndpoint,
    healthCheck: (
      world: any,
      endpoint: HealthCheckEndpoint,
      options: { timeout: number }
    ) => Promise<HealthCheckResult>,
    world: any,
    flags: { timeout: number; json: boolean; verbose: boolean }
  ): Promise<EndpointHealthResult> {
    if (!flags.json) {
      logger.log(`Checking ${endpoint} endpoint...`);
    }

    const result = await runHealthCheckWithLogging(
      healthCheck,
      world,
      endpoint,
      flags.timeout,
      flags.verbose
    );

    if (!flags.json) {
      const message = result.healthy
        ? formatHealthyResult(endpoint, result.latencyMs ?? 0)
        : formatUnhealthyResult(endpoint, result.error);
      logger.log(message);
    }

    return {
      endpoint,
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
