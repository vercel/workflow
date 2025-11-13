import { createFunctionProxy } from '../proxies/function-proxy.js';
import { createHttpProxy } from '../proxies/http-proxy.js';
import { createPgBossQueue } from './pgboss.js';
import type { QueueDriver } from './types.js';

/**
 * QueueDriver implementation using pg-boss for job management
 * and direct function calls for execution.
 */
export function createPgBossFunctionProxy(opts: {
  jobPrefix?: string;
  securityToken: string;
  connectionString: string;
  queueConcurrency?: number;
  stepEntrypoint: (request: Request) => Promise<Response>;
  workflowEntrypoint: (request: Request) => Promise<Response>;
}): QueueDriver {
  return createPgBossQueue(
    {
      jobPrefix: opts.jobPrefix,
      connectionString: opts.connectionString,
      queueConcurrency: opts.queueConcurrency,
    },
    createFunctionProxy({
      securityToken: opts.securityToken,
      stepEntrypoint: opts.stepEntrypoint,
      workflowEntrypoint: opts.workflowEntrypoint,
    })
  );
}

/**
 * QueueDriver implementation using pg-boss for job management
 * and HTTP for execution.
 */
export function createPgBossHttpProxy(config: {
  port?: number;
  baseUrl?: string;
  jobPrefix?: string;
  securityToken: string;
  connectionString: string;
  queueConcurrency?: number;
}): QueueDriver {
  return createPgBossQueue(
    {
      jobPrefix: config.jobPrefix,
      connectionString: config.connectionString,
      queueConcurrency: config.queueConcurrency,
    },
    createHttpProxy({
      port: config.port,
      baseUrl: config.baseUrl,
      securityToken: config.securityToken,
    })
  );
}
