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
}

interface EndpointHealthResult {
  endpoint: HealthCheckEndpoint;
  healthy: boolean;
  error?: string;
  latencyMs: number;
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

/**
 * For local backend, verify the server is accessible before attempting health check.
 * Returns the base URL if accessible, or throws an error with a helpful message.
 */
async function verifyLocalServerAccessible(): Promise<string> {
  // First, try to detect the port
  const port =
    process.env.PORT || process.env.WORKFLOW_LOCAL_BASE_URL
      ? undefined
      : await getWorkflowPort();

  // Determine base URL
  let baseUrl: string;
  if (process.env.WORKFLOW_LOCAL_BASE_URL) {
    baseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  } else if (port) {
    baseUrl = `http://localhost:${port}`;
  } else if (process.env.PORT) {
    baseUrl = `http://localhost:${process.env.PORT}`;
  } else {
    throw new Error(
      'No local server detected. Make sure your development server is running.'
    );
  }

  // Try to reach the health check endpoint
  try {
    const healthUrl = `${baseUrl}/.well-known/workflow/v1/flow?__health`;
    const response = await fetch(healthUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return baseUrl;
    }
  } catch {
    // Server not reachable
  }

  throw new Error(
    `Cannot reach local server at ${baseUrl}. Make sure your development server is running.`
  );
}

function isLocalBackend(backend: string): boolean {
  return backend === 'local' || backend === '@workflow/world-local';
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

    // For local backend, first verify the server is accessible
    if (isLocalBackend(flags.backend)) {
      const accessible = await this.verifyLocalServer(flags.json);
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

    const results = await this.checkEndpoints(
      endpoints,
      healthCheck,
      world,
      flags
    );

    this.outputResults(results, flags.json, flags.backend);

    const allHealthy = results.every((r) => r.healthy);
    process.exit(allHealthy ? 0 : 1);
  }

  private async verifyLocalServer(jsonMode: boolean): Promise<boolean> {
    if (!jsonMode) {
      logger.log(chalk.gray('Checking local server accessibility...'));
    }
    try {
      const baseUrl = await verifyLocalServerAccessible();
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
    flags: { timeout: number; json: boolean }
  ): Promise<EndpointHealthResult[]> {
    const results: EndpointHealthResult[] = [];

    for (const endpoint of endpoints) {
      const startTime = Date.now();

      if (!flags.json) {
        logger.log(`Checking ${endpoint} endpoint...`);
      }

      let result: HealthCheckResult;
      try {
        result = await healthCheck(world, endpoint, {
          timeout: flags.timeout,
        });
      } catch (error) {
        // Catch any unhandled errors from healthCheck
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        result = {
          healthy: false,
          error: errorMessage || 'Unknown error during health check',
        };
      }

      const latencyMs = Date.now() - startTime;
      results.push({
        endpoint,
        healthy: result.healthy,
        error: result.error,
        latencyMs,
      });

      if (!flags.json) {
        const message = result.healthy
          ? formatHealthyResult(endpoint, latencyMs)
          : formatUnhealthyResult(endpoint, result.error);
        logger.log(message);
      }
    }

    return results;
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
